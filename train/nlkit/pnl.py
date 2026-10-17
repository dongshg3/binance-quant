#!/usr/bin/env python3
# ============================================================
# nlkit/pnl.py · 净成本组合模拟（判断「能不能赚钱」的唯一口径）
# ------------------------------------------------------------
# 为什么必须有这一层：原管线用横截面 IC 做闸门。IC 0.02 听起来"有信号"，
# 但它换算成钱是多少、扣掉手续费/滑点/资金费之后还剩多少，IC 完全答不了。
# 一套 IC=0.03 但每天换手 6 次的策略，净收益可以稳定为负。
#
# 本模块的口径（全部保守、全部可复算）：
#   信号在 t bar 收盘用 ≤t 的信息生成 → 在 t 收盘建仓 → 在 t+H 收盘平仓（H=持有 bar 数）
#   组合收益 = Σ w_i · log(c[t+H]/c[t])                       ← 毛收益
#            − turnover · (手续费/边 + 滑点/边)                ← 换手成本
#            − Σ 资金费 (多头正费率付出 / 空头正费率收取)      ← 持仓成本
#
# 三件事刻意不做，因为它们会让回测虚高：
#   1. 不用重叠样本累加（相邻 H bar 的信号共用同一段行情，累加等于把样本数虚增 H 倍）
#   2. 不假设按信号强度无限加杠杆（总敞口固定，单币有上限）
#   3. 不忽略成本敏感性（必须报"盈亏平衡成本"，否则不知道 edge 离成本有多远）
# ============================================================
from __future__ import annotations

import math

import numpy as np

from . import stats

# 币安 USDⓈ-M 永续：吃单 0.05%/边、挂单 0.02%/边。默认按吃单 + 滑点估，偏保守。
DEFAULT_FEE_SIDE = 0.0005
DEFAULT_SLIP_SIDE = 0.0002
FUNDING_PER_DAY = 3.0     # 资金费每天结算 3 次（每 8 小时一次）
BARS_PER_HOUR = 1.0


def _weights_from_pred(pred, cfg) -> np.ndarray:
    """把预测分数变成可执行的组合权重（多头 + 空头，总敞口 = gross）。"""
    p = np.asarray(pred, dtype=float)
    n = len(p)
    if n < 4:
        return np.zeros(n)
    mode = cfg.get("weighting", "demean")
    top = float(cfg.get("topFrac", 1.0))
    gross = float(cfg.get("gross", 1.0))
    cap = float(cfg.get("maxWeight", 0.25))

    finite = np.isfinite(p)
    if finite.sum() < 4:
        return np.zeros(n)
    p = np.where(finite, p, np.nanmedian(p[finite]))

    # 只交易两端 top 分位（显著降低换手，是"能不能覆盖成本"的关键旋钮）
    keep = np.zeros(n, dtype=bool)
    if top >= 1.0:
        keep[:] = True
    else:
        k = max(int(math.floor(n * top)), 2)
        order = np.argsort(-p)
        keep[order[:k]] = True
        keep[order[-k:]] = True
    # 预测为 NaN 的行 = 不在本次模型/标的池覆盖范围内 → 绝对不能建仓
    # （否则"没预测"会被当成"预测等于中位数"，凭空产生仓位与换手成本）
    keep &= finite

    if mode == "sign":
        w = np.sign(p - np.median(p))
    else:
        w = p - np.mean(p[keep]) if keep.any() else p - p.mean()
    w = np.where(keep, w, 0.0)

    # 单币上限：防止某个极端预测把整个组合押在一个币上
    absw = np.abs(w)
    if absw.max() > 0:
        scale0 = gross / absw.sum()
        w = w * scale0
        if cap > 0:
            w = np.clip(w, -cap, cap)
    s = np.abs(w).sum()
    if s > 0:
        w = w * (gross / s)
    return w


def _positions_at_rebalance(ts, sid, cfg):
    """挑出再平衡时刻（每 H bar 一次）。

    做法：按时间戳排序后，以「全局时间格」为单位每 H 格取一格。
    这样既保证不重叠，也保证所有币种在同一格上统一换仓。
    """
    H = int(cfg["holding"])
    uniq = np.unique(ts)
    if len(uniq) <= H:
        return np.array([], dtype=np.int64)
    chosen = uniq[::H]
    return chosen


def simulate(pred, ds, cfg) -> dict:
    """对一整个样本集跑净成本组合模拟。

    pred : (N,) 每行的预测分数（与 ds 行对齐；非交易行可给 NaN）
    ds   : nlkit.data.load_dataset() 的返回
    cfg  : holding(H bar) / topFrac / gross / maxWeight / feeSide / slipSide / weighting
    """
    fwd_all = ds["fwd"]
    fwd_pnl = ds["meta"].get("fwdPnl", [1, 2, 4, 8, 12, 24])
    H = int(cfg["holding"])
    if H not in fwd_pnl:
        # 取不超过 H 的最大可用视野
        cand = [h for h in fwd_pnl if h <= H]
        if not cand:
            raise ValueError(f"holding={H} 小于最小可用视野 {fwd_pnl}")
        j = fwd_pnl.index(max(cand))
    else:
        j = fwd_pnl.index(H)
    fs = fwd_all[:, j].astype(float)

    ts = ds["ts"]
    sid = ds["sid"]
    frrow = ds["frrow"].astype(float)

    fee = float(cfg.get("feeSide", DEFAULT_FEE_SIDE))
    slip = float(cfg.get("slipSide", DEFAULT_SLIP_SIDE))
    cost_per_side = fee + slip
    charge_funding = bool(cfg.get("chargeFunding", True))

    rebal = _positions_at_rebalance(ts, sid, cfg)
    if len(rebal) == 0:
        return {"ok": False, "reason": "再平衡次数为 0"}

    by_ts: dict[int, np.ndarray] = {}
    order = np.argsort(ts, kind="stable")
    start = 0
    while start < len(order):
        end = start
        while end + 1 < len(order) and ts[order[end + 1]] == ts[order[start]]:
            end += 1
        by_ts[int(ts[order[start]])] = order[start:end + 1]
        start = end + 1

    prev_w: dict[int, float] = {}
    periods: list[float] = []
    gross_list: list[float] = []
    turn_list: list[float] = []
    fund_list: list[float] = []
    n_names: list[int] = []
    trade_ts: list[int] = []

    hours_per_period = H * BARS_PER_HOUR
    for t in rebal:
        idx = by_ts.get(int(t))
        if idx is None or len(idx) < 4:
            continue
        p = pred[idx]
        if not np.any(np.isfinite(p)):
            continue
        w = _weights_from_pred(p, cfg)
        if not np.any(w):
            continue
        f = fs[idx]
        okf = np.isfinite(f)
        if okf.sum() < 4:
            continue
        w = w * okf
        if np.abs(w).sum() <= 0:
            continue

        gross_ret = float(np.sum(w * np.nan_to_num(f, nan=0.0)))

        # 换手：与上一期权重的 L1 距离（新进/离场都算一次交易）
        cur_w = {}
        for k, s_ in zip(sid[idx], w):
            if s_ != 0:
                cur_w[int(k)] = float(s_)
        allk = set(cur_w) | set(prev_w)
        turnover = float(sum(abs(cur_w.get(k, 0.0) - prev_w.get(k, 0.0)) for k in allk))
        tc = turnover * cost_per_side

        fc = 0.0
        if charge_funding:
            frs = frrow[idx]
            # 资金费：多头付正费率；空头收正费率。每 8 小时一次。
            n_events = hours_per_period / 8.0
            fc = float(np.sum(w * np.nan_to_num(frs, nan=0.0))) * n_events

        net = gross_ret - tc - fc
        periods.append(net)
        gross_list.append(gross_ret)
        turn_list.append(turnover)
        fund_list.append(fc)
        n_names.append(int(np.count_nonzero(w)))
        trade_ts.append(int(t))
        prev_w = cur_w

    if len(periods) < 30:
        return {"ok": False, "reason": f"有效期数仅 {len(periods)}"}

    r = np.array(periods)
    rg = np.array(gross_list)
    periods_per_year = (365.0 * 24.0 / hours_per_period)
    equity = np.cumprod(1.0 + r)

    m = {
        "ok": True,
        "nPeriods": int(len(r)),
        "hoursPerPeriod": hours_per_period,
        # 净收益
        "netMeanBp": round(float(r.mean()) * 1e4, 3),
        "netSharpe": round(stats.sharpe(r, periods_per_year), 3),
        "netSortino": round(stats.sortino(r, periods_per_year), 3),
        "netTotal": round(float(equity[-1] - 1.0), 4),
        "netMaxDD": round(stats.max_drawdown(equity), 4),
        "netHitRate": round(float((r > 0).mean()), 4),
        "netT": round(stats.newey_west_t(r, max_lag=min(5, max(len(r) // 10, 1))) or 0.0, 3),
        # 毛收益（用于拆解：edge 有多少，成本吃掉多少）
        "grossMeanBp": round(float(rg.mean()) * 1e4, 3),
        "grossSharpe": round(stats.sharpe(rg, periods_per_year), 3),
        # 成本
        "costMeanBp": round(float((rg - r).mean()) * 1e4, 3),
        "avgTurnover": round(float(np.mean(turn_list)), 4),
        "avgFundingBp": round(float(np.mean(fund_list)) * 1e4, 3),
        "avgNames": round(float(np.mean(n_names)), 2),
    }
    # 盈亏平衡成本：毛 bp / 每期换手 → 每次往返能承受多少"单边成本"
    m["breakevenCostPerSide"] = (
        round(float(rg.mean()) / float(np.mean(turn_list)), 8)
        if m["avgTurnover"] > 0 and rg.mean() > 0 else None
    )
    m["breakevenMultiple"] = (
        round(float(rg.mean()) / float((rg - r).mean()), 3)
        if (rg - r).mean() > 0 else None
    )
    m["_periods"] = r
    m["_gross"] = rg
    m["_equity"] = equity
    m["_ts"] = np.array(trade_ts)
    return m


def market_series(ds, holding: int) -> dict:
    """每个换仓格上的「市场等权收益」：横截面所有币种前瞻收益的均值。

    这是判断一条净值曲线到底是 alpha 还是 beta 的基准。已实测的真实案例：
    做多高 ATR / 做空低 ATR 在样本内净 +21bp、Sharpe 1.46，看起来像策略；
    但它与市场等权收益相关性 0.610，上涨期 +177bp、下跌期 −135bp——
    它只是"多高波动币、空低波动币"的 beta 暴露，下一个下跌段就会还回去。
    """
    fwd_pnl = ds["meta"].get("fwdPnl", [1, 2, 4, 8, 12, 24])
    cand = [h for h in fwd_pnl if h <= holding]
    j = fwd_pnl.index(max(cand)) if cand else 0
    fs = ds["fwd"][:, j].astype(float)
    ts = ds["ts"]
    uniq = np.unique(ts)
    rebal = uniq[::holding]
    out = {}
    for t in rebal:
        v = fs[ts == t]
        v = v[np.isfinite(v)]
        if len(v) >= 5:
            out[int(t)] = float(v.mean())
    return out


def beta_decompose(res: dict, mkt: dict) -> dict:
    """把净值拆成 alpha + beta × 市场。返回相关性和回归截距（真正的 alpha）。"""
    if not res.get("ok"):
        return {"beta": None, "corr": None, "alphaBp": None}
    pr = np.asarray(res["_periods"], dtype=float)
    pts = np.asarray(res["_ts"], dtype=np.int64)
    mv = np.array([mkt.get(int(t), np.nan) for t in pts], dtype=float)
    ok = np.isfinite(mv)
    if ok.sum() < 20 or np.std(mv[ok]) <= 0:
        return {"beta": None, "corr": None, "alphaBp": None, "n": int(ok.sum())}
    x, yv = mv[ok], pr[ok]
    beta, alpha = np.polyfit(x, yv, 1)
    corr = float(np.corrcoef(x, yv)[0, 1])
    return {"beta": round(float(beta), 3), "corr": round(corr, 3),
            "alphaBp": round(float(alpha) * 1e4, 3), "n": int(ok.sum()),
            "upBp": round(float(yv[x > 0].mean()) * 1e4, 2) if (x > 0).any() else None,
            "downBp": round(float(yv[x <= 0].mean()) * 1e4, 2) if (x <= 0).any() else None}


def benchmark_long_only(ds, cfg) -> dict:
    """买入持有基准：等权多头、不再平衡。用来判断策略是否只是"跟着市场涨"。"""
    fwd_pnl = ds["meta"].get("fwdPnl", [1, 2, 4, 8, 12, 24])
    H = int(cfg["holding"])
    cand = [h for h in fwd_pnl if h <= H]
    j = fwd_pnl.index(max(cand)) if cand else 0
    ts = ds["ts"]
    fs = ds["fwd"][:, j].astype(float)
    uniq = np.unique(ts)
    rebal = uniq[::H]
    r = []
    for t in rebal:
        m = ts == t
        v = fs[m]
        v = v[np.isfinite(v)]
        if len(v) >= 4:
            r.append(float(v.mean()))
    if len(r) < 30:
        return {"ok": False}
    r = np.array(r)
    ppy = 365.0 * 24.0 / (H * BARS_PER_HOUR)
    return {"ok": True, "meanBp": round(float(r.mean()) * 1e4, 3),
            "sharpe": round(stats.sharpe(r, ppy), 3),
            "total": round(float(np.cumprod(1 + r)[-1] - 1), 4)}


def random_control(pred_shape, ds, cfg, seed: int = 11, n: int = 20) -> dict:
    """随机信号对照：同口径跑 n 次随机排序，返回净收益分布。
    任何"策略"必须先证明自己显著好于这个分布，否则它只是换了个说法的噪声。"""
    rng = np.random.default_rng(seed)
    means = []
    sharpes = []
    for _ in range(n):
        p = rng.standard_normal(pred_shape)
        res = simulate(p, ds, cfg)
        if res.get("ok"):
            means.append(res["netMeanBp"])
            sharpes.append(res["netSharpe"])
    if not means:
        return {"ok": False}
    means = np.array(means)
    return {"ok": True, "n": len(means),
            "meanBp": round(float(means.mean()), 3),
            "sdBp": round(float(means.std(ddof=1)), 3) if len(means) > 1 else 0.0,
            "p95Bp": round(float(np.percentile(means, 95)), 3),
            "sharpeMean": round(float(np.mean(sharpes)), 3)}
