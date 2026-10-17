#!/usr/bin/env python3
# ============================================================
# nlkit/stats.py · 评估统计量
# ------------------------------------------------------------
# 与原管线 train.py 的口径保持一致（spearman / cross_sectional_ic / newey_west_t），
# 并补上自动搜索场景下**必需**的两件武器：
#   - deflated_sharpe_ratio : 对「我试了 N 个配置」做多重检验惩罚
#   - pbo_cscv              : 回测过拟合概率（组合对称交叉验证）
# 没有这两个，自动迭代的产物 100% 是噪声。
# ============================================================
from __future__ import annotations

import math

import numpy as np

EULER_GAMMA = 0.5772156649015329


# ---------------- 排序相关 ----------------
def spearman(x, y, min_n: int = 30) -> float:
    """Spearman 秩相关。带 NaN 过滤与最小样本门槛。"""
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    mask = ~(np.isnan(x) | np.isnan(y))
    x, y = x[mask], y[mask]
    if len(x) < min_n:
        return 0.0
    rx = np.argsort(np.argsort(x)).astype(float)
    ry = np.argsort(np.argsort(y)).astype(float)
    rx -= rx.mean()
    ry -= ry.mean()
    denom = math.sqrt(float((rx ** 2).sum()) * float((ry ** 2).sum()))
    return float((rx * ry).sum() / denom) if denom > 0 else 0.0


def cross_sectional_ic(pred, y, ts, min_n: int = 5):
    """横截面 IC：每个时间戳内对币种排序求 Spearman 再平均。

    这是「选币能力」的诚实口径——混合 IC 会被跨币种同涨同跌严重虚增。
    返回 (mean_ic, n_buckets, per_bucket_series)。per_bucket 序列用于 NW t 检验。
    """
    pred = np.asarray(pred, dtype=float)
    y = np.asarray(y, dtype=float)
    ts = np.asarray(ts)
    buckets: dict[int, list[int]] = {}
    for k in range(len(y)):
        buckets.setdefault(int(ts[k]), []).append(k)
    sp_min = max(5, min(30, min_n))
    ics = [spearman(pred[idx], y[idx], min_n=sp_min)
           for idx in buckets.values() if len(idx) >= min_n]
    if not ics:
        return None, 0, []
    return float(np.mean(ics)), len(ics), ics


def newey_west_t(series, max_lag: int | None = None) -> float | None:
    """Newey-West (HAC) 调整的均值 t 统计量。

    |t| < 2 ⇒ 无论均值多正都不能声称信息存在。IC 时序自相关会虚增普通 t 值，
    持仓跨多根 bar 时样本高度重叠，必须用这个而不是朴素 t。
    """
    x = np.asarray(series, dtype=float)
    x = x[~np.isnan(x)]
    T = len(x)
    if T < 30:
        return None
    m = float(x.mean())
    u = x - m
    if max_lag is None:
        max_lag = int(math.floor(4 * (T / 100.0) ** (2.0 / 9.0)))
    var = float((u * u).mean())
    for k in range(1, max_lag + 1):
        gk = float((u[k:] * u[:-k]).mean())
        var += 2 * (1 - k / (max_lag + 1)) * gk
    if var <= 0:
        return None
    return float(m / math.sqrt(var / T))


# ---------------- 收益序列指标 ----------------
def sharpe(returns, periods_per_year: float) -> float:
    r = np.asarray(returns, dtype=float)
    r = r[~np.isnan(r)]
    if len(r) < 3:
        return 0.0
    sd = float(r.std(ddof=1))
    if sd <= 0:
        return 0.0
    return float(r.mean() / sd * math.sqrt(periods_per_year))


def sortino(returns, periods_per_year: float) -> float:
    r = np.asarray(returns, dtype=float)
    r = r[~np.isnan(r)]
    if len(r) < 3:
        return 0.0
    downside = r[r < 0]
    dd = float(np.sqrt((downside ** 2).mean())) if len(downside) else 0.0
    if dd <= 0:
        return 0.0
    return float(r.mean() / dd * math.sqrt(periods_per_year))


def max_drawdown(equity) -> float:
    """返回最大回撤（正数，单位与 equity 同为比例）。"""
    e = np.asarray(equity, dtype=float)
    if len(e) == 0:
        return 0.0
    peak = np.maximum.accumulate(e)
    dd = (peak - e) / np.where(peak == 0, 1.0, peak)
    return float(dd.max())


def _norm_ppf(p: float) -> float:
    """标准正态分位函数（Acklam 有理逼近，精度 ~1e-9）。避免依赖 scipy。"""
    if p <= 0.0:
        return -math.inf
    if p >= 1.0:
        return math.inf
    a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
         1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
    b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
         6.680131188771972e+01, -1.328068155288572e+01]
    c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
         -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
    d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
         3.754408661907416e+00]
    plow, phigh = 0.02425, 1 - 0.02425
    if p < plow:
        q = math.sqrt(-2 * math.log(p))
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
               ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    if p > phigh:
        q = math.sqrt(-2 * math.log(1 - p))
        return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
               ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    q = p - 0.5
    r = q * q
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / \
           (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)


def _norm_cdf(z: float) -> float:
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))


def deflated_sharpe_ratio(sr_hat: float, n_trials: int, n_obs: int,
                          skew: float = 0.0, kurt: float = 3.0,
                          sr_variance: float | None = None) -> dict:
    """Deflated Sharpe Ratio（Bailey & López de Prado 2014）。

    问题：搜了 N 个配置取最好的那个，它的 Sharpe 必然被「最大值」抬高了。
    做法：先算 N 次独立试验下 Sharpe 最大值的期望 E[max SR]，再看观测 SR 超出它多少。

    DSR 就是「在考虑了 N 次尝试之后，真实 Sharpe > 0 的概率」。
    DSR < 0.95 ⇒ 这个 Sharpe 用 N 次尝试就能解释掉，不是本事。

    sr_hat        : 观测 Sharpe（按观测频率，未年化）
    n_trials      : 累计尝试过的配置数（含本次），越大惩罚越重
    n_obs         : 收益序列观测数
    sr_variance   : 各次试验 Sharpe 的方差（未提供则保守取 1/n_obs 的一个尺度）
    """
    n_trials = max(int(n_trials), 1)
    if n_obs < 5 or not np.isfinite(sr_hat):
        return {"dsr": None, "eMaxSR": None, "srHat": sr_hat, "nTrials": n_trials}

    if sr_variance is None or not np.isfinite(sr_variance) or sr_variance <= 0:
        # 无试验分布信息时的保守替代：用 SR 估计量自身方差 ~ (1 + sr^2/2)/T
        sr_variance = (1.0 + 0.5 * sr_hat ** 2) / n_obs

    if n_trials == 1:
        e_max = 0.0
    else:
        z1 = _norm_ppf(1.0 - 1.0 / n_trials)
        z2 = _norm_ppf(1.0 - 1.0 / (n_trials * math.e))
        e_max = math.sqrt(sr_variance) * ((1.0 - EULER_GAMMA) * z1 + EULER_GAMMA * z2)

    denom = 1.0 - skew * sr_hat + (kurt - 1.0) / 4.0 * sr_hat ** 2
    if denom <= 0:
        denom = 1.0
    z = (sr_hat - e_max) * math.sqrt(max(n_obs - 1, 1)) / math.sqrt(denom)
    return {"dsr": round(_norm_cdf(z), 4), "eMaxSR": round(e_max, 6),
            "srHat": round(float(sr_hat), 6), "nTrials": n_trials, "z": round(float(z), 4)}


def pbo_cscv(perf_matrix, n_splits: int = 8) -> dict:
    """回测过拟合概率 PBO（组合对称交叉验证，Bailey et al. 2015）。

    perf_matrix : (T, N) 每个配置在 T 个时间片上的收益。必须时间对齐、同一批配置。
    流程：把 T 切成 n_splits 块，枚举 S/2 块作样本内(IS)的所有组合；
          每个组合里选 IS 表现最好的配置，看它在对侧样本外(OOS)的排名；
          排名落在后 50%（对数几率 ≤ 0）即为「过拟合事件」。
    PBO = 过拟合事件占比。经验阈值：PBO < 0.5 才有讨论价值，< 0.3 算稳。
    """
    R = np.asarray(perf_matrix, dtype=float)
    if R.ndim != 2 or R.shape[0] < n_splits * 2 or R.shape[1] < 2:
        return {"pbo": None, "reason": "样本不足"}
    if n_splits % 2 == 1:
        n_splits -= 1
    T, N = R.shape
    bounds = np.linspace(0, T, n_splits + 1).astype(int)
    chunks = [R[bounds[i]:bounds[i + 1]] for i in range(n_splits)]
    if any(len(c) < 2 for c in chunks):
        return {"pbo": None, "reason": "分块过小"}

    from itertools import combinations
    half = n_splits // 2
    logits = []
    for combo in combinations(range(n_splits), half):
        is_idx = set(combo)
        oos_idx = [i for i in range(n_splits) if i not in is_idx]
        is_r = np.concatenate([chunks[i] for i in combo], axis=0)
        oos_r = np.concatenate([chunks[i] for i in oos_idx], axis=0)
        if len(is_r) < 3 or len(oos_r) < 3:
            continue
        is_sr = _sr_per_col(is_r)
        oos_sr = _sr_per_col(oos_r)
        if not np.any(np.isfinite(is_sr)) or not np.any(np.isfinite(oos_sr)):
            continue
        best = int(np.nanargmax(is_sr))
        # 该配置在 OOS 的排名（1=最差, N=最好）
        order = np.argsort(np.argsort(oos_sr))  # 0-based 名次
        rank = int(order[best]) + 1
        w = rank / (N + 1)
        w = min(max(w, 1e-6), 1 - 1e-6)
        logits.append(math.log(w / (1 - w)))
    if not logits:
        return {"pbo": None, "reason": "无有效组合"}
    logits = np.array(logits)
    return {"pbo": round(float((logits <= 0).mean()), 4),
            "nCombos": int(len(logits)),
            "medianLogit": round(float(np.median(logits)), 4)}


def _sr_per_col(R: np.ndarray) -> np.ndarray:
    mu = np.nanmean(R, axis=0)
    sd = np.nanstd(R, axis=0, ddof=1)
    with np.errstate(divide="ignore", invalid="ignore"):
        sr = np.where(sd > 0, mu / sd, np.nan)
    return sr


def paired_bootstrap(diff, n: int = 2000, seed: int = 7) -> dict:
    """配对 bootstrap：P(差 > 0) 与差值均值。用于「候选 vs 现任」的同窗比较。"""
    d = np.asarray(diff, dtype=float)
    d = d[~np.isnan(d)]
    if len(d) < 10:
        return {"meanDiff": None, "pBetter": None, "n": int(len(d))}
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, len(d), size=(n, len(d)))
    means = d[idx].mean(axis=1)
    return {"meanDiff": round(float(d.mean()), 6),
            "pBetter": round(float((means > 0).mean()), 4),
            "n": int(len(d))}


def stationary_bootstrap_t(series, n: int = 2000, seed: int = 7, mean_block: float = 8.0) -> float | None:
    """平稳 bootstrap 下的均值 t 值（对重叠/自相关更稳）。返回 t = mean / se_boot。"""
    x = np.asarray(series, dtype=float)
    x = x[~np.isnan(x)]
    T = len(x)
    if T < 20:
        return None
    rng = np.random.default_rng(seed)
    p = 1.0 / max(mean_block, 1.0)
    means = np.empty(n)
    for b in range(n):
        idx = np.empty(T, dtype=int)
        i = rng.integers(0, T)
        for k in range(T):
            idx[k] = i
            if rng.random() < p:
                i = rng.integers(0, T)
            else:
                i = (i + 1) % T
        means[b] = x[idx].mean()
    se = float(means.std(ddof=1))
    if se <= 0:
        return None
    return float(x.mean() / se)
