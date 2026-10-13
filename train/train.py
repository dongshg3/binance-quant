#!/usr/bin/env python3
# ============================================================
# train.py · 币安量化系统 · 因子权重自动学习
# 每 6 小时由 GitHub Actions 运行：
#   1. 拉取币安 Top 60 高流动性 USDT 交易对 1h K线（公开数据，无需 Key）
#   2. 用与前端完全一致的七因子引擎计算各 bar 因子组得分
#   3. 以未来 12 bar 对数收益为标签，岭回归学习因子组权重
#   4. Spearman IC 分析 + 70/30 Walk-Forward 样本外验证
#   5. 实盘闭环：读取 data/tracker/*.csv（浏览器导出的真实信号结果），
#      仅用于模型选择闸门（绝不参与拟合，防自反馈过拟合）
#   6. EMA 权重收缩（新 0.6 / 旧 0.4）降低训练间方差
#   7. 导出 data/model.json（最新权重）并追加 data/evolution.json（进化历史）
# 零 AI token、零付费服务。
# ============================================================
import csv
import glob
import json
import math
import os
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone

import numpy as np

# ---------------- 配置 ----------------
HOSTS = [
    "https://data-api.binance.vision/api/v3",   # 官方公共行情镜像（全球可达）
    "https://api.binance.com/api/v3",
    "https://fapi.binance.com/fapi/v1",
]
TOP_N = int(os.environ.get("TQ_TOP_N", "60"))   # 按 24h 成交额取前 N 个币种
INTERVAL = "1h"
LIMIT = int(os.environ.get("TQ_LIMIT", "2000"))  # 每币种 K 线数（>1000 自动分页）
FWD = 12                  # 标签：未来 12 bar 对数收益
RIDGE_LAMBDA = 5.0
MIN_BARS = 400
MIN_SAMPLES = int(os.environ.get("TQ_MIN_SAMPLES", "20000"))
EMBARGO = 200             # Purged Walk-Forward：训练/测试间挖空的 bar 数 = 最大指标回看窗口
DECAY_HORIZONS = [1, 2, 4, 8, 24]  # IC 衰减曲线的预测视野
MIN_TS_IC = 0.02          # 闸门：单币种时间序列 IC 下限（诚实口径）
MAX_NEG_XS_IC = -0.02     # 闸门：横截面 IC 不得显著为负
GROUPS = ["trend", "momentum", "meanRev", "volume", "volatility", "position", "htf"]  # 可学习组
STATIC_WEIGHTS = {"trend": 0.22, "momentum": 0.18, "meanRev": 0.13, "volume": 0.13,
                  "volatility": 0.09, "position": 0.05, "htf": 0.10, "futures": 0.10}
FUTURES_STATIC = 0.10     # futures 组需要逐 bar 资金费率历史，训练期固定为静态权重
EMA_ALPHA = 0.6           # 权重收缩：新权重 0.6 + 旧权重 0.4（防训练间抖动/过拟合）
TRACKER_MIN_N = 30        # 实盘追踪样本下限，不足则闸门不启用
TRACKER_TOLERANCE = 0.02  # 实盘 IC 允许退化容忍度

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
TRACKER_DIR = os.path.join(DATA_DIR, "tracker")
os.makedirs(DATA_DIR, exist_ok=True)

# ---------------- HTTP ----------------
def http_get(url, timeout=20, retries=3):
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "binance-quant-trainer/1.0"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode())
        except Exception as e:  # noqa
            last = e
            time.sleep(1.5 * (i + 1))
    raise last

def market_get(path, timeout=20):
    last = None
    for h in HOSTS:
        try:
            return http_get(h + path, timeout=timeout)
        except Exception as e:  # noqa
            last = e
    raise last

# ---------------- 指标（与前端 js/lib/stats.js 一致） ----------------
def SMA(a, p):
    a = np.asarray(a, dtype=float); out = np.full(len(a), np.nan)
    if len(a) >= p:
        c = np.cumsum(np.insert(a, 0, 0.0))
        out[p - 1:] = (c[p:] - c[:-p]) / p
    return out

def EMA(a, p):
    a = np.asarray(a, dtype=float); out = np.full(len(a), np.nan)
    if len(a) < p:
        return out
    k = 2.0 / (p + 1)
    e = np.mean(a[:p]); out[p - 1] = e
    for i in range(p, len(a)):
        e = a[i] * k + e * (1 - k); out[i] = e
    return out

def RSI(c, p=14):
    c = np.asarray(c, dtype=float); out = np.full(len(c), np.nan)
    if len(c) < p + 1:
        return out
    d = np.diff(c)
    ag = np.mean(np.maximum(d[:p], 0)); al = np.mean(np.maximum(-d[:p], 0))
    out[p] = 100 if al == 0 else 100 - 100 / (1 + ag / al)
    for i in range(p + 1, len(c)):
        dd = c[i] - c[i - 1]
        g, l = max(dd, 0), max(-dd, 0)
        ag = (ag * (p - 1) + g) / p; al = (al * (p - 1) + l) / p
        out[i] = 100 if al == 0 else 100 - 100 / (1 + ag / al)
    return out

def ATR(h, l, c, p=14):
    n = len(c); out = np.full(n, np.nan)
    if n < p + 1:
        return out
    tr = np.maximum(h[1:] - l[1:], np.maximum(np.abs(h[1:] - c[:-1]), np.abs(l[1:] - c[:-1])))
    out[p] = np.mean(tr[:p])
    for i in range(p + 1, n):
        out[i] = (out[i - 1] * (p - 1) + tr[i - 1]) / p
    return out

def Boll(c, p=20, m=2.0):
    mid = SMA(c, p); up = np.full(len(c), np.nan); lo = np.full(len(c), np.nan)
    c = np.asarray(c, dtype=float)
    for i in range(p - 1, len(c)):
        sd = np.std(c[i - p + 1:i + 1])
        up[i] = mid[i] + m * sd; lo[i] = mid[i] - m * sd
    return up, mid, lo

def ADX(h, l, c, p=14):
    n = len(c)
    tr = np.zeros(n); pdm = np.zeros(n); mdm = np.zeros(n)
    for i in range(1, n):
        tr[i] = max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1]))
        up = h[i] - h[i - 1]; dn = l[i - 1] - l[i]
        pdm[i] = up if (up > dn and up > 0) else 0
        mdm[i] = dn if (dn > up and dn > 0) else 0
    def sm(a):
        s = np.zeros(n); s[p] = np.sum(a[1:p + 1])
        for i in range(p + 1, n):
            s[i] = s[i - 1] - s[i - 1] / p + a[i]
        return s
    str_, sp, sn = sm(tr), sm(pdm), sm(mdm)
    pdi = np.full(n, np.nan); mdi = np.full(n, np.nan)
    mask = str_[p:] != 0
    pdi[p:][mask] = sp[p:][mask] / str_[p:][mask] * 100
    mdi[p:][mask] = sn[p:][mask] / str_[p:][mask] * 100
    dx = np.full(n, np.nan)
    both = ~(np.isnan(pdi) | np.isnan(mdi))
    s = pdi[both] + mdi[both]
    dx[both] = np.where(s == 0, 0, np.abs(pdi[both] - mdi[both]) / s * 100)
    adx = np.full(n, np.nan)
    idxs = np.where(~np.isnan(dx))[0]
    if len(idxs) >= p:
        start = idxs[p - 1]
        adx[start] = np.mean(dx[idxs[:p]])
        for i in range(start + 1, n):
            if not np.isnan(dx[i]):
                adx[i] = (adx[i - 1] * (p - 1) + dx[i]) / p
    return adx, pdi, mdi

def VWAP(h, l, c, v, p=50):
    n = len(c); out = np.full(n, np.nan)
    tp = (h + l + c) / 3
    for i in range(p - 1, n):
        sv = np.sum(v[i - p + 1:i + 1])
        out[i] = c[i] if sv == 0 else np.sum(tp[i - p + 1:i + 1] * v[i - p + 1:i + 1]) / sv
    return out

def OBV(c, v):
    o = np.zeros(len(c)); o[0] = v[0]
    for i in range(1, len(c)):
        o[i] = o[i - 1] + (v[i] if c[i] > c[i - 1] else -v[i] if c[i] < c[i - 1] else 0)
    return o

def Keltner(c, h, l, p=20, m=2.0):
    mid = EMA(c, p); atr = ATR(h, l, c, p)
    return mid + m * atr, mid - m * atr

def StochRSI(c, rsiP=14, stochP=14, kP=3):
    rsi = RSI(c, rsiP); st = np.full(len(c), np.nan)
    for i in range(rsiP + stochP, len(c)):
        window = rsi[i - stochP + 1:i + 1]
        window = window[~np.isnan(window)]
        if len(window) == 0:
            continue
        mn, mx = np.min(window), np.max(window)
        st[i] = 50 if mx == mn else (rsi[i] - mn) / (mx - mn) * 100
    valid = st[~np.isnan(st)]
    k = SMA(valid, kP)
    out = np.full(len(c), np.nan)
    first = np.where(~np.isnan(st))[0]
    if len(first) and len(k):
        off = first[0]
        kk = k[~np.isnan(k)]
        out[off:off + len(kk)] = kk
    return out

def MACD_hist(c, f=12, s=26, sig=9):
    ef, es = EMA(c, f), EMA(c, s)
    ml = ef - es
    valid = ml[~np.isnan(ml)]
    sl = EMA(valid, sig)
    h = np.full(len(c), np.nan)
    idx = np.where(~np.isnan(ml))[0]
    if len(idx) and len(sl):
        off = idx[0]
        ss = sl[~np.isnan(sl)]
        h[off:off + len(ss)] = ml[off:off + len(ss)] - ss
    return h

def clamp(x, lo, hi):
    return max(lo, min(hi, x))

# ---------------- 高周期重采样（无未来函数，与前端同构） ----------------
def resample_closes(c, f):
    """基础周期收盘价 → f 倍周期（1h→4h/日线），只保留已完成的 bar"""
    m = len(c) // f
    return c[:m * f].reshape(m, f)[:, -1]

def map_htf(values, n, f):
    """大周期第 j 个完整 bar 覆盖基础 bar [j*f,(j+1)*f)，基础 bar i 只能看到 i//f - 1"""
    out = np.full(n, np.nan)
    idx = np.arange(n) // f - 1
    valid = (idx >= 0) & (idx < len(values))
    out[valid] = values[idx[valid]]
    return out

# ---------------- 七因子引擎（与前端 computeFactors 同构，训练期不含 futures 组） ----------------
def group_scores(ohlcv):
    c = ohlcv[:, 4]; h = ohlcv[:, 2]; l = ohlcv[:, 3]; v = ohlcv[:, 5]
    n = len(c)
    rsi = RSI(c); macdh = MACD_hist(c)
    ema9, ema21, ema50, ema200 = EMA(c, 9), EMA(c, 21), EMA(c, 50), EMA(c, 200)
    bbU, bbM, bbL = Boll(c)
    atr = ATR(h, l, c)
    stoch = StochRSI(c)
    adx, pdi, mdi = ADX(h, l, c)
    vwap = VWAP(h, l, c, v)
    obv = OBV(c, v)
    kcU, kcL = Keltner(c, h, l)
    volAvg = SMA(v, 20)
    bbw = np.where((~np.isnan(bbU)) & (~np.isnan(bbM)) & (bbM != 0), (bbU - bbL) / bbM * 100, np.nan)

    out = {g: np.zeros(n) for g in GROUPS}

    # 高周期共振（4× = 4h、24× = 日线；仅用已完成的大周期 bar，与前端同构）
    c4 = resample_closes(c, 4); c24 = resample_closes(c, 24)
    ema_d = EMA(c24, 20)
    d_trend = np.where(np.isnan(ema_d), np.nan, np.sign(c24 - ema_d))
    d_slope = np.full(len(ema_d), np.nan)
    for j in range(3, len(ema_d)):
        if not np.isnan(ema_d[j]) and not np.isnan(ema_d[j - 3]):
            d_slope[j] = np.sign(ema_d[j] - ema_d[j - 3]) * 0.5
    rsi4 = RSI(c4)
    rsi4_s = np.where(np.isnan(rsi4), np.nan, np.clip((50 - rsi4) / 20, -1, 1))
    macd4h = MACD_hist(c4)
    macd4_s = np.where(np.isnan(macd4h), np.nan, np.sign(macd4h) * 0.5)
    htf_trend_map = map_htf(d_trend, n, 24)
    htf_slope_map = map_htf(d_slope, n, 24)
    htf_rsi_map = map_htf(rsi4_s, n, 4)
    htf_macd_map = map_htf(macd4_s, n, 4)

    for i in range(n):
        price = c[i]; a = atr[i]
        # trend
        ema_s = 0.0
        if not np.isnan(ema50[i]):
            if ema9[i] > ema21[i] > ema50[i]: ema_s = 1.0
            elif ema9[i] < ema21[i] < ema50[i]: ema_s = -1.0
            else: ema_s = 0.3 if ema9[i] > ema21[i] else -0.3
        ema200_s = (1.0 if price > ema200[i] else -1.0) if not np.isnan(ema200[i]) else 0.0
        adx_s = (np.sign(pdi[i] - mdi[i]) * min(adx[i] / 50, 1)) if (not np.isnan(adx[i]) and adx[i] > 25) else 0.0
        kc_s = 0.0
        if not np.isnan(kcU[i]):
            kc_s = 1.0 if price > kcU[i] else -1.0 if price < kcL[i] else 0.0
        out["trend"][i] = np.mean([ema_s, ema200_s, adx_s, kc_s])
        # momentum
        rsi_s = clamp((50 - rsi[i]) / 20, -1, 1) if not np.isnan(rsi[i]) else 0.0
        macd_s = clamp(macdh[i] / (a * 0.3), -1, 1) if (not np.isnan(macdh[i]) and not np.isnan(a) and a > 0) else 0.0
        stoch_s = clamp((50 - stoch[i]) / 30, -1, 1) if not np.isnan(stoch[i]) else 0.0
        div_s = 0.0
        if i >= 5 and not np.isnan(rsi[i]) and not np.isnan(rsi[i - 5]):
            if c[i] < c[i - 5] and rsi[i] > rsi[i - 5] + 3: div_s = 0.8
            elif c[i] > c[i - 5] and rsi[i] < rsi[i - 5] - 3: div_s = -0.8
        out["momentum"][i] = np.mean([rsi_s, macd_s, stoch_s, div_s])
        # meanRev
        boll_s = clamp((0.5 - (price - bbL[i]) / (bbU[i] - bbL[i])) * 2, -1, 1) if (not np.isnan(bbU[i]) and bbU[i] > bbL[i]) else 0.0
        vwap_s = clamp(-(price - vwap[i]) / vwap[i] * 50, -1, 1) if (not np.isnan(vwap[i]) and vwap[i] != 0) else 0.0
        out["meanRev"][i] = np.mean([boll_s, vwap_s])
        # volume
        vr = v[i] / volAvg[i] if (not np.isnan(volAvg[i]) and volAvg[i] != 0) else 1.0
        rdir = np.sign(c[i] - c[i - 5]) if i >= 5 else 0.0
        vol_s = rdir * clamp((vr - 1) / 2, 0, 1) if vr > 1.3 else 0.0
        obv_s = 0.0
        if i >= 5 and obv[i - 5] != 0:
            slope = (obv[i] - obv[i - 5]) / abs(obv[i - 5])
            pslope = (c[i] - c[i - 5]) / c[i - 5]
            if slope > 0.02 and pslope > 0: obv_s = clamp(slope * 20, 0, 1)
            elif slope < -0.02 and pslope < 0: obv_s = clamp(slope * 20, -1, 0)
            elif slope > 0.02 and pslope < 0: obv_s = 0.3
            elif slope < -0.02 and pslope > 0: obv_s = -0.3
        out["volume"][i] = np.mean([vol_s, obv_s])
        # volatility（挤压）
        sq_s = 0.0
        if i >= 20 and not np.isnan(bbw[i]):
            window = bbw[i - 19:i + 1]; window = window[~np.isnan(window)]
            if len(window):
                ratio = bbw[i] / np.mean(window) if np.mean(window) != 0 else 1.0
                if ratio < 0.6: sq_s = 0.8 if price > bbM[i] else -0.8
                elif ratio > 1.5: sq_s = 0.4 if price > bbM[i] else -0.4
        out["volatility"][i] = sq_s
        # position（斐波那契）
        fib_s = 0.0
        if i >= 50 and not np.isnan(ema50[i]):
            s50 = max(0, i - 49)
            sh = np.max(h[s50:i + 1]); sl = np.min(l[s50:i + 1])
            rng = sh - sl
            if rng > 0:
                pos = (sh - price) / rng
                if 0.5 < pos < 0.65 and price > ema50[i]: fib_s = 0.7
                elif 0.35 < pos < 0.45 and price > ema50[i]: fib_s = 0.4
                elif pos < 0.1: fib_s = -0.3
        out["position"][i] = fib_s
        # htf（高周期共振）
        parts = [htf_trend_map[i], htf_slope_map[i], htf_rsi_map[i], htf_macd_map[i]]
        parts = [p for p in parts if not np.isnan(p)]
        out["htf"][i] = float(np.mean(parts)) if parts else 0.0
    return out

# ---------------- 统计工具 ----------------
def spearman(x, y):
    x = np.asarray(x); y = np.asarray(y)
    mask = ~(np.isnan(x) | np.isnan(y))
    x, y = x[mask], y[mask]
    if len(x) < 30:
        return 0.0
    rx = np.argsort(np.argsort(x)).astype(float)
    ry = np.argsort(np.argsort(y)).astype(float)
    rx -= rx.mean(); ry -= ry.mean()
    denom = math.sqrt((rx ** 2).sum() * (ry ** 2).sum())
    return float((rx * ry).sum() / denom) if denom > 0 else 0.0

# ---------------- 实盘追踪数据（模型选择闸门，绝不参与拟合） ----------------
ALL_GROUPS = GROUPS + ["futures"]

def load_tracker():
    """读取 data/tracker/*.csv（浏览器导出的真实信号→结果记录）。
    返回 [{'groups': {g: v}, 'ret24': float}]，按 (symbol, interval, time) 去重。"""
    rows, seen = [], set()
    for path in sorted(glob.glob(os.path.join(TRACKER_DIR, "*.csv"))):
        try:
            with open(path, encoding="utf-8-sig", newline="") as f:
                for r in csv.DictReader(f):
                    try:
                        if not r.get("ret24"):
                            continue  # 尚未回填结果的信号
                        d = int(float(r.get("direction") or 0))
                        if d == 0:
                            continue  # 观望信号无方向，不参与方向性评估
                        key = (r.get("symbol"), r.get("interval"), r.get("time"))
                        if key in seen:
                            continue
                        seen.add(key)
                        groups = {}
                        for g in ALL_GROUPS:
                            v = r.get(g)
                            groups[g] = float(v) if v not in (None, "") else 0.0
                        rows.append({"groups": groups, "ret24": float(r["ret24"])})
                    except (ValueError, TypeError):
                        continue
        except OSError:
            continue
    return rows

def tracker_ic(weights, rows):
    """在实盘信号上评估某套权重的排序能力：权重×记录下的因子组得分 → 与真实 T+24 收益的 Spearman 相关。"""
    if len(rows) < 10:
        return None
    comps = [sum(weights.get(g, 0.0) * r["groups"].get(g, 0.0) for g in ALL_GROUPS) for r in rows]
    rets = [r["ret24"] for r in rows]
    return spearman(np.array(comps), np.array(rets))

def cross_sectional_ic(pred, y, ts, min_n=5):
    """横截面 IC：每个时间戳内对币种排序求 Spearman，再取平均。
    这是"选币能力"的诚实口径——混合 IC 会被跨币种同涨同跌严重虚增。"""
    buckets = {}
    for k in range(len(y)):
        buckets.setdefault(int(ts[k]), []).append(k)
    ics = [spearman(pred[idx], y[idx]) for idx in buckets.values() if len(idx) >= min_n]
    return (float(np.mean(ics)), len(ics)) if ics else (None, 0)

# ---------------- 数据 ----------------
def get_symbols():
    info = market_get("/exchangeInfo")
    tickers = market_get("/ticker/24hr", timeout=30)
    vol = {t["symbol"]: float(t.get("quoteVolume", 0)) for t in tickers}
    syms = []
    for s in info["symbols"]:
        sym = s["symbol"]
        if s.get("quoteAsset") != "USDT" or s.get("status") != "TRADING":
            continue
        if any(x in sym for x in ("UP", "DOWN", "BULL", "BEAR")):
            continue
        syms.append(sym)
    syms.sort(key=lambda s: -vol.get(s, 0))
    return syms[:TOP_N]

def get_klines(sym):
    """拉取 K 线，LIMIT>1000 时向历史分页；丢弃最后一根未收盘 bar（防标签/特征对齐偏差）"""
    data = market_get(f"/klines?symbol={sym}&interval={INTERVAL}&limit={min(LIMIT, 1000)}", timeout=25)
    if LIMIT > 1000 and len(data) == 1000:
        end = int(data[0][0]) - 1
        earlier = market_get(f"/klines?symbol={sym}&interval={INTERVAL}&limit={LIMIT - 1000}&endTime={end}", timeout=25)
        data = earlier + data
    arr = np.array([[float(k[0]), float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[5])] for k in data])
    return arr[:-1] if len(arr) else arr

# ---------------- 主流程 ----------------
def main():
    print(f"[train] {datetime.now(timezone.utc).isoformat()} 开始训练")
    symbols = get_symbols()
    print(f"[train] 币种: {len(symbols)} 个")

    X_rows, y_rows, t_rows, ts_rows, nn_rows, s_rows = [], [], [], [], [], []
    YH = {hh: [] for hh in DECAY_HORIZONS}
    used = 0
    max_h = max(DECAY_HORIZONS)
    for sym in symbols:
        try:
            ohlcv = get_klines(sym)
            if len(ohlcv) < MIN_BARS:
                continue
            gs = group_scores(ohlcv)
            c = ohlcv[:, 4]; t0 = ohlcv[:, 0]
            n = len(c)
            for i in range(200, n - max_h):
                X_rows.append([gs[g][i] for g in GROUPS])
                y_rows.append(math.log(c[i + FWD] / c[i]))
                t_rows.append(i); ts_rows.append(t0[i]); nn_rows.append(n); s_rows.append(sym)
                for hh in DECAY_HORIZONS:
                    YH[hh].append(math.log(c[i + hh] / c[i]))
            used += 1
            time.sleep(0.12)  # 礼貌限速
        except Exception as e:
            print(f"[train] {sym} 失败: {e}")
    X = np.array(X_rows); y = np.array(y_rows); tt = np.array(t_rows)
    ts = np.array(ts_rows); nn = np.array(nn_rows); ss = np.array(s_rows)
    print(f"[train] 样本: {len(y)} 条（{used} 个币种）")
    if len(y) < MIN_SAMPLES:
        raise SystemExit("样本不足，放弃本次训练")

    # Purged Walk-Forward 70/30：按各币种内部时间切分，训练/测试间挖空 EMBARGO 根 bar
    # （EMA200 等指标有长记忆，不挖空会让测试集信息泄漏进训练特征）
    train_mask = tt < (0.7 * nn)
    test_mask = tt >= (0.7 * nn + EMBARGO)
    Xtr, ytr = X[train_mask], y[train_mask]
    Xte, yte = X[test_mask], y[test_mask]

    # 标准化（用训练集统计量）
    mu = Xtr.mean(axis=0); sd = Xtr.std(axis=0); sd[sd == 0] = 1
    Ztr = (Xtr - mu) / sd; Zte = (Xte - mu) / sd

    # 岭回归闭式解
    d = len(GROUPS)
    A = Ztr.T @ Ztr + RIDGE_LAMBDA * np.eye(d)
    w_std = np.linalg.solve(A, Ztr.T @ ytr)
    # 还原到原始量纲
    w_raw = w_std / sd

    # 样本内/外 IC（混合口径——仅作参考，会被跨币种同涨同跌虚增）
    pred_tr = Ztr @ w_std
    pred_te = Zte @ w_std
    ic_in = spearman(pred_tr, ytr)
    ic_oos = spearman(pred_te, yte)
    gap_in_out = ic_in - ic_oos

    # 诚实口径 1：横截面 IC（每个时间戳内对币种排序）——"选币能力"
    ic_xs, xs_buckets = cross_sectional_ic(pred_te, yte, ts[test_mask])
    # 诚实口径 2：单币种时间序列 IC 取分布——"单币择时能力"
    ps_ics = []
    for s in np.unique(ss[test_mask]):
        m = ss[test_mask] == s
        if m.sum() >= 50:
            ps_ics.append(spearman(pred_te[m], yte[m]))
    ps_ics = np.array(ps_ics) if ps_ics else np.array([0.0])
    ic_ps_mean = float(ps_ics.mean()); ic_ps_med = float(np.median(ps_ics))
    ic_ps_worst = float(ps_ics.min()); ic_ps_best = float(ps_ics.max())

    # IC 衰减曲线：同一模型对不同视野标签的 OOS 相关（缓慢衰减=真实信号，暴跌=噪声）
    ic_decay = {}
    for hh in DECAY_HORIZONS:
        yh = np.array(YH[hh])[test_mask]
        ic_decay[str(hh)] = round(spearman(pred_te, yh), 4)

    # 随机权重对照：真模型混合 IC 落在随机分布的哪个分位（<90% 则未超越噪声）
    rng = np.random.default_rng(42)
    rand_ics = []
    for _ in range(200):
        wr = rng.normal(size=d)
        wr = wr / np.abs(wr).sum()
        rand_ics.append(spearman(Zte @ wr, yte))
    rand_ics = np.array(rand_ics)
    rand_pct = float((rand_ics < ic_oos).mean())

    # 分因子 OOS IC
    factor_ic = {g: round(spearman(Xte[:, j], yte), 4) for j, g in enumerate(GROUPS)}

    # 多空五分位价差（样本外）
    q = np.quantile(pred_te, [0.2, 0.8])
    top = yte[pred_te >= q[1]]; bot = yte[pred_te <= q[0]]
    spread = float(top.mean() - bot.mean()) if len(top) and len(bot) else 0.0
    ls_rets = np.concatenate([top, -bot])
    ls_sharpe = float(ls_rets.mean() / ls_rets.std() * math.sqrt(8760 / FWD)) if ls_rets.std() > 0 else 0.0

    # 权重映射：学习权重归一化到 0.90，futures 固定 0.10
    absum = float(np.sum(np.abs(w_raw)))
    scale = (1.0 - FUTURES_STATIC) / absum if absum > 0 else 0
    learned_weights = {g: float(w_raw[j]) * scale for j, g in enumerate(GROUPS)}

    # ---------------- 防过拟合：EMA 权重收缩 + 实盘闸门 ----------------
    # 旧权重（上一版模型，无则静态）
    prev_weights = dict(STATIC_WEIGHTS)
    model_path = os.path.join(DATA_DIR, "model.json")
    if os.path.exists(model_path):
        try:
            with open(model_path, encoding="utf-8") as f:
                prev_model = json.load(f)
            if prev_model.get("weights"):
                prev_weights = prev_model["weights"]
        except Exception:
            pass

    # EMA 收缩：新 0.6 / 旧 0.4，再归一化（L1 = 0.90）
    shrunk = {g: EMA_ALPHA * learned_weights[g] + (1 - EMA_ALPHA) * float(prev_weights.get(g, 0)) for g in GROUPS}
    absum2 = float(sum(abs(v) for v in shrunk.values()))
    if absum2 > 0:
        shrunk = {g: v * (1.0 - FUTURES_STATIC) / absum2 for g, v in shrunk.items()}
    candidate = {g: round(shrunk[g], 4) for g in GROUPS}
    candidate["futures"] = FUTURES_STATIC

    # 闸门 1：诚实口径下限——单币种时间序列 IC（择时能力）必须显著为正，
    # 且横截面 IC（选币能力）不得显著为负
    accepted = True
    reject_reasons = []
    if ic_ps_mean < MIN_TS_IC:
        accepted = False
        reject_reasons.append(f"单币种IC {ic_ps_mean:.4f} < {MIN_TS_IC}")
    if ic_xs is not None and ic_xs < MAX_NEG_XS_IC:
        accepted = False
        reject_reasons.append(f"横截面IC显著为负 {ic_xs:.4f}")

    # 闸门 2：实盘追踪 IC（仅模型选择，不参与拟合；样本不足则跳过）
    tracker_rows = load_tracker()
    tk_ic_new = tracker_ic(candidate, tracker_rows) if len(tracker_rows) >= TRACKER_MIN_N else None
    tk_ic_prev = tracker_ic(prev_weights, tracker_rows) if len(tracker_rows) >= TRACKER_MIN_N else None
    if tk_ic_new is not None and tk_ic_prev is not None:
        if tk_ic_new < tk_ic_prev - TRACKER_TOLERANCE:
            accepted = False
            reject_reasons.append(f"实盘追踪IC退化 {tk_ic_new:.4f} < {tk_ic_prev:.4f} - {TRACKER_TOLERANCE}")

    final_weights = candidate if accepted else {g: round(float(prev_weights.get(g, 0)), 4) for g in ALL_GROUPS}
    if "futures" not in final_weights:
        final_weights["futures"] = FUTURES_STATIC

    tracker_info = {
        "n": len(tracker_rows),
        "icNew": round(tk_ic_new, 4) if tk_ic_new is not None else None,
        "icPrev": round(tk_ic_prev, 4) if tk_ic_prev is not None else None,
        "gate": "applied" if tk_ic_new is not None else "skipped(<30样本)",
    }

    trained_at = datetime.now(timezone.utc).isoformat(timespec="seconds")

    # evolution.json 追加
    evo_path = os.path.join(DATA_DIR, "evolution.json")
    evolution = []
    if os.path.exists(evo_path):
        with open(evo_path, encoding="utf-8") as f:
            evolution = json.load(f)
    version = len(evolution) + 1
    run = {
        "version": version,
        "trainedAt": trained_at,
        "symbols": used,
        "samples": int(len(y)),
        "fwdBars": FWD,
        "weights": final_weights,
        "factorIC": factor_ic,
        "icInSample": round(ic_in, 4),
        "icOOS": round(ic_oos, 4),
        "icXS": round(ic_xs, 4) if ic_xs is not None else None,
        "icPerSym": round(ic_ps_mean, 4),
        "icPerSymMedian": round(ic_ps_med, 4),
        "icDecay": ic_decay,
        "gapInOut": round(gap_in_out, 4),
        "randIC": {"mean": round(float(rand_ics.mean()), 4), "std": round(float(rand_ics.std()), 4),
                   "percentile": round(rand_pct, 4)},
        "lsSpread": round(spread, 6),
        "lsSharpeOOS": round(ls_sharpe, 2),
        "accepted": accepted,
        "rejectReason": "; ".join(reject_reasons),
        "alpha": EMA_ALPHA,
        "tracker": tracker_info,
    }
    evolution.append(run)
    evolution = evolution[-200:]  # 保留最近 200 次
    with open(evo_path, "w", encoding="utf-8") as f:
        json.dump(evolution, f, ensure_ascii=False, indent=1)

    # model.json 发布
    model = {
        "version": version,
        "trainedAt": trained_at,
        "engine": "ridge-v3-honest",
        "fwdBars": FWD,
        "weights": final_weights,
        "staticWeights": STATIC_WEIGHTS,
        "factorIC": factor_ic,
        "oos": {"ic": round(ic_oos, 4), "icInSample": round(ic_in, 4),
                "icXS": round(ic_xs, 4) if ic_xs is not None else None,
                "icPerSymbolMean": round(ic_ps_mean, 4), "icPerSymbolMedian": round(ic_ps_med, 4),
                "gapInOut": round(gap_in_out, 4),
                "lsSpread": round(spread, 6), "lsSharpe": round(ls_sharpe, 2)},
        "diagnostics": {
            "icDecay": ic_decay,
            "perSymbol": {"mean": round(ic_ps_mean, 4), "median": round(ic_ps_med, 4),
                          "worst": round(ic_ps_worst, 4), "best": round(ic_ps_best, 4)},
            "randomIC": {"mean": round(float(rand_ics.mean()), 4), "std": round(float(rand_ics.std()), 4),
                         "percentile": round(rand_pct, 4)},
            "xsBuckets": xs_buckets,
            "embargo": EMBARGO,
        },
        "accepted": accepted,
        "rejectReason": "; ".join(reject_reasons),
        "tracker": tracker_info,
        "meta": {"symbols": used, "samples": int(len(y)), "interval": INTERVAL,
                 "ridgeLambda": RIDGE_LAMBDA, "alpha": EMA_ALPHA, "embargo": EMBARGO,
                 "note": "权重=岭回归学习×0.6+旧权重×0.4；横截面IC=选币能力(诚实口径)，单币种IC=择时能力，混合IC易被同涨同跌虚增仅供参考；实盘追踪仅用于闸门不参与拟合"},
    }
    with open(os.path.join(DATA_DIR, "model.json"), "w", encoding="utf-8") as f:
        json.dump(model, f, ensure_ascii=False, indent=1)

    status = "接受" if accepted else f"拒绝（{'; '.join(reject_reasons)}）"
    print(f"[train] v{version} 完成 | 横截面IC {ic_xs if ic_xs is None else round(ic_xs, 4)} | 单币种IC 均值 {ic_ps_mean:.4f} 中位 {ic_ps_med:.4f} | 混合IC {ic_oos:.4f}(参考) | 更新{status}")
    print(f"[train] IC衰减 {json.dumps(ic_decay)} | 随机对照分位 {rand_pct:.1%} | 样本内外差距 {gap_in_out:.4f}")
    if tk_ic_new is not None:
        print(f"[train] 实盘追踪: n={len(tracker_rows)} IC 新 {tk_ic_new:.4f} / 旧 {tk_ic_prev:.4f}")
    print(f"[train] 权重: {json.dumps(final_weights, ensure_ascii=False)}")

if __name__ == "__main__":
    main()
