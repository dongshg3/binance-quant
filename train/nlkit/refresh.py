#!/usr/bin/env python3
# ============================================================
# nlkit/refresh.py · 增量行情刷新（只抓最近 K 线，绝不重建全部历史）
# ------------------------------------------------------------
# 为什么重写：原实现复用 experiment_drift.py 的 fetch，而它会为每个币种
# **重新下载期货月度数据包来重建全部历史**。实测该路径会在网络 I/O 上无限期挂起
# （14 小时零进展、CPU 0.5 秒、子进程不退出），对"无人值守"是致命缺陷。
#
# 现在的做法：
#   · K 线：只拉最近 1000 根 1h，按开盘时间与已有缓存合并（滚动窗口 4000 根）
#   · 资金费率 / 多空比 / 持仓量：直接走 REST 端点抓最近窗口，与旧缓存拼接
#     （老 bar 沿用旧值，只覆盖新增与重叠部分——不需要任何 zip 下载）
#   · 全部请求带超时与重试；每个币种独立失败不影响其他币种
#   · 整个刷新带**总时限**，超时即返回已完成部分（数据集可继续用旧数据）
# ============================================================
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np

FAPI = "https://fapi.binance.com"
HERE = os.path.dirname(os.path.abspath(__file__))
TRAIN_DIR = os.path.dirname(HERE)
CACHE = os.path.join(TRAIN_DIR, "cache_drift")

KEEP_BARS = 4000          # 每个币种保留的 1h bar 数（与训练口径一致）
KLINES_LIMIT = 1000       # 单次拉取的最近 K 线数
HTTP_TIMEOUT = 12
HTTP_RETRIES = 2
ALLOWED_BASES = None      # None = 不额外过滤，沿用缓存里已有的标的口号


def _get(path: str, params: dict | None = None) -> object:
    url = FAPI + path
    if params:
        url += "?" + "&".join(f"{k}={v}" for k, v in params.items())
    last = None
    for attempt in range(HTTP_RETRIES + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "nlkit-refresh/1.0"})
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
                return json.loads(r.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
            last = e
            time.sleep(0.6 * (attempt + 1))
    raise RuntimeError(f"{path} 失败: {type(last).__name__}: {last}")


def _symbols() -> list[str]:
    if not os.path.isdir(CACHE):
        return []
    out = []
    for fn in os.listdir(CACHE):
        if fn.endswith("_raw.npz"):
            s = fn[:-8]
            if s.isascii():
                out.append(s)
    return sorted(out)


# ---------------- 网络探针 ----------------
# 为什么必须有：实测本机会出现「国内可达、GitHub 与币安全部不可达」的状态
# （代理掉线）。此前 refresh 在 fetch 前先清空缓存，一旦网络中途挂掉就会把
# 全部特征缓存清空、并让循环无限期阻塞 14 小时。现在先探测、再决定做什么。
PROBES = (
    ("binance", FAPI + "/fapi/v1/time"),
    ("github", "https://api.github.com/zen"),
)


def probe_network(timeout: float = 6.0) -> dict:
    out = {}
    for name, url in PROBES:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "nlkit-refresh/1.0"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                r.read(64)
            out[name] = True
        except Exception:
            out[name] = False
    out["any"] = any(v for k, v in out.items() if k in ("binance", "github"))
    out["ok"] = out.get("binance", False) and out.get("github", False)
    return out


# ---------------- 离线重算特征 ----------------
def recompute_features_offline(verbose: bool = True, rebuild_dataset: bool = True) -> dict:
    """不联网，仅从已有的 *_raw.npz 重算 *_feat.npz。

    用途：刷新失败或被中断后，把特征缓存恢复到可用状态，让迭代继续在旧数据上跑。
    绝不删除任何 raw 缓存。
    """
    import sys
    sys.path.insert(0, TRAIN_DIR)
    import train as T  # noqa: PLC0415

    syms = _symbols()
    ok, fail = 0, []
    for i, s in enumerate(syms, 1):
        raw_path = os.path.join(CACHE, f"{s}_raw.npz")
        feat_path = os.path.join(CACHE, f"{s}_feat.npz")
        try:
            d = np.load(raw_path)
            ohlcv, fr, ls, oi = d["ohlcv"], d["fr"], d["ls"], d["oi"]
            if len(ohlcv) < 500:
                fail.append({"sym": s, "reason": f"bar 太少 {len(ohlcv)}"})
                continue
            gs, aux = T.group_scores(ohlcv, (list(fr), list(ls), list(oi)))
            X = np.column_stack([gs[g] for g in T.GROUPS])
            np.savez_compressed(feat_path, X=X, sig=aux["sig"], adx=aux["adx"],
                                c=ohlcv[:, 4], t0=ohlcv[:, 0], fr=fr)
            ok += 1
        except Exception as e:
            fail.append({"sym": s, "reason": f"{type(e).__name__}: {e}"})
        if verbose and i % 20 == 0:
            print(f"[refresh] 离线重算 {i}/{len(syms)}", flush=True)

    res = {"ok": ok > 0, "nFeat": ok, "nFail": len(fail), "failSample": fail[:5]}
    if ok and rebuild_dataset:
        try:
            from . import data as _data  # noqa: PLC0415
            meta = _data.build_dataset(verbose=verbose)
            res["dataset"] = {k: meta[k] for k in ("nRows", "nSymbols", "nFeatures", "tsMax")}
        except Exception as e:
            res["datasetError"] = f"{type(e).__name__}: {e}"
    return res


def _ffill_to_bars(bar_ms: np.ndarray, src_ms: np.ndarray, src_val: np.ndarray) -> np.ndarray:
    """把（可能稀疏的）源序列按「最近一个不晚于该 bar 的值」对齐到 bar 网格。"""
    out = np.full(len(bar_ms), np.nan)
    if len(src_ms) == 0:
        return out
    order = np.argsort(src_ms)
    s_ms = src_ms[order]
    s_v = src_val[order]
    idx = np.searchsorted(s_ms, bar_ms, side="right") - 1
    ok = idx >= 0
    out[ok] = s_v[idx[ok]]
    return out


def _fetch_one(sym: str) -> dict:
    """拉取单个币种的最近数据并与已有缓存合并。返回 {'ok', 'bars', 'reason'}。"""
    raw_path = os.path.join(CACHE, f"{sym}_raw.npz")
    feat_path = os.path.join(CACHE, f"{sym}_feat.npz")
    try:
        old = np.load(raw_path)
        o_ohlcv = old["ohlcv"]
        o_fr, o_ls, o_oi = old["fr"], old["ls"], old["oi"]
    except Exception as e:
        return {"ok": False, "sym": sym, "reason": f"读缓存失败 {type(e).__name__}"}

    try:
        kl = _get("/fapi/v1/klines", {"symbol": sym, "interval": "1h", "limit": KLINES_LIMIT})
    except Exception as e:
        return {"ok": False, "sym": sym, "reason": f"K线 {e}"}
    if not isinstance(kl, list) or len(kl) < 50:
        return {"ok": False, "sym": sym, "reason": "K线不足"}

    new = np.array([[float(k[0]), float(k[1]), float(k[2]), float(k[3]),
                     float(k[4]), float(k[5])] for k in kl], dtype=np.float64)
    new_t0 = new[:, 0]

    # ---- 合并 K 线：保留比新数据更老的旧 bar，重叠部分以新数据为准 ----
    if len(o_ohlcv):
        keep_old = o_ohlcv[o_ohlcv[:, 0] < new_t0[0]]
    else:
        keep_old = np.zeros((0, 6))
    merged = np.concatenate([keep_old, new], axis=0)
    if len(merged) > KEEP_BARS:
        merged = merged[-KEEP_BARS:]
    bar_ms = merged[:, 0]
    n = len(bar_ms)

    # ---- 资金费率（8h 一次）----
    fr = np.full(n, np.nan)
    try:
        fnd = _get("/fapi/v1/fundingRate", {"symbol": sym, "limit": 1000})
        if isinstance(fnd, list) and fnd:
            f_ms = np.array([float(x["fundingTime"]) for x in fnd])
            f_v = np.array([float(x["fundingRate"]) for x in fnd])
            fr = _ffill_to_bars(bar_ms, f_ms, f_v)
    except Exception:
        pass
    if len(o_fr) == n and np.isnan(fr).all():
        fr = o_fr.copy()
    elif len(o_fr) == n:
        miss = ~np.isfinite(fr)
        fr[miss] = o_fr[miss]

    # ---- 多空比（1h，最近 30 天）----
    ls = np.full(n, np.nan)
    try:
        arr = _get("/futures/data/globalLongShortAccountRatio",
                   {"symbol": sym, "period": "1h", "limit": 500})
        if isinstance(arr, list) and arr:
            l_ms = np.array([float(x["timestamp"]) for x in arr])
            l_v = np.array([float(x["longShortRatio"]) for x in arr])
            ls = _ffill_to_bars(bar_ms, l_ms, l_v)
    except Exception:
        pass
    if len(o_ls) == n:
        miss = ~np.isfinite(ls)
        ls[miss] = o_ls[miss]

    # ---- 持仓量（1h，最近 30 天）----
    oi = np.full(n, np.nan)
    try:
        arr = _get("/futures/data/openInterestHist",
                   {"symbol": sym, "period": "1h", "limit": 500})
        if isinstance(arr, list) and arr:
            i_ms = np.array([float(x["timestamp"]) for x in arr])
            i_v = np.array([float(x["sumOpenInterest"]) for x in arr])
            oi = _ffill_to_bars(bar_ms, i_ms, i_v)
    except Exception:
        pass
    if len(o_oi) == n:
        miss = ~np.isfinite(oi)
        oi[miss] = o_oi[miss]

    np.savez_compressed(raw_path, ohlcv=merged, fr=fr, ls=ls, oi=oi)

    # ---- 重算因子组得分（与 experiment_drift.phase_features 完全同口径）----
    try:
        import train as T  # noqa: PLC0415
        fut = (list(fr), list(ls), list(oi))
        gs, aux = T.group_scores(merged, fut)
        X = np.column_stack([gs[g] for g in T.GROUPS])
        np.savez_compressed(feat_path, X=X, sig=aux["sig"], adx=aux["adx"],
                            c=merged[:, 4], t0=merged[:, 0], fr=fr)
    except Exception as e:
        return {"ok": False, "sym": sym, "reason": f"特征 {type(e).__name__}: {e}"}

    return {"ok": True, "sym": sym, "bars": n, "lastBarMs": int(bar_ms[-1])}


def fast_refresh(verbose: bool = True, max_seconds: float = 600.0,
                 workers: int = 6, rebuild_dataset: bool = True) -> dict:
    """增量刷新全部币种，然后重建数据集。带总时限与失败隔离。"""
    import sys
    sys.path.insert(0, TRAIN_DIR)

    syms = _symbols()
    if not syms:
        return {"ok": False, "reason": "没有缓存符号，先跑一次完整 fetch"}
    t0 = time.time()
    ok, fail, skipped = [], [], []
    deadline = t0 + max_seconds

    if verbose:
        print(f"[refresh] 增量刷新 {len(syms)} 个币种（{workers} 线程，总时限 {max_seconds:.0f}s）",
              flush=True)

    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(_fetch_one, s): s for s in syms}
        for i, fut in enumerate(as_completed(futs), 1):
            if time.time() > deadline:
                skipped.append(futs[fut])
                continue
            try:
                r = fut.result()
            except Exception as e:
                fail.append({"sym": futs[fut], "reason": f"{type(e).__name__}: {e}"})
                continue
            if r.get("ok"):
                ok.append(r)
            else:
                fail.append({"sym": r["sym"], "reason": r.get("reason")})
            if verbose and i % 15 == 0:
                print(f"[refresh] {i}/{len(syms)} 成功{len(ok)} 失败{len(fail)}", flush=True)

    res = {"ok": bool(ok), "nOk": len(ok), "nFail": len(fail), "nSkipped": len(skipped),
           "elapsedSec": round(time.time() - t0, 1),
           "lastBarMs": max((r["lastBarMs"] for r in ok), default=None),
           "failSample": fail[:5]}

    if not ok:
        return res

    if rebuild_dataset:
        try:
            from . import data as _data  # noqa: PLC0415
            meta = _data.build_dataset(verbose=verbose)
            res["dataset"] = {k: meta[k] for k in ("nRows", "nSymbols", "nFeatures", "tsMax")}
        except Exception as e:
            res["datasetError"] = f"{type(e).__name__}: {e}"
    res["elapsedSec"] = round(time.time() - t0, 1)
    return res


if __name__ == "__main__":
    import sys
    out = fast_refresh(verbose=True, max_seconds=float(sys.argv[1]) if len(sys.argv) > 1 else 600)
    print(json.dumps(out, ensure_ascii=False, indent=1))
