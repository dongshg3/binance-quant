#!/usr/bin/env python3
# diagnose.py · IC 泄漏排查：混合IC vs 横截面IC vs 单币种IC + embargo 影响
# 一次性诊断脚本，不进工作流。
import math
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from train import group_scores, spearman, get_symbols, get_klines, GROUPS, RIDGE_LAMBDA, FWD  # noqa

TOP = int(os.environ.get("TQ_TOP_N", "30"))
EMBARGO = 200  # 最大指标回看窗口（EMA200）

def spearman5(x, y):
    """横截面小桶专用：样本 ≥5 即计算（train.spearman 的 30 阈值会把小时间桶整体归零）"""
    x = np.asarray(x); y = np.asarray(y)
    mask = ~(np.isnan(x) | np.isnan(y))
    x, y = x[mask], y[mask]
    if len(x) < 5:
        return None
    rx = np.argsort(np.argsort(x)).astype(float)
    ry = np.argsort(np.argsort(y)).astype(float)
    rx -= rx.mean(); ry -= ry.mean()
    denom = np.sqrt((rx ** 2).sum() * (ry ** 2).sum())
    return float((rx * ry).sum() / denom) if denom > 0 else None

def main():
    symbols = get_symbols()[:TOP]
    print(f"[diag] {len(symbols)} 个币种")
    data = []
    for sym in symbols:
        try:
            ohlcv = get_klines(sym)
            ohlcv = ohlcv[:-1]  # 丢弃未收盘的实时 bar
            if len(ohlcv) < 500:
                continue
            gs = group_scores(ohlcv)
            c = ohlcv[:, 4]; t0 = ohlcv[:, 0]; n = len(c)
            X, y, tt, ts = [], [], [], []
            for i in range(200, n - FWD):
                X.append([gs[g][i] for g in GROUPS])
                y.append(math.log(c[i + FWD] / c[i]))
                tt.append(i); ts.append(t0[i])
            data.append((sym, np.array(X), np.array(y), np.array(tt), np.array(ts)))
            time.sleep(0.12)
        except Exception as e:
            print(f"[diag] {sym} 失败: {e}")

    X = np.concatenate([d[1] for d in data])
    y = np.concatenate([d[2] for d in data])
    tt = np.concatenate([d[3] for d in data])
    ts = np.concatenate([d[4] for d in data])
    print(f"[diag] 样本 {len(y)}")

    # ---- 训练（统一在 t<700 上拟合）----
    tr = tt < 700
    mu = X[tr].mean(axis=0); sd = X[tr].std(axis=0); sd[sd == 0] = 1
    Z = (X - mu) / sd
    d = len(GROUPS)
    w = np.linalg.solve(Z[tr].T @ Z[tr] + RIDGE_LAMBDA * np.eye(d), Z[tr].T @ y[tr])
    pred = Z @ w

    def report(name, mask):
        p_, y_ = pred[mask], y[mask]
        if len(y_) < 100:
            print(f"{name}: 样本不足"); return None
        # 1) 混合 IC（当前做法，虚高源头）
        pooled = spearman(p_, y_)
        # 2) 横截面 IC：每个时间戳内对币种排序，取平均（行业标准做法）
        buckets = {}
        for i in range(len(y_)):
            buckets.setdefault(int(ts[mask][i]), []).append(i)
        xs_ics = [v for v in (spearman5(p_[idx], y_[idx]) for idx in buckets.values() if len(idx) >= 5) if v is not None]
        xs = float(np.mean(xs_ics)) if xs_ics else float('nan')
        # 3) 单币种时间序列 IC 取平均
        print(f"{name}: 混合IC {pooled:.4f} | 横截面IC {xs:.4f} | 时间桶数 {len(xs_ics)}")
        return pooled, xs

    print("\n== 无 embargo（当前做法：测试集紧跟训练集）==")
    te = tt >= 700
    report("OOS[t>=700]", te)

    print("\n== embargo 200（挖掉缓冲区，Purged）==")
    te2 = tt >= 700 + EMBARGO
    report(f"OOS[t>=900]", te2)

    print("\n== 样本内对照 ==")
    report("In-sample[t<700]", tr)

    # ---- 单币种 IC 分布（OOS, embargo）----
    print("\n== 单币种 OOS IC 分布（embargo 后）==")
    ics = []
    for sym, Xs, ys, tts, tss in data:
        m = tts >= 700 + EMBARGO
        if m.sum() < 50:
            continue
        mu_s = Xs[tts < 700].mean(axis=0); sd_s = Xs[tts < 700].std(axis=0); sd_s[sd_s == 0] = 1
        w_s = np.linalg.solve(((Xs[tts < 700] - mu_s) / sd_s).T @ ((Xs[tts < 700] - mu_s) / sd_s) + RIDGE_LAMBDA * np.eye(d),
                              ((Xs[tts < 700] - mu_s) / sd_s).T @ ys[tts < 700])
        pred_s = ((Xs[m] - mu_s) / sd_s) @ w_s
        ics.append((sym, spearman(pred_s, ys[m])))
    vals = np.array([v for _, v in ics])
    print(f"均值 {vals.mean():.4f} | 中位 {np.median(vals):.4f} | 最差 {vals.min():.4f} | 最好 {vals.max():.4f}")

    # ---- 随机权重对照（OOS, embargo）----
    print("\n== 随机权重对照（200 次，embargo 后 OOS）==")
    rng = np.random.default_rng(42)
    m = te2
    rand_ics = []
    for _ in range(200):
        wr = rng.normal(size=d)
        wr = wr / np.abs(wr).sum() * 0.9
        rand_ics.append(spearman(Z[m] @ wr, y[m]))
    rand_ics = np.array(rand_ics)
    real = spearman(pred[m], y[m])
    pct = float((rand_ics < real).mean())
    print(f"随机IC 均值 {rand_ics.mean():.4f} ± {rand_ics.std():.4f} | 真模型混合IC {real:.4f} | 分位 {pct:.2%}")

if __name__ == "__main__":
    main()
