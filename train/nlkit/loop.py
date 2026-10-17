#!/usr/bin/env python3
# ============================================================
# nlkit/loop.py · 零 token 自动迭代闭环（进化式搜索 + 诚实采纳）
# ------------------------------------------------------------
# 用户要求「迭代自动进行不消耗 token」。本模块就是那个闭环：
# 它是一个纯 Python 进程，循环里没有任何 LLM 调用，每一轮迭代的成本是本地 CPU 时间。
#
# 一轮（generation）做五件事：
#   1. 组种群：上一代存活者 + 变异子代 + 全新随机个体（保证不早熟收敛）
#   2. 逐个跑 Purged Walk-Forward：训练非线性模型 → 拿 OOS 预测
#   3. 双口径评分：横截面 IC（选币能力） + 净成本 PnL（能不能赚钱）
#   4. 记进 ledger.jsonl（append-only，含配置哈希，可完整复现）
#   5. 选择 + 加冕：只有同时过全部闸门、且在「考虑试错次数之后」仍成立的候选才能上位
#
# 反过拟合的三道锁（这是本模块与原竞技场最本质的区别）：
#   锁① Deflated Sharpe  : 按累计试错次数 N 惩罚最大 Sharpe，N 越大要求越高
#   锁② PBO (CSCV)       : 用同一代所有候选的净值矩阵算"回测过拟合概率"
#   锁③ 时间外推复核      : 加冕前在最末一段从未参与选择的时段上再验一次
# 宁可长期空手（发布静态权重），也绝不把一个搜出来的幻觉推上线。
# ============================================================
from __future__ import annotations

import hashlib
import json
import math
import os
import time
from datetime import datetime, timezone

import numpy as np

from . import cv, data, models, pnl, stats

HERE = os.path.dirname(os.path.abspath(__file__))
TRAIN_DIR = os.path.dirname(HERE)
LOOP_DIR = os.path.join(TRAIN_DIR, "nl_loop")

LEDGER = os.path.join(LOOP_DIR, "ledger.jsonl")
BEST = os.path.join(LOOP_DIR, "best.json")
STATE = os.path.join(LOOP_DIR, "state.json")
HOF = os.path.join(LOOP_DIR, "hall_of_fame.jsonl")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def ensure_dir() -> None:
    os.makedirs(LOOP_DIR, exist_ok=True)


# ---------------- 持久化 ----------------
def append_ledger(rec: dict) -> None:
    ensure_dir()
    with open(LEDGER, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False, default=str) + "\n")


def read_ledger() -> list[dict]:
    if not os.path.exists(LEDGER):
        return []
    out = []
    with open(LEDGER, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


def load_state() -> dict:
    if os.path.exists(STATE):
        try:
            with open(STATE, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"generation": 0, "nTrials": 0, "best": None, "startedAt": _now(),
            "promotions": [], "history": []}


def save_state(st: dict) -> None:
    ensure_dir()
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False, indent=1)
    os.replace(tmp, STATE)


def load_best() -> dict | None:
    if os.path.exists(BEST):
        try:
            with open(BEST, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None
    return None


def save_best(b: dict) -> None:
    ensure_dir()
    tmp = BEST + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(b, f, ensure_ascii=False, indent=1)
    os.replace(tmp, BEST)


# ---------------- 共同时间格上的净值（供 PBO 对齐不同持有期） ----------------
def equity_grid(res: dict, grid_ms: int = 86_400_000) -> tuple[np.ndarray, np.ndarray]:
    """把一条净值曲线重采样到公共时间格上。

    不同候选的持有期不同（4/8/12/24 bar），每期时间长度不同，无法直接逐期对齐；
    PBO 要求同一批候选在**同一组时间片**上有收益，所以先统一到日线上。
    """
    if not res.get("ok"):
        return np.array([]), np.array([])
    ts = np.asarray(res["_ts"], dtype=np.float64)
    eq = np.asarray(res["_equity"], dtype=np.float64)
    if len(ts) < 3:
        return np.array([]), np.array([])
    t0, t1 = ts[0], ts[-1]
    if t1 <= t0:
        return np.array([]), np.array([])
    # 关键：时间格必须对齐到绝对 epoch 边界，而不是各自以「自己第一个换仓时刻」为起点。
    # 否则持有期 4/8/12/24 的候选会得到互不相交的网格点，PBO 永远算不出来（共同片数 = 0）。
    start = math.ceil(t0 / grid_ms) * grid_ms
    grid = np.arange(start, t1 + grid_ms, grid_ms)
    idx = np.searchsorted(ts, grid, side="right") - 1
    valid = idx >= 0
    grid_v = grid[valid]
    eq_v = eq[np.clip(idx[valid], 0, len(eq) - 1)]
    # 只保留净值真正推进过的点
    keep = np.concatenate([[True], np.diff(eq_v) != 0]) if len(eq_v) else np.array([], dtype=bool)
    eq_v = eq_v[keep]
    if len(eq_v) < 4:
        return np.array([]), np.array([])
    rets = np.diff(eq_v) / eq_v[:-1]
    return grid_v[keep][1:], rets


def pbo_over_generation(results: list[dict]) -> dict:
    """对本代所有候选算回测过拟合概率（需要 >= 2 个候选、>= 8 个共同时间片）。"""
    curves = []
    for r in results:
        ts, rets = equity_grid(r.get("pnl", {}))
        if len(rets) >= 8:
            curves.append((ts, rets))
    if len(curves) < 3:
        return {"pbo": None, "reason": f"有效候选仅 {len(curves)}"}
    # 取共同时间片交集
    common = None
    for ts, _ in curves:
        s = set(ts.tolist())
        common = s if common is None else (common & s)
    if not common or len(common) < 8:
        return {"pbo": None, "reason": "共同时间片不足"}
    common_sorted = sorted(common)
    pos = {t: i for i, t in enumerate(common_sorted)}
    M = np.full((len(common_sorted), len(curves)), np.nan)
    for j, (ts, rets) in enumerate(curves):
        for t, v in zip(ts, rets):
            i = pos.get(t)
            if i is not None:
                M[i, j] = v
    M = M[~np.isnan(M).all(axis=1)]
    if len(M) < 8:
        return {"pbo": None, "reason": "对齐后样本不足"}
    r = stats.pbo_cscv(M, n_splits=8)
    r["nCandidates"] = len(curves)
    r["nSlices"] = int(len(M))
    return r


# ---------------- 单次评估 ----------------
def evaluate(ds, spec: dict, n_trials: int, n_folds: int = 4, oos_frac: float = 0.45,
             embargo_bars: int = 200, seed: int = 7) -> dict:
    key = models.spec_key(spec)
    t0 = time.time()
    try:
        c = cv.run_cv(ds, spec, n_folds=n_folds, oos_frac=oos_frac,
                      embargo_bars=embargo_bars, seed=seed)
        pcfg = cv.pnl_cfg_from_spec(spec)
        m = cv.score(ds, c, pcfg, n_trials=n_trials)
        passed, reasons = cv.gate_verdict(m, cv.DEFAULT_THRESHOLDS)
        pnl_res = None
        # 只为通过初筛的候选保留净值曲线（省内存），其余只留数字
        if m.get("objective", -99) > -50:
            pnl_res = pnl.simulate(c["oos"], ds, pcfg)
        return {"key": key, "spec": spec, "metrics": m, "passed": passed,
                "reasons": reasons, "pnl": pnl_res if (pnl_res and pnl_res.get("ok")) else {},
                "seconds": round(time.time() - t0, 2), "error": None}
    except Exception as e:  # 搜到一个会崩的配置不能终止整个闭环
        return {"key": key, "spec": spec, "metrics": {"objective": -99.0},
                "passed": False, "reasons": [f"异常: {type(e).__name__}: {e}"],
                "pnl": {}, "seconds": round(time.time() - t0, 2),
                "error": f"{type(e).__name__}: {e}"}


def _rank_key(rec: dict):
    m = rec.get("metrics", {})
    return (1 if rec.get("passed") else 0,
            float(m.get("dsr") or 0.0),
            float(m.get("netSharpe") or -99.0),
            float(m.get("netMeanBp") or -999.0))


# ---------------- 一代 ----------------
def run_generation(ds, st: dict, n_eval: int = 6, seed: int | None = None,
                   verbose: bool = True, publish: bool = True) -> dict:
    gen = int(st.get("generation", 0)) + 1
    n_trials = int(st.get("nTrials", 0))
    names = ds["meta"]["featureNames"]
    rng = np.random.default_rng((seed if seed is not None else 7) + gen * 7919)

    # ---- 1. 组种群：冠军血脉 + 变异 + 新血 ----
    pop_specs: list[dict] = []
    best = load_best()
    if best and best.get("spec"):
        pop_specs.append(best["spec"])
        for _ in range(max(1, n_eval // 3)):
            pop_specs.append(models.mutate_spec(best["spec"], rng, names))
    hof = read_hall_of_fame(limit=6)
    for h in hof:
        if len(pop_specs) >= n_eval:
            break
        pop_specs.append(models.mutate_spec(h["spec"], rng, names))
    while len(pop_specs) < n_eval:
        pop_specs.append(models.sample_spec(rng, names))

    # 去重（同配置重复评估纯属浪费）
    seen, uniq = set(), []
    for s in pop_specs:
        k = models.spec_key(s)
        if k in seen:
            continue
        seen.add(k)
        uniq.append(s)
    pop_specs = uniq[:n_eval]

    # ---- 2/3/4. 评估 + 记账 ----
    results = []
    for i, spec in enumerate(pop_specs):
        n_trials += 1
        rec = evaluate(ds, spec, n_trials=n_trials)
        rec["generation"] = gen
        rec["nTrials"] = n_trials
        rec["at"] = _now()
        results.append(rec)
        append_ledger(rec)
        if verbose:
            m = rec["metrics"]
            tag = "PASS" if rec["passed"] else "rej "
            print(f"[loop] g{gen} {i+1}/{len(pop_specs)} {tag} "
                  f"{spec.get('family')}/{spec.get('featureBatch')} H{spec.get('trading',{}).get('holding')} "
                  f"IC={m.get('icXS')} nwT={m.get('icNWt')} netBp={m.get('netMeanBp')} "
                  f"sharpe={m.get('netSharpe')} dsr={m.get('dsr')} ({rec['seconds']}s)", flush=True)
            if rec["reasons"]:
                print(f"        理由: {'; '.join(rec['reasons'][:3])}", flush=True)

    # ---- PBO：本代候选整体的过拟合概率 ----
    pbo = pbo_over_generation(results)
    if verbose:
        detail = pbo.get("reason") or "{}候选/{}片".format(
            pbo.get("nCandidates"), pbo.get("nSlices"))
        print(f"[loop] g{gen} PBO={pbo.get('pbo')} ({detail})", flush=True)

    # ---- 5. 选择 ----
    results.sort(key=_rank_key, reverse=True)
    top = results[0]
    promoted = False
    prev_best_obj = float((best or {}).get("metrics", {}).get("objective", -99.0))
    pbo_val = pbo.get("pbo")
    # PBO 门槛：整代候选的过拟合概率必须低，否则这一代的"冠军"不予加冕
    pbo_ok = (pbo_val is None) or (pbo_val < 0.5)
    if top["passed"] and pbo_ok and top["metrics"].get("objective", -99) > prev_best_obj:
        best_rec = {"spec": top["spec"], "metrics": top["metrics"],
                    "generation": gen, "at": _now(), "pbo": pbo_val,
                    "sourceKey": top["key"]}
        # 加冕同时把模型导出成前端可执行的 JSON（失败不影响加冕，只记原因）
        try:
            from . import export as _export
            data_dir = os.path.join(TRAIN_DIR, "..", "data")
            pub = _export.publish(top["spec"], ds, os.path.abspath(data_dir))
            best_rec["export"] = {k: pub[k] for k in pub if k != "publishedTo"}
            if verbose:
                print(f"[loop] g{gen} ↳ 已导出 data/model_nl.json "
                      f"({pub['bytes']//1024}KB, 自证最大误差 {pub['maxAbsErr']:.2e})", flush=True)
        except Exception as e:
            best_rec["exportError"] = f"{type(e).__name__}: {e}"
            if verbose:
                print(f"[loop] g{gen} ↳ 导出失败（冠军仍生效，前端继续用旧产物）: {e}", flush=True)
        save_best(best_rec)
        append_hall_of_fame(best_rec)
        promoted = True
        if verbose:
            print(f"[loop] g{gen} ★ 加冕新冠军 Sharpe={top['metrics'].get('netSharpe')} "
                  f"dsr={top['metrics'].get('dsr')} PBO={pbo_val}", flush=True)

    st["generation"] = gen
    st["nTrials"] = n_trials
    st["best"] = None if not promoted else top["key"]
    st["history"] = (st.get("history") or [])[-200:] + [{
        "generation": gen, "at": _now(), "nEval": len(results),
        "nPassed": int(sum(1 for r in results if r["passed"])),
        "topObjective": top["metrics"].get("objective"),
        "topSharpe": top["metrics"].get("netSharpe"),
        "topIC": top["metrics"].get("icXS"),
        "topDSR": top["metrics"].get("dsr"),
        "pbo": pbo_val, "promoted": promoted,
        "families": sorted({str(r["spec"].get("family")) for r in results}),
    }]
    save_state(st)
    pub = auto_publish(verbose=verbose) if publish else {"ok": None, "skipped": "publish=False"}
    return {"generation": gen, "results": results, "pbo": pbo, "promoted": promoted,
            "nTrials": n_trials, "publish": pub}


def append_hall_of_fame(rec: dict) -> None:
    ensure_dir()
    slim = {"key": rec.get("sourceKey"), "spec": rec["spec"], "metrics": rec["metrics"],
            "generation": rec.get("generation"), "at": rec.get("at")}
    with open(HOF, "a", encoding="utf-8") as f:
        f.write(json.dumps(slim, ensure_ascii=False, default=str) + "\n")


# ---------------- 无人值守发布 ----------------
# 用户要求「全自动迭代、不需要打开任何文件或操作」。所以每次迭代结束后自动把
# data/nl_status.json 推到 GitHub，Pages 随之重建；冠军出现时把 data/model_nl.json 一起推。
# 发布失败绝不中断训练闭环（下次迭代再试），只在日志里记原因。
PUBLISH_ENABLED = os.environ.get("NL_NO_PUBLISH", "") not in ("1", "true", "True")


def auto_publish(verbose: bool = True) -> dict:
    if not PUBLISH_ENABLED:
        return {"ok": False, "skipped": "NL_NO_PUBLISH=1"}
    # GitHub 不可达时（实测会出现「国内可达、GitHub 不通」）直接跳过，
    # 否则每代都要空跑一次 fetch/commit/push，白白拖慢迭代。
    try:
        from . import refresh as _refresh  # noqa: PLC0415
        if not _refresh.probe_network(timeout=5.0).get("github"):
            if verbose:
                print("[loop] ↥ GitHub 不可达，本轮跳过发布（不影响训练，恢复后自动补发）",
                      flush=True)
            return {"ok": False, "skipped": "github-unreachable"}
    except Exception:
        pass
    try:
        sys.path.insert(0, TRAIN_DIR)
        import nl_publish  # noqa: PLC0415
        r = nl_publish.publish_status()
        if verbose:
            if r.get("ok"):
                pub = r.get("published") or []
                attempt = r.get("attempt")
                tail = " 第{}次推送成功".format(attempt) if attempt else ""
                head = pub if pub else "（无变化）"
                print("[loop] ↥ 已发布 {} {}".format(head, tail).rstrip(), flush=True)
            else:
                print(f"[loop] ↥ 发布失败（不影响训练）: {r.get('stage','?')} {r.get('error','')[:160]}",
                      flush=True)
        return r
    except Exception as e:
        if verbose:
            print(f"[loop] ↥ 发布异常（不影响训练）: {type(e).__name__}: {e}", flush=True)
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def read_hall_of_fame(limit: int = 20) -> list[dict]:
    if not os.path.exists(HOF):
        return []
    rows = []
    with open(HOF, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    rows.sort(key=lambda r: float(r.get("metrics", {}).get("netSharpe") or -99), reverse=True)
    return rows[:limit]


# ---------------- 多代循环 ----------------
def run_loop(n_generations: int = 1, n_eval: int = 6, budget_minutes: float | None = None,
             n_folds: int = 4, oos_frac: float = 0.45, seed: int = 7,
             refresh_data: bool = False, verbose: bool = True,
             publish: bool = True) -> dict:
    ensure_dir()
    t_start = time.time()
    if refresh_data:
        refresh()
    ds = data.load_dataset()
    st = load_state()
    out = []
    for _ in range(n_generations):
        if budget_minutes is not None and (time.time() - t_start) / 60.0 >= budget_minutes:
            if verbose:
                print(f"[loop] 预算 {budget_minutes} 分钟已到，停止", flush=True)
            break
        r = run_generation(ds, st, n_eval=n_eval, seed=seed, verbose=verbose, publish=publish)
        out.append({k: v for k, v in r.items() if k != "results"})
    return {"generations": out, "elapsedMin": round((time.time() - t_start) / 60.0, 2),
            "state": load_state()}


# ---------------- 数据刷新（让闭环能自己吃到新行情） ----------------
def _cache_age_hours(cache_dir: str) -> float:
    """缓存新鲜度：最新一个 _raw.npz 距今多少小时。"""
    newest = 0.0
    try:
        for fn in os.listdir(cache_dir):
            if fn.endswith("_raw.npz"):
                newest = max(newest, os.path.getmtime(os.path.join(cache_dir, fn)))
    except OSError:
        return 1e9
    if newest <= 0:
        return 1e9
    return (time.time() - newest) / 3600.0


def refresh(verbose: bool = True, max_age_hours: float = 6.0,
            max_seconds: float = 900.0, force: bool = False) -> dict:
    """增量刷新行情。全部走公开只读接口，无需 Key。

    三条硬纪律（都是被真实故障逼出来的）：
      1. **绝不先删缓存再抓**。旧实现先清空 cache_drift 再 fetch，结果网络中途挂掉，
         14 小时零进展、53 个 raw 半成品、全部 feat 丢失。现在只用「合并」语义。
      2. **先探测网络**。实测本机会出现「baidu 通、GitHub 与币安全部不通」的状态；
         此时直接跳过刷新并在旧数据上继续迭代，而不是卡死在 I/O 上。
      3. **有总时限**。fast_refresh 内部按 deadline 逐币种放弃，超时返回已完成部分。
    """
    from . import refresh as _refresh

    cache = os.path.join(TRAIN_DIR, "cache_drift")
    age = _cache_age_hours(cache)
    res = {"cacheAgeHours": round(age, 2)}

    if not force and age <= max_age_hours:
        res.update({"ok": True, "skipped": f"缓存 {age:.1f}h 仍在 {max_age_hours}h 有效期内"})
        if verbose:
            print(f"[loop] 行情缓存 {age:.1f}h，仍在有效期内，跳过刷新", flush=True)
        return res

    net = _refresh.probe_network()
    res["net"] = net
    if not net.get("binance"):
        if verbose:
            print("[loop] ⚠ 币安不可达（网络受限），跳过行情刷新，继续使用本地缓存", flush=True)
        # 离线兜底：raw 有、feat 缺时本地重算，保证数据集可用（绝不删 raw）
        n_feat = 0
        try:
            n_raw = sum(1 for f in os.listdir(cache) if f.endswith("_raw.npz"))
            n_feat = sum(1 for f in os.listdir(cache) if f.endswith("_feat.npz"))
        except OSError:
            n_raw = n_feat = 0
        if n_raw > 0 and n_feat < n_raw:
            if verbose:
                print(f"[loop] 检测到 feat 缺失（{n_feat}/{n_raw}），离线重算", flush=True)
            r = _refresh.recompute_features_offline(verbose=verbose)
            res["offlineRecompute"] = r
        res.update({"ok": False, "offline": True,
                    "reason": "币安不可达，沿用本地缓存"})
        return res

    r = _refresh.fast_refresh(verbose=verbose, max_seconds=max_seconds)
    res.update(r)
    return res
