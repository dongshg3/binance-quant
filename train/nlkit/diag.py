#!/usr/bin/env python3
# ============================================================
# nlkit/diag.py · 特征级诊断：信号到底在哪、有多少、值不值得交易
# ------------------------------------------------------------
# 当"模型赚不到钱"时，必须先分清两种情况：
#   A. 特征里根本没有信息        → 换模型没用，必须换特征/换标的/换周期
#   B. 特征里有信息但没被提取    → 换模型（非线性/门控）有意义
# 用错药方会浪费掉整个自动迭代的算力。本模块用四个诊断回答它：
#   1. 每个特征单独的横截面 IC（含 Newey-West t）—— 逐个排查，不靠模型
#   2. IC 按市场状态分桶（ADX/波动率分位）—— 检验"状态门控"该不该做
#   3. IC 衰减曲线（对未来 1/2/4/8/12/24 bar）—— 检验持有期该怎么定
#   4. 理论收益上限：完美排序每期能赚多少 bp，对比真实成本—— 判断这条路值不值得走
# ============================================================
from __future__ import annotations

import json
import sys
import os

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from nlkit import cv, data, pnl, stats  # noqa: E402


def per_feature_ic(ds, horizon: int = 8, mask: np.ndarray | None = None) -> list[dict]:
    """逐特征横截面 IC + NW t。horizon 指定用哪个前瞻收益作标签（原始收益，不做中性化）。"""
    names = ds["meta"]["featureNames"]
    fwd_pnl = ds["meta"]["fwdPnl"]
    j = fwd_pnl.index(horizon) if horizon in fwd_pnl else 0
    # 用真实前瞻收益、并做横截面去均值（与模型预测目标同构，但保留原始量纲）
    f = np.asarray(ds["fwd"][:, j], dtype=float)
    ts = np.asarray(ds["ts"])
    y = _xs_demean(f, ts)
    X = np.asarray(ds["Fxs"], dtype=float)
    keep = np.isfinite(y)
    if mask is not None:
        keep &= mask
    out = []
    for k, nm in enumerate(names):
        col = X[:, k]
        ok = keep & np.isfinite(col)
        if ok.sum() < 3000:
            out.append({"name": nm, "ic": None, "nwt": None, "n": int(ok.sum())})
            continue
        ic, nb, series = stats.cross_sectional_ic(col[ok], y[ok], ts[ok])
        nwt = stats.newey_west_t(series)
        out.append({"name": nm, "ic": None if ic is None else round(float(ic), 4),
                    "nwt": None if nwt is None else round(float(nwt), 2),
                    "buckets": nb, "n": int(ok.sum())})
    out.sort(key=lambda r: abs(r["ic"] or 0.0), reverse=True)
    return out


def _xs_demean(v: np.ndarray, ts: np.ndarray) -> np.ndarray:
    out = np.full(len(v), np.nan)
    order = np.argsort(ts, kind="stable")
    start = 0
    while start < len(order):
        end = start
        while end + 1 < len(order) and ts[order[end + 1]] == ts[order[start]]:
            end += 1
        idx = order[start:end + 1]
        x = v[idx]
        m = np.isfinite(x)
        if m.sum() >= 3:
            out[idx[m]] = x[m] - x[m].mean()
        start = end + 1
    return out


def ic_by_regime(ds, feature: str, horizon: int = 8, n_buckets: int = 3) -> list[dict]:
    """按状态分桶看某个特征的 IC —— 用来判断状态门控值不值得做。"""
    names = ds["meta"]["featureNames"]
    if feature not in names:
        return []
    k = names.index(feature)
    fwd_pnl = ds["meta"]["fwdPnl"]
    j = fwd_pnl.index(horizon) if horizon in fwd_pnl else 0
    ts = np.asarray(ds["ts"])
    y = _xs_demean(np.asarray(ds["fwd"][:, j], dtype=float), ts)
    col = np.asarray(ds["Fxs"], dtype=float)[:, k]
    regime = np.asarray(ds["regime"], dtype=float)
    rnames = ds["meta"]["regimeNames"]
    rows = []
    for ri, rn in enumerate(rnames):
        r = regime[:, ri]
        fin = np.isfinite(r)
        if fin.sum() < 5000:
            continue
        edges = np.unique(np.percentile(r[fin], np.linspace(0, 100, n_buckets + 1)[1:-1]))
        b = np.digitize(r, edges)
        for bi in range(len(edges) + 1):
            m = (b == bi) & np.isfinite(y) & np.isfinite(col)
            if m.sum() < 2000:
                continue
            ic, nb, series = stats.cross_sectional_ic(col[m], y[m], ts[m])
            nwt = stats.newey_west_t(series)
            rows.append({"regime": rn, "bucket": bi, "n": int(m.sum()),
                         "ic": None if ic is None else round(float(ic), 4),
                         "nwt": None if nwt is None else round(float(nwt), 2)})
    return rows


def ic_decay(ds, feature: str) -> list[dict]:
    """该特征对不同未来视野的 IC —— 直接决定持有期该选多长。"""
    names = ds["meta"]["featureNames"]
    if feature not in names:
        return []
    k = names.index(feature)
    ts = np.asarray(ds["ts"])
    col = np.asarray(ds["Fxs"], dtype=float)[:, k]
    rows = []
    for j, h in enumerate(ds["meta"]["fwdPnl"]):
        y = _xs_demean(np.asarray(ds["fwd"][:, j], dtype=float), ts)
        ok = np.isfinite(y) & np.isfinite(col)
        if ok.sum() < 3000:
            continue
        ic, nb, series = stats.cross_sectional_ic(col[ok], y[ok], ts[ok])
        nwt = stats.newey_west_t(series)
        rows.append({"horizon": h, "ic": None if ic is None else round(float(ic), 4),
                     "nwt": None if nwt is None else round(float(nwt), 2)})
    return rows


def theoretical_ceiling(ds, horizon: int = 8, top_frac: float = 0.2) -> dict:
    """完美排序下的毛收益上限（同 PnL 口径），以及真实成本线。

    这个数字回答的是：「这条路值不值得继续投算力」。
    若上限都低于成本，任何模型改进都是徒劳。
    """
    fwd_pnl = ds["meta"]["fwdPnl"]
    j = fwd_pnl.index(horizon) if horizon in fwd_pnl else 0
    f = np.asarray(ds["fwd"][:, j], dtype=float)
    ts = np.asarray(ds["ts"])
    sid = np.asarray(ds["sid"])
    uniq = np.unique(ts)
    rebal = uniq[::horizon]
    rets = []
    for t in rebal:
        m = ts == t
        v = f[m]
        if np.isfinite(v).sum() < 10:
            continue
        order = np.argsort(-np.nan_to_num(v, nan=-1e9))
        k = max(1, int(np.isfinite(v).sum() * top_frac))
        long_v = v[order[:k]]
        short_v = v[order[-k:]]
        w = np.concatenate([np.full(k, 1.0 / (2 * k)), np.full(k, -1.0 / (2 * k))])
        r = np.concatenate([long_v, short_v])
        ok = np.isfinite(r)
        if ok.sum() < 2:
            continue
        rets.append(float(np.sum(w[ok] * r[ok])))
    if len(rets) < 30:
        return {"ok": False}
    r = np.array(rets)
    cost = (2.0 * top_frac * 2) * (pnl.DEFAULT_FEE_SIDE + pnl.DEFAULT_SLIP_SIDE)
    return {"ok": True, "nPeriods": len(r),
            "grossMeanBp": round(float(r.mean()) * 1e4, 3),
            "grossSharpe": round(stats.sharpe(r, 365 * 24 / horizon), 3),
            "approxCostBp": round(cost * 1e4, 3),
            "netOfCostBp": round((float(r.mean()) - cost) * 1e4, 3)}


def main(mode: str = "all"):
    ds = data.load_dataset()
    print(f"[diag] 样本 {len(ds['y'])} / 币种 {ds['meta']['nSymbols']} / 特征 {ds['meta']['nFeatures']}")

    if mode in ("all", "feature"):
        print("\n=== 1. 逐特征横截面 IC（对 8 bar 前瞻收益）===")
        rows = per_feature_ic(ds, horizon=8)
        print(f"{'特征':14s} {'IC':>8s} {'NW t':>7s} {'桶数':>5s}")
        for r in rows[:20]:
            print(f"{r['name']:14s} {str(r['ic']):>8s} {str(r['nwt']):>7s} {str(r.get('buckets')):>5s}")
        n_sig = sum(1 for r in rows if (r["nwt"] or 0) > 2.0)
        n_neg = sum(1 for r in rows if (r["nwt"] or 0) < -2.0)
        print(f"→ |NW t| > 2 的特征: 正 {n_sig} 个 / 负 {n_neg} 个（共 {len(rows)} 个）")

    if mode in ("all", "regime"):
        print("\n=== 2. 状态分桶 IC（检验状态门控值不值得做）===")
        for feat in ("g_trend", "g_momentum", "ret24", "g_volatility"):
            rows = ic_by_regime(ds, feat)
            if not rows:
                continue
            print(f"-- {feat}")
            for r in rows:
                print(f"   {r['regime']:10s} 桶{r['bucket']} n={r['n']:7d} IC={r['ic']} NWt={r['nwt']}")

    if mode in ("all", "decay"):
        print("\n=== 3. IC 衰减（决定持有期）===")
        for feat in ("g_trend", "g_momentum", "ret4", "ret24", "er"):
            rows = ic_decay(ds, feat)
            if not rows:
                continue
            s = " ".join(f"h{r['horizon']}:{r['ic']}" for r in rows)
            print(f"   {feat:12s} {s}")

    if mode in ("all", "ceiling"):
        print("\n=== 4. 理论收益上限 vs 成本（判断这条路值不值得走）===")
        for h in (4, 8, 12, 24):
            for tf in (0.1, 0.2):
                c = theoretical_ceiling(ds, horizon=h, top_frac=tf)
                if c.get("ok"):
                    print(f"   H={h:2d} topFrac={tf}: 完美排序毛 {c['grossMeanBp']:8.2f}bp "
                          f"Sharpe {c['grossSharpe']:7.2f} 估算成本 {c['approxCostBp']:6.2f}bp "
                          f"净 {c['netOfCostBp']:8.2f}bp")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "all")
