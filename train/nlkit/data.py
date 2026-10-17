#!/usr/bin/env python3
# ============================================================
# nlkit/data.py · 特征与标签构建（因果、可缓存、与原管线同口径）
# ------------------------------------------------------------
# 输入：train/cache_drift/{sym}_raw.npz（ohlcv/fr/ls/oi）与 {sym}_feat.npz（8 组得分/sig/adx/c/t0）
# 输出：train/nl_cache/dataset.npz + meta.json
#
# 两条必须守住的纪律：
#   1. 因果性：t 行的每一个特征只用到 ≤ t 的信息。所有滚动窗口都右对齐到 t。
#   2. 横截面标准化：预测目标是「跨币种去均值后的收益」，特征也必须跨币种去均值，
#      否则模型会把「今天全市场涨」当成信号（这是横截面模型最经典的泄漏式错误）。
#
# 与原管线标签的一致性：y = mean_{h∈[2,4,8]} log(c[t+h]/c[t]) / sig[t]，
# 随后按时间戳横截面去均值 + MAD 5 倍截断。保持同口径，才能和现有 IC 数字直接比较。
# ============================================================
from __future__ import annotations

import glob
import json
import math
import os

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
TRAIN_DIR = os.path.dirname(HERE)
SRC_CACHE = os.path.join(TRAIN_DIR, "cache_drift")
OUT_DIR = os.path.join(TRAIN_DIR, "nl_cache")

FWD_HORIZONS = (2, 4, 8)
MAX_H = max(FWD_HORIZONS)
# PnL 模拟用的前瞻对数收益视野（与标签视野分开：标签允许重叠，PnL 必须能选持有期）
FWD_PNL = (1, 2, 4, 8, 12, 24)
MAX_PNL_H = max(FWD_PNL)
WARMUP = 200          # 与原管线 EMBARGO / 指标回看窗口一致
GROUPS = ["trend", "momentum", "meanRev", "volume", "volatility", "position", "htf", "futures"]

# 额外状态特征（与模型输入同源，供状态门控路由使用）
# 注意必须用 "adx_n"（特征矩阵里的真实列名），"adx" 在 featureNames 里不存在，
# 曾因此让 regime 通道静默少了一列，ADX 这个原档案点名的最大边际反而用不上。
REGIME_NAMES = ["adx_n", "vol_ratio", "er"]


# ---------------- 基础工具 ----------------
def _roll_mean(a: np.ndarray, p: int) -> np.ndarray:
    out = np.full(len(a), np.nan)
    if len(a) < p:
        return out
    cs = np.cumsum(np.nan_to_num(a, nan=0.0))
    out[p - 1:] = (cs[p - 1:] - np.concatenate([[0.0], cs[:-p]])) / p
    return out


def _roll_std(a: np.ndarray, p: int) -> np.ndarray:
    out = np.full(len(a), np.nan)
    if len(a) < p:
        return out
    s = np.nan_to_num(a, nan=0.0)
    cs = np.cumsum(s)
    cs2 = np.cumsum(s * s)
    n = p
    m = (cs[p - 1:] - np.concatenate([[0.0], cs[:-p]])) / n
    v = (cs2[p - 1:] - np.concatenate([[0.0], cs2[:-p]])) / n - m * m
    out[p - 1:] = np.sqrt(np.maximum(v, 0.0))
    return out


def _shift(a: np.ndarray, k: int) -> np.ndarray:
    out = np.full(len(a), np.nan)
    if k <= 0:
        return a.copy()
    if len(a) > k:
        out[k:] = a[:-k]
    return out


def _safe_div(a: np.ndarray, b: np.ndarray, eps: float = 1e-12) -> np.ndarray:
    with np.errstate(divide="ignore", invalid="ignore"):
        r = a / np.where(np.abs(b) < eps, np.nan, b)
    return r


def rsi(close: np.ndarray, p: int = 14) -> np.ndarray:
    d = np.full(len(close), np.nan)
    d[1:] = np.diff(close)
    up = np.where(d > 0, d, 0.0)
    dn = np.where(d < 0, -d, 0.0)
    au = _roll_mean(up, p)
    ad = _roll_mean(dn, p)
    return 100.0 - 100.0 / (1.0 + _safe_div(au, ad))


def atr(h, l, c, p: int = 14) -> np.ndarray:
    n = len(c)
    tr = np.full(n, np.nan)
    tr[0] = h[0] - l[0]
    if n > 1:
        pc = c[:-1]
        tr[1:] = np.maximum(h[1:] - l[1:], np.maximum(np.abs(h[1:] - pc), np.abs(l[1:] - pc)))
    return _roll_mean(tr, p)


def adx(h, l, c, p: int = 14) -> np.ndarray:
    n = len(c)
    pdm = np.zeros(n)
    ndm = np.zeros(n)
    if n > 1:
        up = h[1:] - h[:-1]
        dn = l[:-1] - l[1:]
        pdm[1:] = np.where((up > dn) & (up > 0), up, 0.0)
        ndm[1:] = np.where((dn > up) & (dn > 0), dn, 0.0)
    tr = np.full(n, np.nan)
    tr[0] = h[0] - l[0]
    if n > 1:
        pc = c[:-1]
        tr[1:] = np.maximum(h[1:] - l[1:], np.maximum(np.abs(h[1:] - pc), np.abs(l[1:] - pc)))
    atr_ = _roll_mean(tr, p)
    pdi = 100.0 * _safe_div(_roll_mean(pdm, p), atr_)
    ndi = 100.0 * _safe_div(_roll_mean(ndm, p), atr_)
    dx = 100.0 * _safe_div(np.abs(pdi - ndi), pdi + ndi)
    return _roll_mean(dx, p)


def efficiency_ratio(close: np.ndarray, p: int = 24) -> np.ndarray:
    """Kaufman 效率比：净位移 / 路径长度。→1 趋势，→0 震荡。"""
    n = len(close)
    out = np.full(n, np.nan)
    if n <= p:
        return out
    net = np.abs(close[p:] - close[:-p])
    path = np.abs(np.diff(close))
    cs = np.concatenate([[0.0], np.cumsum(path)])
    total = cs[p:] - cs[:-p]
    out[p:] = _safe_div(net, total)
    return out


# ---------------- 单币种特征 ----------------
def build_symbol_features(sym: str) -> dict | None:
    fraw = os.path.join(SRC_CACHE, f"{sym}_raw.npz")
    ffeat = os.path.join(SRC_CACHE, f"{sym}_feat.npz")
    if not (os.path.exists(fraw) and os.path.exists(ffeat)):
        return None
    raw = np.load(fraw)
    feat = np.load(ffeat)
    ohlcv = raw["ohlcv"]
    if len(ohlcv) < WARMUP + MAX_H + 100:
        return None
    o, h, l, c, v = ohlcv[:, 1], ohlcv[:, 2], ohlcv[:, 3], ohlcv[:, 4], ohlcv[:, 5]
    t0 = feat["t0"]
    sig = feat["sig"]
    adx_s = feat["adx"]
    fr = raw["fr"]
    ls = raw["ls"]
    oi = raw["oi"]
    n = len(c)

    feats: dict[str, np.ndarray] = {}
    # 1) 原管线的 8 个因子组得分（保持同口径，便于与既有 IC 对齐）
    Xg = feat["X"]
    for j, g in enumerate(GROUPS):
        feats[f"g_{g}"] = Xg[:, j].astype(float)

    # 2) 价格派生（全部右对齐、因果）
    logc = np.log(np.maximum(c, 1e-12))
    dl = np.full(n, np.nan)
    dl[1:] = np.diff(logc)
    vol24 = _roll_std(dl, 24)
    vol96 = _roll_std(dl, 96)
    for k in (1, 2, 4, 8, 24, 48):
        r = np.full(n, np.nan)
        r[k:] = logc[k:] - logc[:-k]
        feats[f"ret{k}"] = _safe_div(r, vol24 * math.sqrt(k))

    for p in (12, 24, 96):
        ma = _roll_mean(c, p)
        feats[f"distma{p}"] = _safe_div(c - ma, ma)
    feats["rsi14"] = (rsi(c, 14) - 50.0) / 50.0
    feats["vol_ratio"] = _safe_div(vol24, vol96)
    feats["atr_ratio"] = _safe_div(atr(h, l, c, 14), c)
    feats["er"] = efficiency_ratio(c, 24)
    feats["adx_n"] = adx_s / 100.0
    feats["skew24"] = _safe_div(_roll_mean(dl ** 3, 24), vol24 ** 3)
    feats["kurt24"] = _safe_div(_roll_mean(dl ** 4, 24), vol24 ** 4)

    # 3) 位置类：当前价在滚动区间中的位置（原管线 position 组之外再给一次）
    for p in (48, 168):
        hi = np.full(n, np.nan)
        lo = np.full(n, np.nan)
        if n >= p:
            strides = np.lib.stride_tricks.sliding_window_view
            hi[p - 1:] = strides(h, p).max(axis=1)
            lo[p - 1:] = strides(l, p).min(axis=1)
        rng_ = hi - lo
        feats[f"posrange{p}"] = _safe_div(c - lo, rng_) - 0.5

    # 4) 量能
    lv = np.log(np.maximum(v, 1e-12))
    feats["volz24"] = _safe_div(lv - _roll_mean(lv, 24), _roll_std(lv, 24))
    feats["volz96"] = _safe_div(lv - _roll_mean(lv, 96), _roll_std(lv, 96))
    feats["dvol24"] = _safe_div(v, _roll_mean(v, 24)) - 1.0

    # 5) 合约面（资金费率 / 多空比 / 持仓量）
    fr_ = np.asarray(fr, dtype=float)
    ls_ = np.asarray(ls, dtype=float)
    oi_ = np.asarray(oi, dtype=float)
    feats["fr_raw"] = fr_
    feats["fr_z"] = _safe_div(fr_ - _roll_mean(fr_, 72), _roll_std(fr_, 72))
    feats["ls_raw"] = np.log(np.maximum(ls_, 1e-6))
    feats["ls_z"] = _safe_div(ls_ - _roll_mean(ls_, 72), _roll_std(ls_, 72))
    oi_d = np.full(n, np.nan)
    oi_d[1:] = np.diff(np.log(np.maximum(oi_, 1e-12)))
    feats["doi_z"] = _safe_div(oi_d - _roll_mean(oi_d, 72), _roll_std(oi_d, 72))

    # 6) K 线形态
    body = _safe_div(c - o, h - l)
    feats["body"] = body
    feats["wick_up"] = _safe_div(h - np.maximum(o, c), h - l)
    feats["wick_dn"] = _safe_div(np.minimum(o, c) - l, h - l)

    names = sorted(feats.keys())
    F = np.column_stack([feats[k] for k in names])

    # 7) 标签：多视野波动率归一 + 横截面去均值 + MAD 截断（稍后跨币种统一做）
    y = np.full(n, np.nan)
    inv_sig = np.where(np.isfinite(sig) & (sig > 0), 1.0 / sig, np.nan)
    for t in range(n - MAX_H):
        acc = 0.0
        ok = True
        for hh in FWD_HORIZONS:
            if t + hh >= n:
                ok = False
                break
            acc += (logc[t + hh] - logc[t])
        if ok:
            y[t] = (acc / len(FWD_HORIZONS)) * inv_sig[t]

    # 8) PnL 用的前瞻收益矩阵 + 逐行资金费率（不做任何中性化，保持可交易的真实口径）
    fwd = np.full((n, len(FWD_PNL)), np.nan)
    for j, k in enumerate(FWD_PNL):
        v = np.full(n, np.nan)
        if n > k:
            v[:n - k] = logc[k:] - logc[:-k]
        fwd[:, j] = v

    return {"sym": sym, "F": F, "y": y, "t0": t0.astype(np.int64), "c": c,
            "fwd": fwd, "fr": np.asarray(fr, dtype=float), "names": names, "n": n}


# ---------------- 数据集构建 ----------------
def build_dataset(out_dir: str = OUT_DIR, verbose: bool = True) -> dict:
    os.makedirs(out_dir, exist_ok=True)
    files = sorted(glob.glob(os.path.join(SRC_CACHE, "*_raw.npz")))
    syms = []
    for f in files:
        s = os.path.basename(f)[:-8]
        # 跳过缓存里的乱码币名（历史特例，编码已损，无法与交易所符号对应）
        if not s.isascii():
            if verbose:
                print(f"[nl:data] 跳过非 ASCII 币名缓存: {s!r}")
            continue
        syms.append(s)

    parts, used = [], []
    for i, s in enumerate(syms):
        d = build_symbol_features(s)
        if d is None:
            continue
        parts.append(d)
        used.append(s)
        if verbose and (i + 1) % 20 == 0:
            print(f"[nl:data] 特征 {i+1}/{len(syms)}", flush=True)
    if not parts:
        raise SystemExit("[nl:data] 没有可用缓存，先跑 train/experiment_drift.py fetch && features")

    names = parts[0]["names"]
    for p in parts:
        assert p["names"] == names, "特征列顺序不一致"

    n_rows = []
    F_l, y_l, ts_l, sym_l, bar_l, fwd_l, c_l, fr_l = [], [], [], [], [], [], [], []
    for p in parts:
        n = p["n"]
        # 右端截到 MAX_PNL_H：保证 PnL 视野（最长 24 bar）的前瞻收益全部有效，
        # 避免 PnL 模拟在序列尾部悄悄丢掉样本（那会系统性偏乐观）。
        keep = np.arange(WARMUP, n - MAX_PNL_H)
        if len(keep) < 200:
            continue
        F_l.append(p["F"][keep])
        y_l.append(p["y"][keep])
        ts_l.append(p["t0"][keep])
        sym_l.append(np.full(len(keep), len(n_rows), dtype=np.int32))
        bar_l.append(keep.astype(np.int32))
        fwd_l.append(p["fwd"][keep])
        c_l.append(p["c"][keep])
        fr_l.append(p["fr"][keep])
        n_rows.append(p["sym"])

    Fm = np.concatenate(F_l, axis=0)
    y = np.concatenate(y_l)
    ts = np.concatenate(ts_l)
    sid = np.concatenate(sym_l)
    bar = np.concatenate(bar_l)
    fwd = np.concatenate(fwd_l, axis=0)
    close = np.concatenate(c_l)
    frrow = np.concatenate(fr_l)

    # 标签横截面中性化 + MAD 截断
    order = np.argsort(ts, kind="stable")
    y_neut = y.copy()
    start = 0
    while start < len(order):
        end = start
        while end + 1 < len(order) and ts[order[end + 1]] == ts[order[start]]:
            end += 1
        idx = order[start:end + 1]
        if len(idx) >= 3:
            v = y[idx]
            m = np.isfinite(v)
            if m.sum() >= 3:
                y_neut[idx[m]] = v[m] - v[m].mean()
        start = end + 1
    med = np.nanmedian(y_neut)
    mad = np.nanmedian(np.abs(y_neut - med)) * 1.4826
    clip = 5 * mad if mad > 0 else float(np.nanstd(y_neut)) * 5
    y_clip = np.clip(y_neut, med - clip, med + clip)

    # 横截面标准化特征：每个时间戳内 z-score（只用同一时间戳内存在的币种）
    Fxs = np.full_like(Fm, np.nan)
    for j in range(Fm.shape[1]):
        col = Fm[:, j]
        start = 0
        while start < len(order):
            end = start
            while end + 1 < len(order) and ts[order[end + 1]] == ts[order[start]]:
                end += 1
            idx = order[start:end + 1]
            v = col[idx]
            m = np.isfinite(v)
            if m.sum() >= 5:
                mu = v[m].mean()
                sd = v[m].std()
                if sd > 1e-12:
                    Fxs[idx[m], j] = np.clip((v[m] - mu) / sd, -5.0, 5.0)
                else:
                    Fxs[idx[m], j] = 0.0
            start = end + 1

    # regime 通道：必须取自 **Fxs**，即模型真正吃进去的那个矩阵。
    # 曾经取自 Fraw，于是闸门拿原始量纲的分位边界（vol_ratio 0.81/1.08）
    # 去比对 Fxs 里的 z-score（−0.1），状态路由全错（导出自证误差 1.02 才暴露出来）。
    # 门控边界用分位数，而分位数对单调变换不变，所以改用 Fxs 不损失任何含义。
    ridx = {k: names.index(k) for k in REGIME_NAMES if k in names}
    regime = np.column_stack([Fxs[:, ridx[k]] for k in REGIME_NAMES if k in ridx])
    regime_names = [k for k in REGIME_NAMES if k in ridx]

    n_finite_y = int(np.isfinite(y_clip).sum())
    meta = {
        "featureNames": names,
        "regimeNames": regime_names,
        "symbols": n_rows,
        "nRows": int(len(y_clip)),
        "nSymbols": len(n_rows),
        "nFeatures": len(names),
        "warmup": WARMUP,
        "fwdHorizons": list(FWD_HORIZONS),
        "fwdPnl": list(FWD_PNL),
        "labelClip": float(clip),
        "finiteLabels": n_finite_y,
        "tsMin": int(ts.min()),
        "tsMax": int(ts.max()),
        "builtAt": None,
    }
    np.savez_compressed(
        os.path.join(out_dir, "dataset.npz"),
        Fxs=Fxs.astype(np.float32),
        Fraw=Fm.astype(np.float32),
        regime=regime.astype(np.float32),
        y=y_clip.astype(np.float32),
        fwd=fwd.astype(np.float32),
        close=close.astype(np.float64),
        frrow=frrow.astype(np.float32),
        ts=ts,
        sid=sid,
        bar=bar,
    )
    with open(os.path.join(out_dir, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    if verbose:
        print(f"[nl:data] 样本 {meta['nRows']} / 币种 {meta['nSymbols']} / 特征 {meta['nFeatures']}"
              f" / 时间跨度 {meta['tsMin']}→{meta['tsMax']}")
    return meta


def load_dataset(out_dir: str = OUT_DIR) -> dict:
    d = np.load(os.path.join(out_dir, "dataset.npz"))
    with open(os.path.join(out_dir, "meta.json"), encoding="utf-8") as f:
        meta = json.load(f)
    return {"Fxs": d["Fxs"], "Fraw": d["Fraw"], "regime": d["regime"],
            "y": d["y"], "ts": d["ts"], "sid": d["sid"], "bar": d["bar"],
            "fwd": d["fwd"], "close": d["close"], "frrow": d["frrow"], "meta": meta}


if __name__ == "__main__":
    build_dataset()
