#!/usr/bin/env python3
# ============================================================
# arena_tick.py · 策略竞技场云端引擎（GitHub Actions 每 30 分钟运行）
#
# 从浏览器 IndexedDB 迁移到云端的原因：
#   · 浏览器关闭 = 竞技场停摆，信号断档、赛季无法按时结算
#   · 云端持续运行，状态存 data/arena/state.json，前端只读
#
# 与浏览器版 js/lib/arena.js 严格同构：
#   · 11 个策略族 × 4 个周期，信号在 K 线收盘后生成，下一根开盘入场
#   · 到期结算（净收益 = 毛收益 - 往返手续费滑点 0.0014）
#   · 赛季末自然选择：进化组末位 30% 淘汰、前 50% 变异复制（σ=0.20）
#   · 对照组（random/staticRef/learned/coin）永不淘汰：冠军的及格线
#
# 与浏览器版的两处有意改进：
#   · 因子只算在「已收盘」bar 上（浏览器版会用到未收盘的半成品 bar）
#   · 信号生成回填自上次以来所有已收盘 bar（浏览器版丢中间 bar）
#
# 防仓库膨胀设计：
#   · 选手战绩增量聚合（career / seasonAgg），不依赖全量信号
#   · 逐币实盘战绩 coinLive 增量聚合
#   · state.json 只保留未结算信号 + 最近 500 条已结算 + 最近 50 条无效
# ============================================================
import json
import math
import os
import random
import time
from datetime import datetime, timezone

import numpy as np

from train import group_scores, GROUPS, http_get, HOSTS, EXCLUDE_BASE

# ---------------- 配置 ----------------
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
ARENA_DIR = os.path.join(DATA_DIR, "arena")
STATE_PATH = os.path.join(ARENA_DIR, "state.json")
SEED_PATH = os.path.join(ARENA_DIR, "seed_browser_raw.json")
MODEL_PATH = os.path.join(DATA_DIR, "model.json")

FAPI = "https://fapi.binance.com/fapi/v1"
SCAN_SYMBOLS = 24
FEE_RT = 0.0005 * 2 + 0.0002 * 2          # 往返手续费 + 滑点（与浏览器版一致）
SYMBOL_TTL = 6 * 3600 * 1000              # 币种池 6 小时刷新
KEEP_FILLED = 500                          # state.json 保留的已结算信号数
KEEP_INVALID = 50
GEN_BACKFILL_BARS = 3                      # 信号生成最多回填的已收盘 bar 数
KLINES_LIMIT = 140                         # 同时满足因子计算（>=80）与结算窗口（horizon<=30+3）

ARENA_INTERVALS = {
    "15m": {"ms": 900000,      "seasonMs": 3 * 86400000,  "horizon": 8,  "entryThreshold": 0.20},
    "1h":  {"ms": 3600000,     "seasonMs": 7 * 86400000,  "horizon": 12, "entryThreshold": 0.15},
    "4h":  {"ms": 14400000,    "seasonMs": 21 * 86400000, "horizon": 12, "entryThreshold": 0.12},
    "1d":  {"ms": 86400000,    "seasonMs": 60 * 86400000, "horizon": 14, "entryThreshold": 0.10},
}

FAMILIES = {
    "trend":      {"name": "趋势跟随", "weights": {"trend": 0.50, "momentum": 0.15, "meanRev": 0.05, "volume": 0.15, "volatility": 0.05, "position": 0.05, "htf": 0.05, "futures": 0.00}},
    "meanRev":    {"name": "均值回归", "weights": {"trend": 0.05, "momentum": 0.10, "meanRev": 0.55, "volume": 0.10, "volatility": 0.10, "position": 0.05, "htf": 0.00, "futures": 0.05}},
    "momentum":   {"name": "动量突破", "weights": {"trend": 0.15, "momentum": 0.45, "meanRev": 0.05, "volume": 0.20, "volatility": 0.05, "position": 0.05, "htf": 0.05, "futures": 0.00}},
    "hybrid":     {"name": "混合均衡", "weights": {"trend": 0.25, "momentum": 0.20, "meanRev": 0.15, "volume": 0.15, "volatility": 0.10, "position": 0.05, "htf": 0.05, "futures": 0.05}},
    "contrarian": {"name": "逆向反转", "weights": {"trend": -0.30, "momentum": -0.25, "meanRev": 0.30, "volume": -0.10, "volatility": 0.05, "position": 0.05, "htf": 0.00, "futures": 0.05}},
    "volumeOnly": {"name": "纯量能",   "weights": {"trend": 0.10, "momentum": 0.05, "meanRev": 0.05, "volume": 0.65, "volatility": 0.05, "position": 0.05, "htf": 0.05, "futures": 0.00}},
    "htfTrend":   {"name": "高周期趋势", "weights": {"trend": 0.20, "momentum": 0.05, "meanRev": 0.05, "volume": 0.05, "volatility": 0.05, "position": 0.05, "htf": 0.50, "futures": 0.05}},
    "random":     {"name": "随机对照", "weights": None},
    "staticRef":  {"name": "静态对照", "weights": {"trend": 0.22, "momentum": 0.18, "meanRev": 0.13, "volume": 0.13, "volatility": 0.09, "position": 0.05, "htf": 0.10, "futures": 0.10}},
    "learned":    {"name": "云端模型", "weights": None},
    "coin":       {"name": "逐币模型", "weights": None},
}
CONTROL_FAMILIES = {"random", "staticRef", "learned", "coin"}

# ---------------- 数据访问 ----------------
def futures_get(path, timeout=20):
    """合约直连优先，失败降级现货镜像（与前端 marketGet 同策略）"""
    try:
        return http_get(FAPI + path, timeout=timeout, retries=1)
    except Exception:
        last = None
        for h in HOSTS:
            try:
                return http_get(h + path, timeout=timeout, retries=1)
            except Exception as e:  # noqa
                last = e
        raise last


def fetch_tickers():
    data = futures_get("/ticker/24hr", timeout=30)
    out = {}
    for t in data:
        try:
            out[t["symbol"]] = {"price": float(t["lastPrice"]), "quoteVolume": float(t["quoteVolume"])}
        except Exception:  # noqa
            continue
    return out


def fetch_klines(sym, iv, limit=KLINES_LIMIT):
    """返回 [(time, open, high, low, close, volume), ...]，含未收盘 bar（调用方决定丢不丢）"""
    data = futures_get(f"/klines?symbol={sym}&interval={iv}&limit={limit}", timeout=25)
    return [(int(k[0]), float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[5])) for k in data]


def pick_symbols():
    tk = fetch_tickers()
    syms = [s for s, v in tk.items()
            if s.endswith("USDT") and v["quoteVolume"] > 0 and s[:-4] not in EXCLUDE_BASE]
    syms.sort(key=lambda s: -tk[s]["quoteVolume"])
    return syms[:SCAN_SYMBOLS]

# ---------------- 统计 ----------------
def empty_agg():
    return {"n": 0, "wins": 0, "sum": 0.0, "sumSq": 0.0, "mfeSum": 0.0, "maeSum": 0.0}


def agg_add(agg, sig):
    r = sig["netReturn"]
    agg["n"] += 1
    agg["sum"] += r
    agg["sumSq"] += r * r
    if r > 0:
        agg["wins"] += 1
    agg["mfeSum"] += sig.get("mfe") or 0.0
    agg["maeSum"] += sig.get("mae") or 0.0


def derive_stats(agg):
    n = agg["n"]
    if not n:
        return {"n": 0, "wins": 0, "totalRet": 0, "meanRet": 0, "tStat": 0, "sharpe": 0,
                "winRate": 0, "mfeAvg": 0, "maeAvg": 0}
    mean = agg["sum"] / n
    var = max(0.0, agg["sumSq"] / n - mean * mean)
    sd = math.sqrt(var)
    return {
        "n": n, "wins": agg["wins"], "totalRet": agg["sum"], "meanRet": mean,
        "tStat": mean / (sd / math.sqrt(n)) if sd > 0 else 0,
        "sharpe": mean / sd if sd > 0 else 0,
        "winRate": agg["wins"] / n,
        "mfeAvg": agg["mfeSum"] / n, "maeAvg": agg["maeSum"] / n,
    }


def rank_key(stats):
    """赛季排名分数（与浏览器版一致）"""
    if stats["n"] >= 8:
        return stats["tStat"] * (1 if (stats["meanRet"] or 0) >= 0 else -1)
    return -999 + stats["n"] * 0.01

# ---------------- 选手 ----------------
def rid():
    return "".join(random.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(6))


def random_weights():
    w = {}
    total = 0.0
    for k in GROUPS:
        w[k] = (random.random() * 2 - 1) * 0.4
        total += abs(w[k])
    return {k: v / (total or 1) for k, v in w.items()}


def mutate_weights(w, sigma=0.20):
    out = {}
    total = 0.0
    for k, v in w.items():
        out[k] = v + (random.random() * 2 - 1) * sigma * max(0.15, abs(v))
        total += abs(out[k])
    if total > 0:
        out = {k: v / total for k, v in out.items()}
    return out


def new_player(iv, fam, model, generation=0, parent=None):
    cfg = ARENA_INTERVALS[iv]
    if fam in ("learned", "coin"):
        w = dict((model or {}).get("weights") or FAMILIES["hybrid"]["weights"])
    elif FAMILIES[fam]["weights"]:
        w = dict(FAMILIES[fam]["weights"])
    else:
        w = random_weights()
    p = {
        "id": f"{iv}_{fam}_g{generation}_{rid()}",
        "interval": iv, "family": fam, "familyName": FAMILIES[fam]["name"],
        "generation": generation, "parentId": parent,
        "weights": w,
        "params": {"horizon": cfg["horizon"], "entryThreshold": cfg["entryThreshold"]},
        "status": "active",
        "createdAt": now_ms(), "seasonStart": now_ms(),
        "isChampion": False,
        "career": empty_agg(), "seasonAgg": empty_agg(),
    }
    if fam in ("learned", "coin"):
        p["modelTrainedAt"] = (model or {}).get("trainedAt")
    return p


def now_ms():
    return int(time.time() * 1000)

# ---------------- 状态载入 / 迁移 ----------------
def convert_seed(seed, model):
    """浏览器导出 → 云端状态：保留选手与未结算信号，战绩转为增量聚合"""
    players = seed.get("players", [])
    signals = seed.get("signals", [])
    # 各周期赛季起点 = 该周期选手最小 seasonStart（与浏览器版一致）
    iv_start = {}
    for p in players:
        if p.get("status") == "retired":
            continue
        iv = p["interval"]
        iv_start[iv] = min(iv_start.get(iv, 1 << 62), p.get("seasonStart", now_ms()))
    for p in players:
        p["career"] = empty_agg()
        p["seasonAgg"] = empty_agg()
        p.setdefault("isChampion", False)
    by_id = {p["id"]: p for p in players}
    coin_live = {}
    filled = []
    for s in signals:
        if s.get("status") == "filled" and s.get("netReturn") is not None:
            filled.append(s)
            p = by_id.get(s["playerId"])
            if p:
                agg_add(p["career"], s)
                if s.get("exitBarTime", 0) >= iv_start.get(p["interval"], 0):
                    agg_add(p["seasonAgg"], s)
            if s.get("family") == "coin":
                agg_add(coin_live.setdefault(s["symbol"], empty_agg()), s)
    # 信号修剪：未结算全保留 + 最近 N 条已结算 + 最近 50 条无效
    pending = [s for s in signals if s.get("status") in ("pending_entry", "pending_exit")]
    invalid = sorted((s for s in signals if s.get("status") == "invalid"),
                     key=lambda x: x.get("createdAt", 0))[-KEEP_INVALID:]
    filled.sort(key=lambda x: x.get("exitBarTime") or 0)
    kept = pending + invalid + filled[-KEEP_FILLED:]
    # lastBarSeen：从现有信号推断，避免重复生成
    last_seen = {}
    for s in signals:
        k = f"{s['interval']}|{s['symbol']}"
        last_seen[k] = max(last_seen.get(k, 0), s.get("signalBarTime", 0))
    return {
        "version": 1,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "symbols": [], "symbolsAt": 0,
        "lastBarSeen": last_seen,
        "players": players,
        "signals": kept,
        "seasons": seed.get("seasons", []),
        "coinLive": coin_live,
        "migratedFrom": "browser-indexeddb",
    }


def load_state(model):
    if os.path.exists(STATE_PATH):
        with open(STATE_PATH, encoding="utf-8") as f:
            return json.load(f)
    if os.path.exists(SEED_PATH):
        print("[arena] 检测到浏览器导出种子，执行迁移")
        with open(SEED_PATH, encoding="utf-8") as f:
            return convert_seed(json.load(f), model)
    return {
        "version": 1,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "symbols": [], "symbolsAt": 0,
        "lastBarSeen": {},
        "players": [], "signals": [], "seasons": [],
        "coinLive": {},
    }


def ensure_pools(state, model):
    have = {(p["interval"], p["family"]) for p in state["players"] if p.get("status") != "retired"}
    for iv in ARENA_INTERVALS:
        for fam in FAMILIES:
            if (iv, fam) not in have:
                state["players"].append(new_player(iv, fam, model))
                print(f"[arena] 新选手 {iv}/{fam}")


def sync_learned(state, model):
    """learned 族跟随云端模型权重；coin 族仅同步版本标记（计分按币种实时取 coinModels）"""
    if not model or not model.get("weights"):
        return
    for p in state["players"]:
        if p.get("status") == "retired" or p["family"] not in ("learned", "coin"):
            continue
        if p.get("modelTrainedAt") != model.get("trainedAt"):
            if p["family"] == "learned":
                p["weights"] = dict(model["weights"])
            p["modelTrainedAt"] = model.get("trainedAt")
            print(f"[arena] {p['id']} 同步模型 {model.get('trainedAt')}")

# ---------------- 信号生成 ----------------
def player_score(p, g, sym, coin_models):
    w = p["weights"]
    if p["family"] == "coin":
        cm = (coin_models or {}).get(sym)
        if not cm or not cm.get("weights"):
            return None
        w = cm["weights"]
    return sum((w.get(k) or 0) * (g.get(k) or 0) for k in w)


def generate_signals(state, model, iv, symbols, klines_cache):
    cfg = ARENA_INTERVALS[iv]
    ms = cfg["ms"]
    players = [p for p in state["players"] if p["interval"] == iv and p.get("status") != "retired"]
    if not players:
        return 0
    coin_models = model.get("coinModels") if model else None
    existing_ids = {s["id"] for s in state["signals"]}
    now = now_ms()
    created = 0
    for sym in symbols:
        key = f"{iv}|{sym}"
        last_closed = (now // ms) * ms - ms       # 最近一根已收盘 bar 的开盘时间
        seen = state["lastBarSeen"].get(key, 0)
        if seen >= last_closed:
            continue                               # 没有新收盘 bar
        candles = klines_cache.get((sym, iv))
        if candles is None:
            try:
                candles = fetch_klines(sym, iv)
            except Exception as e:  # noqa
                print(f"[arena] {sym} {iv} K线失败：{e}")
                continue
            klines_cache[(sym, iv)] = candles
        closed = [c for c in candles if c[0] <= last_closed]
        if len(closed) < 80:
            continue
        # 回填自上次以来的所有已收盘 bar（最多 GEN_BACKFILL_BARS 根）
        new_bars = [c for c in closed if c[0] > seen][-GEN_BACKFILL_BARS:]
        if not new_bars:
            state["lastBarSeen"][key] = last_closed
            continue
        arr = np.array([[c[0], c[1], c[2], c[3], c[4], c[5]] for c in closed])
        idx_of = {c[0]: i for i, c in enumerate(closed)}
        out, _ = group_scores(arr, None)
        for bar in new_bars:
            i = idx_of[bar[0]]
            g = {grp: float(out[grp][i]) for grp in GROUPS}
            for p in players:
                score = player_score(p, g, sym, coin_models)
                if score is None or abs(score) < p["params"]["entryThreshold"]:
                    continue
                sid = f"{p['id']}|{sym}|{bar[0]}"
                if sid in existing_ids:
                    continue
                rec = {
                    "id": sid, "playerId": p["id"], "interval": iv, "symbol": sym,
                    "family": p["family"], "generation": p["generation"],
                    "signalBarTime": bar[0],
                    "direction": "long" if score > 0 else "short",
                    "score": round(score, 4),
                    "entryBarTime": bar[0] + ms,
                    "entryPrice": None, "exitBarTime": None, "exitPrice": None,
                    "grossReturn": None, "netReturn": None, "mfe": None, "mae": None,
                    "status": "pending_entry", "createdAt": now,
                }
                if p["family"] == "coin" and coin_models and coin_models.get(sym):
                    rec["coinIc"] = coin_models[sym].get("ic")
                    rec["coinN"] = coin_models[sym].get("n")
                state["signals"].append(rec)
                existing_ids.add(sid)
                created += 1
        state["lastBarSeen"][key] = last_closed
    return created

# ---------------- 回填与结算 ----------------
def settle_signals(state, klines_cache):
    pending = [s for s in state["signals"] if s["status"] in ("pending_entry", "pending_exit")]
    if not pending:
        return 0
    by_id = {p["id"]: p for p in state["players"]}
    groups = {}
    for s in pending:
        groups.setdefault((s["symbol"], s["interval"]), []).append(s)
    now = now_ms()
    filled = 0
    for (sym, iv), recs in groups.items():
        cfg = ARENA_INTERVALS[iv]
        ms = cfg["ms"]
        candles = klines_cache.get((sym, iv))
        if candles is None:
            try:
                candles = fetch_klines(sym, iv)
            except Exception:  # noqa
                continue
            klines_cache[(sym, iv)] = candles
        bar_by_time = {c[0]: c for c in candles}
        for r in recs:
            horizon = (by_id.get(r["playerId"], {}).get("params") or {}).get("horizon", cfg["horizon"])
            if r["status"] == "pending_entry":
                eb = bar_by_time.get(r["entryBarTime"])
                if eb is None:
                    if now > r["entryBarTime"] + ms * 3:
                        r["status"] = "invalid"
                    continue
                r["entryPrice"] = eb[1]
                r["status"] = "pending_exit"
            exit_bar_time = r["entryBarTime"] + ms * horizon
            if now < exit_bar_time + ms:
                continue                             # 出场 bar 未收盘
            xb = bar_by_time.get(exit_bar_time)
            if xb is None:
                continue
            d = 1 if r["direction"] == "long" else -1
            entry = r["entryPrice"]
            r["grossReturn"] = d * (xb[4] - entry) / entry
            r["netReturn"] = r["grossReturn"] - FEE_RT
            path = [c for c in candles if r["entryBarTime"] < c[0] <= exit_bar_time]
            if path:
                r["mfe"] = max(d * (c[2] - entry) / entry for c in path)
                r["mae"] = min(d * (c[3] - entry) / entry for c in path)
            r["exitBarTime"] = exit_bar_time
            r["exitPrice"] = xb[4]
            r["status"] = "filled"
            filled += 1
            # 增量聚合：生涯 + 赛季 + 逐币实盘
            p = by_id.get(r["playerId"])
            if p:
                agg_add(p["career"], r)
                agg_add(p["seasonAgg"], r)
            if r.get("family") == "coin":
                agg_add(state["coinLive"].setdefault(r["symbol"], empty_agg()), r)
    return filled

# ---------------- 赛季进化 ----------------
def maybe_run_season(state, iv):
    cfg = ARENA_INTERVALS[iv]
    players = [p for p in state["players"] if p["interval"] == iv and p.get("status") != "retired"]
    if not players:
        return None
    season_start = min(p["seasonStart"] for p in players)
    if now_ms() - season_start < cfg["seasonMs"]:
        return None

    ranked = []
    for p in players:
        ss = derive_stats(p["seasonAgg"])
        p["seasonStats"] = ss
        ranked.append({"p": p, "ss": ss, "score": rank_key(ss)})
    ranked.sort(key=lambda r: -r["score"])

    evolvable = [r for r in ranked if r["p"]["family"] not in CONTROL_FAMILIES]
    champion = ranked[0]
    champion_evo = evolvable[0] if evolvable else None
    n_ev = len(evolvable)
    retire_n = max(1, int(n_ev * 0.3))

    for r in evolvable[n_ev - retire_n:]:
        r["p"]["status"] = "retired"
        r["p"]["retiredAt"] = now_ms()
        r["p"]["retiredReason"] = f"赛季末 t={r['ss']['tStat']:.2f} n={r['ss']['n']} 排名末位"
    survivors = evolvable[:max(1, int(n_ev * 0.5))]
    active_count = sum(1 for p in players if p["status"] == "active")
    room = max(0, 14 - active_count + retire_n)
    for r in survivors:
        if room <= 0:
            break
        parent = r["p"]
        child = new_player(iv, parent["family"], None, parent["generation"] + 1, parent["id"])
        child["weights"] = mutate_weights(parent["weights"], 0.20)
        child["params"] = {
            "horizon": max(4, min(30, parent["params"]["horizon"] + round((random.random() * 2 - 1) * 3))),
            "entryThreshold": max(0.06, min(0.30, parent["params"]["entryThreshold"] + (random.random() * 2 - 1) * 0.03)),
        }
        state["players"].append(child)
        room -= 1
    for r in ranked:
        p = r["p"]
        if p["family"] == "random":
            p["weights"] = random_weights()
        p["seasonStart"] = now_ms()
        p["seasonAgg"] = empty_agg()
        if p["status"] != "retired":
            p["isChampion"] = (r is champion_evo)
    fam_rank = {}
    for i, r in enumerate(ranked):
        fam_rank.setdefault(r["p"]["family"], i + 1)
    log = {
        "interval": iv, "finishedAt": now_ms(),
        "players": len(ranked),
        "champion": {"family": champion["p"]["family"], "name": champion["p"]["familyName"],
                     "gen": champion["p"]["generation"], "stats": champion["ss"]},
        "randomRank": fam_rank.get("random"), "staticRank": fam_rank.get("staticRef"),
        "learnedRank": fam_rank.get("learned"), "coinRank": fam_rank.get("coin"),
        "table": [{"family": r["p"]["family"], "name": r["p"]["familyName"], "gen": r["p"]["generation"],
                   "n": r["ss"]["n"], "tStat": round(r["ss"]["tStat"], 2),
                   "meanRet": round(r["ss"]["meanRet"], 5), "winRate": round(r["ss"]["winRate"], 3),
                   "retired": r["p"]["status"] == "retired"} for r in ranked],
    }
    state["seasons"].append(log)
    print(f"[arena] {iv} 赛季结算：冠军 {log['champion']['name']} g{log['champion']['gen']}，随机组第 {log['randomRank']}")
    return log

# ---------------- 修剪与保存 ----------------
def prune_signals(state):
    sigs = state["signals"]
    pending = [s for s in sigs if s["status"] in ("pending_entry", "pending_exit")]
    invalid = sorted((s for s in sigs if s["status"] == "invalid"),
                     key=lambda x: x.get("createdAt", 0))[-KEEP_INVALID:]
    filled = sorted((s for s in sigs if s["status"] == "filled"),
                    key=lambda x: x.get("exitBarTime") or 0)[-KEEP_FILLED:]
    state["signals"] = pending + invalid + filled


def finalize(state):
    """派生字段：stats（生涯）与 seasonStats（赛季），前端直接消费"""
    for p in state["players"]:
        p["stats"] = derive_stats(p.get("career") or empty_agg())
        p["seasonStats"] = derive_stats(p.get("seasonAgg") or empty_agg())


def save_state(state):
    os.makedirs(ARENA_DIR, exist_ok=True)
    state["updatedAt"] = datetime.now(timezone.utc).isoformat()
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, STATE_PATH)

# ---------------- 主流程 ----------------
def main():
    t0 = time.time()
    print(f"[arena] {datetime.now(timezone.utc).isoformat()} 云端竞技场 tick 开始")
    model = None
    try:
        with open(MODEL_PATH, encoding="utf-8") as f:
            model = json.load(f)
    except Exception as e:  # noqa
        print(f"[arena] model.json 读取失败（learned/coin 族用占位权重）：{e}")

    state = load_state(model)
    ensure_pools(state, model)
    sync_learned(state, model)

    # 币种池（6 小时缓存）
    if now_ms() - state.get("symbolsAt", 0) > SYMBOL_TTL or not state.get("symbols"):
        try:
            state["symbols"] = pick_symbols()
            state["symbolsAt"] = now_ms()
            print(f"[arena] 币种池刷新：{len(state['symbols'])} 个")
        except Exception as e:  # noqa
            print(f"[arena] 币种池刷新失败，沿用旧池：{e}")
    symbols = state.get("symbols") or []
    if not symbols:
        print("[arena] 无币种池，本轮结束")
        save_state(state)
        return

    klines_cache = {}
    filled = settle_signals(state, klines_cache)
    created = 0
    for iv in ARENA_INTERVALS:
        created += generate_signals(state, model, iv, symbols, klines_cache)
        maybe_run_season(state, iv)

    prune_signals(state)
    finalize(state)
    save_state(state)
    n_players = sum(1 for p in state["players"] if p.get("status") != "retired")
    n_pend = sum(1 for s in state["signals"] if s["status"] in ("pending_entry", "pending_exit"))
    print(f"[arena] 完成：新信号 {created} · 新结算 {filled} · 在役 {n_players} · 未结算 {n_pend} "
          f"· 信号库 {len(state['signals'])} · 赛季 {len(state['seasons'])} · 耗时 {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
