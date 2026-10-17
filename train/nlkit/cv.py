#!/usr/bin/env python3
# ============================================================
# nlkit/cv.py · Purged Walk-Forward 交叉验证 + 综合评分
# ------------------------------------------------------------
# 为什么不能用随机 K 折：本任务标签用了未来 2/4/8 bar 的收益，相邻样本高度重叠，
# 随机切分会让"未来的信息"漏进训练集，IC 直接虚高一个量级（原档案里 v1–v6 的
# IC 0.36~0.42 就是这个错误的产物，randomIC.percentile 甚至等于 1.0）。
#
# 本模块的做法：
#   时间序切分（expanding window） + embargo 挖空：
#     fold k 的训练集 = { ts < test_start_k − embargo }，测试集 = [test_start_k, test_end_k)
#   测试块在时间上首尾相接，OOS 预测拼成一条连续序列 → 可直接喂给 pnl.simulate()
#
# 评分同时给出两套互不替代的指标：
#   IC 侧    : 横截面 IC、Newey-West t（选币能力，与原管线口径一致，可对比）
#   PnL 侧   : 净成本每期均值、净 Sharpe、最大回撤、盈亏平衡成本（能不能赚钱）
# 再加多重检验修正：Deflated Sharpe（按累计试错次数惩罚）。
# ============================================================
from __future__ import annotations

import time

import numpy as np

from . import models, pnl, stats


def time_grid(ds) -> tuple[np.ndarray, float]:
    """返回 (唯一时间戳升序数组, 每 bar 毫秒数)。"""
    ts = np.asarray(ds["ts"])
    uniq = np.unique(ts)
    if len(uniq) > 2:
        bar_ms = float(np.median(np.diff(uniq)))
    else:
        bar_ms = 3_600_000.0
    return uniq, bar_ms


def fold_bounds(ds, n_folds: int = 5, oos_frac: float = 0.5, embargo_bars: int = 200):
    """把时间轴最后 oos_frac 的部分切成 n_folds 个连续测试块，并给出每块的训练截止时刻。"""
    uniq, bar_ms = time_grid(ds)
    if len(uniq) < 200:
        raise ValueError("时间戳太少，无法做 walk-forward")
    start_i = int(len(uniq) * (1.0 - oos_frac))
    start_i = max(start_i, int(len(uniq) * 0.25))
    edges = np.linspace(start_i, len(uniq), n_folds + 1).astype(int)
    emb_ms = embargo_bars * bar_ms
    folds = []
    for k in range(n_folds):
        lo, hi = edges[k], edges[k + 1]
        if hi - lo < 20:
            continue
        t_lo = float(uniq[lo])
        t_hi = float(uniq[hi - 1])
        folds.append({"k": k, "testStart": t_lo, "testEnd": t_hi,
                      "trainEnd": t_lo - emb_ms, "barMs": bar_ms})
    return folds, bar_ms


def run_cv(ds, spec: dict, n_folds: int = 5, oos_frac: float = 0.5,
           embargo_bars: int = 200, seed: int = 7, max_train_rows: int | None = None,
           verbose: bool = False) -> dict:
    """跑一次 purged walk-forward，返回 OOS 预测与逐折诊断。"""
    t0 = time.time()
    names = ds["meta"]["featureNames"]
    batch = spec.get("featureBatch", "all")
    cols = models.columns_for(names, batch)

    F = np.asarray(ds["Fxs"], dtype=np.float64)
    X = F[:, cols]
    y = np.asarray(ds["y"], dtype=np.float64)
    ts = np.asarray(ds["ts"])
    regime = np.asarray(ds["regime"], dtype=np.float64)
    rcol = int(spec.get("regimeCol", 0))
    if regime.ndim == 1:
        regime = regime[:, None]
    rcol = min(rcol, regime.shape[1] - 1)
    R = regime[:, rcol]

    folds, _ = fold_bounds(ds, n_folds=n_folds, oos_frac=oos_frac, embargo_bars=embargo_bars)
    umask = universe_mask(ds, str((spec.get("trading") or {}).get("universe", "crypto")))
    oos = np.full(len(y), np.nan)
    fold_info = []
    rng = np.random.default_rng(seed)

    for f in folds:
        tr = (ts < f["trainEnd"]) & np.isfinite(y) & umask
        te = (ts >= f["testStart"]) & (ts <= f["testEnd"]) & umask
        if tr.sum() < 5000 or te.sum() < 500:
            continue
        tr_idx = np.where(tr)[0]
        if max_train_rows and len(tr_idx) > max_train_rows:
            # 只在序列尾部保留最近的样本（时间衰减），而不是随机抽样
            tr_idx = tr_idx[-max_train_rows:]
        Xtr, ytr = X[tr_idx], y[tr_idx]
        Xte = X[te]
        pred = models.fit_predict(spec, Xtr, ytr, Xte,
                                  regime_tr=R[tr_idx], regime_te=R[te], seed=seed + f["k"])
        oos[np.where(te)[0]] = pred
        ic, nb, _ = stats.cross_sectional_ic(pred, y[te], ts[te])
        fold_info.append({"fold": f["k"], "nTrain": int(tr.sum()), "nTest": int(te.sum()),
                          "ic": None if ic is None else round(float(ic), 4), "buckets": nb})

    return {"oos": oos, "folds": fold_info, "nFolds": len(fold_info),
            "elapsed": round(time.time() - t0, 2), "nCols": int(len(cols))}


def score(ds, cv: dict, pnl_cfg: dict, n_trials: int = 1) -> dict:
    """把 OOS 预测折算成"能不能赚钱"的一组数字。

    objective 是搜索里排序用的标量：净 Sharpe，但只在净收益为正时才有意义。
    真正决定"能不能上线"的是 gate 里的每一条，不是 objective 的大小。
    """
    oos = cv["oos"]
    y = np.asarray(ds["y"], dtype=np.float64)
    ts = np.asarray(ds["ts"])
    ok = np.isfinite(oos)

    ic = nw = None
    if ok.sum() >= 3000:
        ic, nb, series = stats.cross_sectional_ic(oos[ok], y[ok], ts[ok])
        nw = stats.newey_west_t(series)
        ic_sb = stats.stationary_bootstrap_t(series)
    else:
        nb, ic_sb = 0, None

    pr = pnl.simulate(oos, ds, pnl_cfg)
    out = {
        "icXS": None if ic is None else round(float(ic), 4),
        "icBuckets": int(nb),
        "icNWt": None if nw is None else round(float(nw), 2),
        "icBootT": None if ic_sb is None else round(float(ic_sb), 2),
        "nOOS": int(ok.sum()),
        "foldIC": [f["ic"] for f in cv["folds"] if f["ic"] is not None],
        "elapsed": cv.get("elapsed"),
        "nCols": cv.get("nCols"),
    }
    if pr.get("ok"):
        for k in ("netMeanBp", "netSharpe", "netSortino", "netTotal", "netMaxDD",
                  "netHitRate", "netT", "grossMeanBp", "grossSharpe", "costMeanBp",
                  "avgTurnover", "avgFundingBp", "avgNames", "nPeriods",
                  "breakevenCostPerSide", "breakevenMultiple"):
            out[k] = pr[k]
        # alpha / beta 分解：把"看起来赚钱"的 beta 暴露与真正的横截面 alpha 分开。
        # 这一步是必须的——实测过一条与市场相关性 0.61 的曲线净 +21bp/期、Sharpe 1.46，
        # 但它下跌期平均 −135bp，是纯粹的 beta 赌注，绝不能被当成策略采纳。
        mkt = pnl.market_series(ds, int(pnl_cfg.get("holding", 8)))
        bd = pnl.beta_decompose(pr, mkt)
        out["mktBeta"] = bd.get("beta")
        out["mktCorr"] = bd.get("corr")
        out["alphaBp"] = bd.get("alphaBp")
        out["upMktBp"] = bd.get("upBp")
        out["downMktBp"] = bd.get("downBp")
        r = pr["_periods"]
        sk = float(((r - r.mean()) ** 3).mean() / (r.std() ** 3 + 1e-12))
        ku = float(((r - r.mean()) ** 4).mean() / (r.std() ** 4 + 1e-12))
        sr_per = float(r.mean() / (r.std(ddof=1) + 1e-12))
        dsr = stats.deflated_sharpe_ratio(sr_per, n_trials, len(r), sk, ku)
        out["srPerPeriod"] = round(sr_per, 5)
        out["dsr"] = dsr["dsr"]
        out["eMaxSR"] = dsr["eMaxSR"]
        out["objective"] = float(pr["netSharpe"])
    else:
        out["objective"] = -99.0
        out["pnlError"] = pr.get("reason", "unknown")
        out["dsr"] = None
    return out


def gate_verdict(m: dict, th: dict) -> tuple[bool, list[str]]:
    """采纳闸门：任何一条不过就不采纳。宁可继续用静态权重，也不发布一个被搜出来的幻觉。"""
    reasons = []
    if m.get("icXS") is None:
        return False, ["无有效 IC"]
    if m["icXS"] < th.get("minIC", 0.015):
        reasons.append(f"XS IC {m['icXS']} < {th.get('minIC', 0.015)}")
    if (m.get("icNWt") or 0) < th.get("minICt", 2.0):
        reasons.append(f"IC NW t {m.get('icNWt')} < {th.get('minICt', 2.0)}")
    if (m.get("netMeanBp") or -1) <= th.get("minNetBp", 0.0):
        reasons.append(f"净每期 {m.get('netMeanBp')}bp <= {th.get('minNetBp', 0.0)}")
    if (m.get("netSharpe") or -99) < th.get("minSharpe", 1.0):
        reasons.append(f"净 Sharpe {m.get('netSharpe')} < {th.get('minSharpe', 1.0)}")
    if (m.get("netT") or 0) < th.get("minNetT", 2.0):
        reasons.append(f"净收益 NW t {m.get('netT')} < {th.get('minNetT', 2.0)}")
    if m.get("dsr") is not None and m["dsr"] < th.get("minDSR", 0.95):
        reasons.append(f"Deflated Sharpe {m['dsr']} < {th.get('minDSR', 0.95)}")
    if m.get("avgTurnover") is not None and m["avgTurnover"] > th.get("maxTurnover", 6.0):
        reasons.append(f"换手 {m['avgTurnover']} > {th.get('maxTurnover', 6.0)}")
    # ---- beta 中性硬闸门（本轮实测教训的直接产物）----
    # 做多高 ATR / 做空低 ATR 在样本内净 +21bp、Sharpe 1.46、DSR 看着也漂亮，
    # 但它与市场等权收益相关性 0.610、下跌期平均 −135bp —— 那是一个 beta 赌注。
    # 自动迭代若没有这道闸门，一定会在某个上涨样本里把它加冕成"冠军"，
    # 然后在下一次下跌里把本金还回去。所以：先证明与市场无关，再谈收益。
    beta = m.get("mktBeta")
    if beta is not None and abs(beta) > th.get("maxAbsBeta", 0.25):
        reasons.append(f"市场 beta {beta} 超出中性范围 ±{th.get('maxAbsBeta', 0.25)}（是 beta 暴露不是 alpha）")
    if m.get("alphaBp") is not None and m["alphaBp"] <= th.get("minAlphaBp", 0.0):
        reasons.append(f"回归 alpha {m['alphaBp']}bp <= {th.get('minAlphaBp', 0.0)}")
    if m.get("downMktBp") is not None and m["downMktBp"] <= th.get("minDownBp", -20.0):
        reasons.append(f"市场下跌期平均 {m['downMktBp']}bp ≤ {th.get('minDownBp', -20.0)}（下跌段会亏回去）")
    # 成本敏感性：盈亏平衡的单边成本必须比真实成本高出一截才算有安全边际
    be = m.get("breakevenCostPerSide")
    if be is not None:
        need = th.get("minCostMargin", 1.5) * (pnl.DEFAULT_FEE_SIDE + pnl.DEFAULT_SLIP_SIDE)
        if be < need:
            reasons.append(f"盈亏平衡单边成本 {be:.6f} < 所需 {need:.6f}（安全边际不足）")
    return (len(reasons) == 0), reasons


def default_pnl_cfg(holding: int = 8, **over) -> dict:
    cfg = {"holding": holding, "topFrac": 0.4, "gross": 1.0, "maxWeight": 0.15,
           "weighting": "demean", "feeSide": pnl.DEFAULT_FEE_SIDE,
           "slipSide": pnl.DEFAULT_SLIP_SIDE, "chargeFunding": True}
    cfg.update(over)
    return cfg


# ---------------- 标的池过滤 ----------------
# 把「不是同一类东西」的合约混在一个横截面模型里，是原档案点名过的伪 IC 来源：
#   · 代币化股票（CRCLBUSDT / NVDABUSDT / QQQBUSDT…）走的是美股时段与美股 beta，
#     在 7×24 的加密横截面里它不是同一个资产类；
#   · 黄金/欧元（PAXG / XAUT / EURUSDT）是锚定资产，因子信号近似噪声，
#     交易它只会稳定付出手续费（原档案：RLUSD/U 上每笔净亏 0.14%）。
PEGGED_BASES = {"PAXG", "XAUT", "EUR", "RLUSD", "BFUSD", "XUSD", "USDC", "FDUSD", "DAI", "USDP"}


def _is_tokenized_stock(base: str) -> bool:
    """代币化股票/指数合约的命名特征：基础资产以 B 结尾且长度 ≥ 4（CRCLB/NVDAB/QQQB…）。"""
    return len(base) >= 4 and base.endswith("B")


def base_of(symbol: str) -> str:
    return symbol[:-4] if symbol.endswith("USDT") else symbol


def universe_mask(ds, mode: str = "crypto") -> np.ndarray:
    """返回逐行布尔掩码。mode: all | liquid | crypto。"""
    syms = ds["meta"]["symbols"]
    sid = np.asarray(ds["sid"])
    keep = np.ones(len(syms), dtype=bool)
    if mode in ("crypto", "liquid"):
        for i, s in enumerate(syms):
            b = base_of(s)
            if b in PEGGED_BASES or _is_tokenized_stock(b):
                keep[i] = False
    if mode == "liquid":
        # 只留前 25 大（按样本量排名近似流动性）
        cnt = np.bincount(sid, minlength=len(syms))
        order = np.argsort(-cnt)
        top = set(order[:25].tolist())
        for i in range(len(syms)):
            if i not in top:
                keep[i] = False
    return keep[sid]


def pnl_cfg_from_spec(spec: dict, base_holding: int = 8) -> dict:
    """从搜索配置里取出交易参数（持有期/分位/敞口/标池/成本档），构成 PnL 口径。"""
    t = spec.get("trading", {}) or {}
    tier = str(t.get("costTier", "taker"))
    if tier == "maker":
        fee, slip = 0.0002, 0.00005     # 挂单成交（post-only）：费率低、但需要等待成交
    else:
        fee, slip = pnl.DEFAULT_FEE_SIDE, pnl.DEFAULT_SLIP_SIDE
    return default_pnl_cfg(
        holding=int(t.get("holding", base_holding)),
        topFrac=float(t.get("topFrac", 0.4)),
        gross=float(t.get("gross", 1.0)),
        maxWeight=float(t.get("maxWeight", 0.15)),
        weighting=str(t.get("weighting", "demean")),
        feeSide=fee, slipSide=slip,
    )


DEFAULT_THRESHOLDS = {
    "minIC": 0.015, "minICt": 2.0,
    "minNetBp": 0.0, "minSharpe": 1.0, "minNetT": 2.0,
    "minDSR": 0.95, "maxTurnover": 6.0, "minCostMargin": 1.5,
    # beta 中性硬约束（见 gate_verdict 里的说明）
    "maxAbsBeta": 0.25, "minAlphaBp": 0.0, "minDownBp": -20.0,
}
