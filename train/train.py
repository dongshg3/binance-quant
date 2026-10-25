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
from urllib.parse import quote
from datetime import datetime, timezone

import numpy as np

from futures_data import load_series, align_to_bars

# ---------------- 配置 ----------------
HOSTS = [
    "https://data-api.binance.vision/api/v3",   # 官方公共行情镜像（全球可达）
    "https://api.binance.com/api/v3",
    "https://fapi.binance.com/fapi/v1",
]
TOP_N = int(os.environ.get("TQ_TOP_N", "60"))   # 按 24h 成交额取前 N 个币种
INTERVAL = "1h"
LIMIT = int(os.environ.get("TQ_LIMIT", "4000"))  # 每币种 K 线数（>1000 自动分页，4000 ≈ 5.5 个月）
FWD_SET = [2, 4, 8]       # 标签：短期多视野（未来 2/4/8 bar）波动率归一收益取均值
RIDGE_LAMBDA = 5.0
MIN_BARS = 400
MIN_SAMPLES = int(os.environ.get("TQ_MIN_SAMPLES", "100000"))
EMBARGO = 200             # Purged Walk-Forward：训练/测试间挖空的 bar 数 = 最大指标回看窗口
DECAY_HORIZONS = [1, 2, 4, 8, 12, 24]  # IC 衰减曲线的预测视野（对原始收益，诚实对照）
MIN_XS_IC = 0.02          # 闸门：横截面 IC（对工程化标签）下限
MIN_NW_T = 2.0            # 闸门：XS IC 的 Newey-West t 统计量下限（显著性硬门槛）
SEG_MIN_SAMPLES = 20000   # 分段模型最小样本数
SEG_MIN_SYMS = 6          # 分段模型最少覆盖币种数
DCOR_SUBSAMPLE = int(os.environ.get("TQ_DCOR_SUB", "3000"))  # 距离相关检验的子采样大小
DCOR_PERMS = int(os.environ.get("TQ_DCOR_PERMS", "60"))      # 距离相关置换检验次数
GROUPS = ["trend", "momentum", "meanRev", "volume", "volatility", "position", "htf", "futures"]  # 可学习组
STATIC_WEIGHTS = {"trend": 0.22, "momentum": 0.18, "meanRev": 0.13, "volume": 0.13,
                  "volatility": 0.09, "position": 0.05, "htf": 0.10, "futures": 0.10}
# 稳定币/指数合约：价格动态是脱锚噪音或合成指数，因子信号无意义，训练与扫描都排除
# 含新一代法币稳定币（RLUSD/BFUSD/XUSD/U 等）：钉住 1 美元，"高 IC" 是噪声伪影，
# 入场交易只会白付手续费（竞技场逐币族曾在 RLUSD/U 上每笔净亏 0.14% 手续费）
EXCLUDE_BASE = {"USDC", "FDUSD", "TUSD", "USDP", "DAI", "BUSD", "USD1", "USDD", "USDE", "USDS", "BTCDOM",
                "RLUSD", "BFUSD", "XUSD", "U", "PYUSD", "USDG", "AUSD", "GUSD", "EURC", "AEUR", "EURI", "LUSD"}
# 板块分类（静态映射，覆盖高流动性币种；未命中 → other）
# 不同板块的驱动结构不同：meme 由情绪和资金费率主导，major 由宏观 beta 主导，
# 混在一个模型里会互相稀释 —— 分段训练让每类币用自己的权重
CATEGORIES = {
    "major":  {"BTC", "ETH"},
    "l1":     {"SOL", "BNB", "ADA", "AVAX", "DOT", "TRX", "TON", "NEAR", "ATOM", "APT", "SUI",
               "SEI", "INJ", "TIA", "ALGO", "VET", "ICP", "XRP", "XLM", "HBAR", "EGLD", "KAS",
               "STX", "FTM", "S", "LTC", "BCH", "ETC", "CELO", "MINA", "ROSE", "ZIL", "ONE", "FLOW"},
    "l2":     {"ARB", "OP", "POL", "MATIC", "STRK", "MANTA", "METIS", "ZK", "LINEA", "SCR", "BLAST"},
    "defi":   {"UNI", "AAVE", "MKR", "CRV", "SNX", "LDO", "COMP", "SUSHI", "DYDX", "GMX", "JUP",
               "RAY", "CAKE", "PENDLE", "ENA", "ETHFI", "REZ", "EIGEN", "ONDO", "AERO", "MORPHO",
               "DRIFT", "JTO", "PYTH", "CVX", "BAL", "YFI", "KAVA", "OSMO", "RUNE", "INJ"},
    "meme":   {"DOGE", "SHIB", "PEPE", "WIF", "BONK", "FLOKI", "MEME", "BOME", "NEIRO", "PNUT",
               "ACT", "TRUMP", "PENGU", "DOGS", "POPCAT", "MEW", "MOODENG", "GOAT", "FARTCOIN",
               "BRETT", "TURBO", "PEOPLE", "BABYDOGE", "WLD2", "SATS", "ORDI", "RATS", "HIPPO"},
    "ai":     {"FET", "ASI", "RENDER", "TAO", "WLD", "AKT", "IO", "ARKM", "VIRTUAL", "AIXBT",
               "AI16Z", "GRASS", "GRIFFAIN", "ZEREBRO", "COOKIE", "SWARMS", "ARC", "AIXBT"},
    "gaming": {"AXS", "SAND", "MANA", "GALA", "ENJ", "PIXEL", "PORTAL", "BIGTIME", "SUPER",
               "RONIN", "BEAM", "YGG", "ILV", "MAGIC", "PRIME", "XAI", "GMT"},
    "infra":  {"LINK", "FIL", "AR", "GRT", "API3", "BAND", "TRB", "STORJ", "ANKR", "OCEAN",
               "IOTA", "THETA", "HNT", "IOTX", "CKB", "GLM"},
}
CAT_OF_BASE = {}
for _cat, _bases in CATEGORIES.items():
    for _b in _bases:
        CAT_OF_BASE.setdefault(_b, _cat)
SIZE_TIERS = {"large": 30, "mid": 90}  # 按 24h 成交额排序：前 30 大盘 / 前 90 中盘 / 其余小盘
EMA_ALPHA = 0.6           # 权重收缩：新权重 0.6 + 旧权重 0.4（防训练间抖动/过拟合）
TRACKER_MIN_N = 30        # 实盘追踪样本下限，不足则闸门不启用
TRACKER_TOLERANCE = 0.02  # 实盘 IC 允许退化容忍度

DATA_DIR = os.path.abspath(os.environ.get("TQ_DATA_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")))
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
        # 关键：压缩数组的第 j 个有效 SMA 值对应绝对位置 off+kP-1+j（防未来函数）
        off = first[0] + (kP - 1)
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
        # 关键：信号线第 j 个有效值对应绝对位置 off+sig-1+j（防未来函数）
        off = idx[0] + (sig - 1)
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

# ---------------- 八因子引擎（与前端 computeFactors 同构） ----------------
def group_scores(ohlcv, fut=None):
    """fut = (fr_arr, ls_arr, oi_chg_arr) 由 futures_data.align_to_bars 产出；
    为 None 时 futures 组全 0（与前端镜像降级模式一致：缺数据 = 中性）"""
    c = ohlcv[:, 4]; h = ohlcv[:, 2]; l = ohlcv[:, 3]; v = ohlcv[:, 5]
    n = len(c)
    if fut:
        fr_arr, ls_arr, oi_arr = fut
    else:
        fr_arr = ls_arr = oi_arr = [None] * n
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
        # futures（资金费率/多空比/OI 30h 变化率，阈值与前端逐字对齐）
        fr, lsr, oic = fr_arr[i], ls_arr[i], oi_arr[i]
        fr_s = 0.0
        if fr is not None:
            if fr > 0.001: fr_s = -1.0
            elif fr > 0.0005: fr_s = -0.4
            elif fr < -0.001: fr_s = 1.0
            elif fr < -0.0005: fr_s = 0.4
        ls_s = clamp((1.5 - lsr) / 1.5, -1, 1) if lsr is not None else 0.0
        oi_s = 0.0
        if oic is not None:
            if oic > 0.03: oi_s = rdir * 0.8
            elif oic < -0.03: oi_s = -rdir * 0.5
        out["futures"][i] = np.mean([fr_s, ls_s, oi_s])
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
    # aux：状态变量（不参与加权，仅用于条件 IC 分桶与波动率归一）
    logret = np.full(n, np.nan)
    logret[1:] = np.log(c[1:] / c[:-1])
    r2 = np.where(np.isnan(logret), 0.0, logret) ** 2
    sig = np.full(n, np.nan)  # EWMA 波动率（halflife 50 bar，纯因果）
    hl = 50.0
    alpha = 1.0 - math.exp(-math.log(2) / hl)
    acc = 0.0
    for i in range(n):
        acc = alpha * r2[i] + (1 - alpha) * acc
        sig[i] = math.sqrt(acc) if acc > 0 else np.nan
    aux = {"adx": adx, "sig": np.where(sig < 1e-4, 1e-4, sig)}
    return out, aux

# ---------------- 统计工具 ----------------
def spearman(x, y, min_n=30):
    x = np.asarray(x); y = np.asarray(y)
    mask = ~(np.isnan(x) | np.isnan(y))
    x, y = x[mask], y[mask]
    if len(x) < min_n:
        return 0.0
    rx = np.argsort(np.argsort(x)).astype(float)
    ry = np.argsort(np.argsort(y)).astype(float)
    rx -= rx.mean(); ry -= ry.mean()
    denom = math.sqrt((rx ** 2).sum() * (ry ** 2).sum())
    return float((rx * ry).sum() / denom) if denom > 0 else 0.0

def _dcor_value(x, y):
    """距离相关（Székely 2007）：dCor=0 当且仅当统计独立。
    线性 IC≈0 时仍为非零 ⇒ 信息藏在线性模型够不到的高阶矩里。"""
    n = len(x)
    a = np.abs(x[:, None] - x[None, :])
    b = np.abs(y[:, None] - y[None, :])
    A = a - a.mean(axis=0) - a.mean(axis=1)[:, None] + a.mean()
    B = b - b.mean(axis=0) - b.mean(axis=1)[:, None] + b.mean()
    dcov2 = (A * B).mean()
    dvx = (A * A).mean(); dvy = (B * B).mean()
    if dvx <= 0 or dvy <= 0:
        return 0.0
    return float(math.sqrt(max(dcov2, 0.0) / math.sqrt(dvx * dvy)))

def dcor_test(x, y, subsample=DCOR_SUBSAMPLE, perms=DCOR_PERMS, seed=7):
    """带置换检验的 dCor：返回 (dcor, p值)。子采样控制 O(n²) 内存。"""
    x = np.asarray(x, dtype=float); y = np.asarray(y, dtype=float)
    mask = ~(np.isnan(x) | np.isnan(y))
    x, y = x[mask], y[mask]
    if len(x) < 200:
        return None, None
    rng = np.random.default_rng(seed)
    if len(x) > subsample:
        idx = rng.choice(len(x), subsample, replace=False)
        x, y = x[idx], y[idx]
    obs = _dcor_value(x, y)
    cnt = 0
    for _ in range(perms):
        yp = y[rng.permutation(len(y))]
        if _dcor_value(x, yp) >= obs:
            cnt += 1
    return obs, (cnt + 1) / (perms + 1)

def newey_west_t(series, max_lag=None):
    """Newey-West 调整的长记忆 t 统计量：HAC 标准误下的均值显著性。
    |t|<2 ⇒ 无论均值多正都不能声称信息存在（IC 时序自相关会虚增普通 t 值）。"""
    x = np.asarray(series, dtype=float)
    x = x[~np.isnan(x)]
    T = len(x)
    if T < 30:
        return None
    m = x.mean()
    u = x - m
    if max_lag is None:
        max_lag = int(math.floor(4 * (T / 100.0) ** (2.0 / 9.0)))
    gamma0 = float((u * u).mean())
    var = gamma0
    for k in range(1, max_lag + 1):
        gk = float((u[k:] * u[:-k]).mean())
        var += 2 * (1 - k / (max_lag + 1)) * gk
    if var <= 0:
        return None
    return float(m / math.sqrt(var / T))

# ---------------- 实盘追踪数据（模型选择闸门，绝不参与拟合） ----------------
ALL_GROUPS = GROUPS  # futures 已是可学习组，闸门评估用全部 8 组

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
    这是"选币能力"的诚实口径——混合 IC 会被跨币种同涨同跌严重虚增。
    桶内样本量门槛随分段缩小（小分段桶只有 10-30 个币种，显著性由 NW t 把关）。"""
    buckets = {}
    for k in range(len(y)):
        buckets.setdefault(int(ts[k]), []).append(k)
    sp_min = max(5, min(30, min_n))
    ics = [spearman(pred[idx], y[idx], min_n=sp_min) for idx in buckets.values() if len(idx) >= min_n]
    return (float(np.mean(ics)), len(ics), ics) if ics else (None, 0, [])

# ---------------- 数据 ----------------
def get_symbols():
    info = market_get("/exchangeInfo")
    tickers = market_get("/ticker/24hr", timeout=30)
    vol = {t["symbol"]: float(t.get("quoteVolume", 0)) for t in tickers}
    base_of = {}
    syms = []
    for s in info["symbols"]:
        sym = s["symbol"]
        if s.get("quoteAsset") != "USDT" or s.get("status") != "TRADING":
            continue
        if s.get("baseAsset") in EXCLUDE_BASE:
            continue
        if any(x in sym for x in ("UP", "DOWN", "BULL", "BEAR")):
            continue
        syms.append(sym)
        base_of[sym] = s.get("baseAsset", sym.replace("USDT", ""))
    syms.sort(key=lambda s: -vol.get(s, 0))
    syms = syms[:TOP_N]
    # 规模分层（按本次训练池内成交额排名）+ 板块分类 → symbolMeta
    symbol_meta = {}
    for rank, sym in enumerate(syms):
        base = base_of.get(sym, sym.replace("USDT", ""))
        size = "large" if rank < SIZE_TIERS["large"] else ("mid" if rank < SIZE_TIERS["mid"] else "small")
        symbol_meta[sym] = {"size": size, "cat": CAT_OF_BASE.get(base, "other")}
    return syms, symbol_meta

def get_klines(sym):
    """拉取 K 线，LIMIT>1000 自动向历史分页（每页最多 1000 根）；丢弃最后一根未收盘 bar"""
    data = []
    end = None
    remaining = LIMIT
    while remaining > 0:
        lim = min(remaining, 1000)
        url = f"/klines?symbol={quote(sym)}&interval={INTERVAL}&limit={lim}"
        if end is not None:
            url += f"&endTime={end}"
        batch = market_get(url, timeout=25)
        if not batch:
            break
        data = batch + data
        end = int(batch[0][0]) - 1
        remaining -= len(batch)
        if len(batch) < lim:
            break
    arr = np.array([[float(k[0]), float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[5])] for k in data])
    return arr[:-1] if len(arr) else arr

# ---------------- 主流程 ----------------
def main():
    print(f"[train] {datetime.now(timezone.utc).isoformat()} 开始训练")
    symbols, symbol_meta = get_symbols()
    print(f"[train] 币种: {len(symbols)} 个")

    X_rows, t_rows, ts_rows, nn_rows, s_rows = [], [], [], [], []
    sg_rows, adx_rows, fr_rows = [], [], []  # 波动率 / ADX / 资金费率（标签工程与条件 IC 用）
    YH = {hh: [] for hh in DECAY_HORIZONS}
    used = 0
    max_h = max(DECAY_HORIZONS)
    for sym in symbols:
        try:
            ohlcv = get_klines(sym)
            if len(ohlcv) < MIN_BARS:
                continue
            # 合约因子历史（dump 下载失败静默降级为 None → futures 组中性 0）
            t0 = ohlcv[:, 0]
            funding, metrics = load_series(sym, t0[0], t0[-1])
            fut = align_to_bars(t0, funding, metrics)
            gs, aux = group_scores(ohlcv, fut)
            sig_arr = aux["sig"]; adx_arr = aux["adx"]
            fr_arr = fut[0] if fut else [None] * len(ohlcv)
            c = ohlcv[:, 4]
            n = len(c)
            for i in range(200, n - max_h):
                X_rows.append([gs[g][i] for g in GROUPS])
                sg_rows.append(float(sig_arr[i]))
                adx_rows.append(float(adx_arr[i]) if not np.isnan(adx_arr[i]) else np.nan)
                fr_rows.append(float(fr_arr[i]) if fr_arr[i] is not None else np.nan)
                t_rows.append(i); ts_rows.append(t0[i]); nn_rows.append(n); s_rows.append(sym)
                for hh in DECAY_HORIZONS:
                    YH[hh].append(math.log(c[i + hh] / c[i]))
            used += 1
            time.sleep(0.12)  # 礼貌限速
        except Exception as e:
            print(f"[train] {sym} 失败: {e}")
    X = np.array(X_rows); tt = np.array(t_rows)
    ts = np.array(ts_rows); nn = np.array(nn_rows); ss = np.array(s_rows)
    sg = np.array(sg_rows); adx_v = np.array(adx_rows); fr_v = np.array(fr_rows)
    YH = {hh: np.array(v) for hh, v in YH.items()}
    print(f"[train] 样本: {len(ss)} 条（{used} 个币种）")
    if len(ss) < MIN_SAMPLES:
        raise SystemExit("样本不足，放弃本次训练")

    # ---------------- 标签工程 ----------------
    # 1) 多视野短期标签：未来 2/4/8 bar 对数收益取均值（重叠视野平均降噪，避免单一视野樱桃挑选）
    # 2) 波动率归一：y / σ_EWMA —— GLS 思想，消除高波动 regime 主导 OLS
    # 3) 横截面中性化：按时间戳减组均值 —— 去掉不可预测的市场 beta（最大方差源），
    #    与网站实际用途（扫描页同刻选币）对齐
    # 4) 稳健截断：±5×1.4826×MAD —— 抗 crypto 极端离群
    y_multi = np.mean([YH[hh] / sg for hh in FWD_SET], axis=0)
    buckets = {}
    for k in range(len(y_multi)):
        buckets.setdefault(int(ts[k]), []).append(k)
    y_neut = y_multi.copy()
    for idx in buckets.values():
        idx = np.array(idx)
        y_neut[idx] = y_multi[idx] - y_multi[idx].mean()
    med = np.median(y_neut)
    mad = np.median(np.abs(y_neut - med)) * 1.4826
    clip = 5 * mad if mad > 0 else np.std(y_neut) * 5
    y = np.clip(y_neut, med - clip, med + clip)
    print(f"[train] 标签工程: 视野{FWD_SET} · MAD截断±{clip:.4f} · σ中位 {np.median(sg):.5f}")

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
    ic_xs, xs_buckets, xs_ic_series = cross_sectional_ic(pred_te, yte, ts[test_mask])
    # XS IC 的 Newey-West t：时序自相关调整后的显著性（闸门硬指标）
    nw_t = newey_west_t(xs_ic_series)
    # 诚实口径 1b：XS IC 对原始 4bar 收益（与历史版本可比的口径）
    ic_xs_raw4, _, _ = cross_sectional_ic(pred_te, YH[4][test_mask], ts[test_mask])
    # 诚实口径 2：单币种时间序列 IC 取分布——"单币择时能力"
    ps_ics = []
    for s in np.unique(ss[test_mask]):
        m = ss[test_mask] == s
        if m.sum() >= 50:
            ps_ics.append(spearman(pred_te[m], yte[m]))
    ps_ics = np.array(ps_ics) if ps_ics else np.array([0.0])
    ic_ps_mean = float(ps_ics.mean()); ic_ps_med = float(np.median(ps_ics))
    ic_ps_worst = float(ps_ics.min()); ic_ps_best = float(ps_ics.max())

    # IC 衰减曲线：对原始收益的 OOS 相关（缓慢衰减=真实信号，暴跌=噪声）
    ic_decay = {}
    for hh in DECAY_HORIZONS:
        ic_decay[str(hh)] = round(spearman(pred_te, YH[hh][test_mask]), 4)

    # ---------------- 信息存在性检验（回答"信息在不在"，而非"模型够不够"） ----------------
    # 1) 距离相关 dCor：dCor=0 当且仅当统计独立。线性 IC≈0 而 dCor 显著非零
    #    ⇒ 信息存在但藏在线性模型够不到的高阶矩；dCor≈0 ⇒ 换信息源而非换模型
    dcor_res = {}
    for j, g in enumerate(GROUPS):
        dv, pv = dcor_test(Xte[:, j], yte)
        if dv is not None:
            dcor_res[g] = {"dcor": round(dv, 4), "p": round(pv, 3)}
    dv_all, pv_all = dcor_test(pred_te, yte)
    if dv_all is not None:
        dcor_res["_composite"] = {"dcor": round(dv_all, 4), "p": round(pv_all, 3)}
    print(f"[train] dCor: {json.dumps(dcor_res)}")

    # 2) 条件 IC：按市场状态（ADX/波动率/资金费率 tercile）切桶。
    #    无条件 IC≈0 但某桶内显著 ⇒ 信息是条件存在的 ⇒ 需要状态切换而非全局加权
    def cond_ic(var_vals, name):
        v = var_vals[test_mask]
        valid = ~np.isnan(v)
        out = {}
        if valid.sum() < 3000:
            return out
        qs = np.quantile(v[valid], [1/3, 2/3])
        labels = np.where(v <= qs[0], "低", np.where(v <= qs[1], "中", "高"))
        for lab in ("低", "中", "高"):
            m = valid & (labels == lab)
            if m.sum() >= 1500:
                out[lab] = round(spearman(pred_te[m], yte[m]), 4)
        return out
    conditional_ic = {
        "byAdx": cond_ic(adx_v, "adx"),
        "byVol": cond_ic(sg, "vol"),
        "byFunding": cond_ic(fr_v, "fr"),
    }
    print(f"[train] 条件IC: {json.dumps(conditional_ic, ensure_ascii=False)}")

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

    # 多空五分位价差（样本外，标签为波动率归一单位）
    q = np.quantile(pred_te, [0.2, 0.8])
    top = yte[pred_te >= q[1]]; bot = yte[pred_te <= q[0]]
    spread = float(top.mean() - bot.mean()) if len(top) and len(bot) else 0.0
    ls_rets = np.concatenate([top, -bot])
    mean_h = float(np.mean(FWD_SET))
    ls_sharpe = float(ls_rets.mean() / ls_rets.std() * math.sqrt(8760 / mean_h)) if ls_rets.std() > 0 else 0.0

    # ---------------- 分段专业化模型（规模 × 板块） ----------------
    # meme 由情绪/资金费率驱动、major 由宏观 beta 驱动，混合训练会互相稀释。
    # 每段独立岭回归（同一套工程化标签），样本不足自动跳过，前端按币种分段取权重。
    segments = {}
    seg_keys = [("size", v) for v in ("large", "mid", "small")]
    seg_keys += [("cat", c) for c in sorted({m["cat"] for m in symbol_meta.values()})]
    for kind, val in seg_keys:
        members = {s for s, m in symbol_meta.items() if m[kind] == val}
        seg_mask = np.array([s in members for s in ss])
        tr_m = seg_mask & train_mask
        te_m = seg_mask & test_mask
        n_syms = len({s for s in ss[tr_m]})
        if tr_m.sum() < SEG_MIN_SAMPLES or te_m.sum() < 4000 or n_syms < SEG_MIN_SYMS:
            continue
        mu_s = X[tr_m].mean(axis=0); sd_s = X[tr_m].std(axis=0); sd_s[sd_s == 0] = 1
        Ztr_s = (X[tr_m] - mu_s) / sd_s
        Zte_s = (X[te_m] - mu_s) / sd_s
        A_s = Ztr_s.T @ Ztr_s + RIDGE_LAMBDA * np.eye(d)
        w_std_s = np.linalg.solve(A_s, Ztr_s.T @ y[tr_m])
        w_raw_s = w_std_s / sd_s
        pred_s = Zte_s @ w_std_s
        ic_xs_s, _, ics_s = cross_sectional_ic(pred_s, y[te_m], ts[te_m])
        nw_s = newey_west_t(ics_s)
        absum_s = float(np.sum(np.abs(w_raw_s)))
        w_norm = {g: float(w_raw_s[j]) / absum_s for j, g in enumerate(GROUPS)} if absum_s > 0 else None
        # 段内评分尺度（横截面标准差中位数，口径同全局 scoreScale）
        w_vec_s = np.array([w_norm[g] for g in GROUPS]) if w_norm else np.zeros(d)
        comp_s = X[seg_mask] @ w_vec_s
        sb = {}
        ts_seg = ts[seg_mask]
        for k in range(len(comp_s)):
            sb.setdefault(int(ts_seg[k]), []).append(comp_s[k])
        xs_stds_s = [float(np.std(vv)) for vv in sb.values() if len(vv) >= 5]
        scale_s = float(np.median(xs_stds_s)) if xs_stds_s else 1.0
        # 采用判定（对称阈值）：显著为正 → 正向启用；显著为负 → 反向启用（取负权重）。
        # IC=-0.03 且 t=-2.4 不是"无效"，是反向有效——和正信号一样有价值，弃用是浪费
        flipped = False
        good = False
        if ic_xs_s is not None and nw_s is not None:
            if ic_xs_s >= 0.015 and nw_s >= 2.0:
                good = True
            elif ic_xs_s <= -0.015 and nw_s <= -2.0 and w_norm is not None:
                good = True
                flipped = True
                w_norm = {g: -w_norm[g] for g in GROUPS}  # 预测反向 = 权重取负
        segments[f"{kind}:{val}"] = {
            "weights": {g: round(w_norm[g], 4) for g in GROUPS} if w_norm else None,
            "scoreScale": round(scale_s, 8) if scale_s > 1e-8 else 1.0,
            "icXS": round(ic_xs_s, 4) if ic_xs_s is not None else None,
            "nwT": round(nw_s, 2) if nw_s is not None else None,
            "n": int(tr_m.sum()), "symbols": n_syms, "good": bool(good), "flipped": bool(flipped),
        }
        tag = "反向启用" if flipped else ("可用" if good else "观察")
        print(f"[train] 分段 {kind}:{val} n={tr_m.sum()} 币={n_syms} XS_IC={ic_xs_s if ic_xs_s is None else round(ic_xs_s, 4)} t={None if nw_s is None else round(nw_s, 2)} {tag}")

    # ---------------- 非线性对照实验：ExtraTrees vs Ridge ----------------
    # dCor 显著 ⇒ 非线性成分存在，但不保证当前样本量能提取 —— 实验说了算。
    # 判据：ET−Ridge > 0.01 且蒸馏后仍 > Ridge + 0.005 → 采纳蒸馏权重
    # （蒸馏 = Ridge 拟合 ET 训练集预测 → 等效线性权重，前端零改动可用）
    et_report = {}
    distilled_global = None
    try:
        from sklearn.ensemble import ExtraTreesRegressor
        ET_K = int(os.environ.get("TQ_ET_FOLDS", "5"))
        ET_TREES = int(os.environ.get("TQ_ET_TREES", "300"))

        def et_experiment(mask_all, name):
            fr = tt / nn
            r_ics, e_ics, d_ics = [], [], []
            w_last = None
            for f in range(ET_K):
                lo, hi = f / ET_K, (f + 1) / ET_K
                te_f = mask_all & (fr >= lo) & (fr < hi)
                tr_f = mask_all & ((fr < lo - EMBARGO / nn) | (fr >= hi + EMBARGO / nn))
                if te_f.sum() < 3000 or tr_f.sum() < 8000:
                    continue
                mu_f = X[tr_f].mean(axis=0); sd_f = X[tr_f].std(axis=0); sd_f[sd_f == 0] = 1
                Ztr_f = (X[tr_f] - mu_f) / sd_f
                Zte_f = (X[te_f] - mu_f) / sd_f
                ytr_f = y[tr_f]
                A_f = Ztr_f.T @ Ztr_f + RIDGE_LAMBDA * np.eye(d)
                w_r = np.linalg.solve(A_f, Ztr_f.T @ ytr_f)
                ic_r, _, _ = cross_sectional_ic(Zte_f @ w_r, y[te_f], ts[te_f])
                et = ExtraTreesRegressor(n_estimators=ET_TREES, max_depth=5, min_samples_leaf=50,
                                         max_features=0.5, n_jobs=-1, random_state=42)
                et.fit(Ztr_f, ytr_f)
                ic_e, _, _ = cross_sectional_ic(et.predict(Zte_f), y[te_f], ts[te_f])
                w_d = np.linalg.solve(A_f, Ztr_f.T @ et.predict(Ztr_f))
                ic_d, _, _ = cross_sectional_ic(Zte_f @ w_d, y[te_f], ts[te_f])
                if ic_r is not None and ic_e is not None and ic_d is not None:
                    r_ics.append(ic_r); e_ics.append(ic_e); d_ics.append(ic_d)
                    w_last = w_d / sd_f
            if not r_ics:
                return None
            rep = {"ridge": round(float(np.mean(r_ics)), 4), "et": round(float(np.mean(e_ics)), 4),
                   "distilled": round(float(np.mean(d_ics)), 4), "folds": len(r_ics)}
            rep["improvement"] = round(rep["et"] - rep["ridge"], 4)
            rep["adopted"] = bool(rep["improvement"] > 0.01 and rep["distilled"] > rep["ridge"] + 0.005)
            return rep, w_last

        exp_targets = [("global", np.ones(len(y), dtype=bool), None)]
        for k_, v_ in segments.items():
            kind_, val_ = k_.split(":")
            members_ = {s for s, m in symbol_meta.items() if m[kind_] == val_}
            exp_targets.append((k_, np.array([s in members_ for s in ss]), k_))
        for name, mask_e, seg_key in exp_targets:
            r = et_experiment(mask_e, name)
            if r is None:
                continue
            rep, w_dist = r
            et_report[name] = rep
            verdict = "采纳蒸馏" if rep["adopted"] else "保留Ridge"
            print(f"[train] ET实验 {name}: Ridge={rep['ridge']} ET={rep['et']} 蒸馏={rep['distilled']} Δ={rep['improvement']} → {verdict}")
            if rep["adopted"] and w_dist is not None:
                absum_d = float(np.sum(np.abs(w_dist)))
                if absum_d > 0:
                    w_dn = {g: float(w_dist[j]) / absum_d for j, g in enumerate(GROUPS)}
                    if seg_key is None:
                        distilled_global = w_dn
                    else:
                        segments[seg_key]["weights"] = {g: round(w_dn[g], 4) for g in GROUPS}
                        segments[seg_key]["modelType"] = "et-distilled"
                        segments[seg_key]["good"] = True
                        segments[seg_key]["flipped"] = False
    except ImportError:
        print("[train] sklearn 不可用，跳过非线性对照实验")

    # 权重映射：全部 8 个可学习组归一化到 L1 = 1.0
    absum = float(np.sum(np.abs(w_raw)))
    scale = 1.0 / absum if absum > 0 else 0
    learned_weights = distilled_global if distilled_global is not None else {g: float(w_raw[j]) * scale for j, g in enumerate(GROUPS)}

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

    # EMA 收缩：新 0.6 / 旧 0.4，再归一化（L1 = 1.0）
    shrunk = {g: EMA_ALPHA * learned_weights[g] + (1 - EMA_ALPHA) * float(prev_weights.get(g, 0)) for g in GROUPS}
    absum2 = float(sum(abs(v) for v in shrunk.values()))
    if absum2 > 0:
        shrunk = {g: v / absum2 for g, v in shrunk.items()}
    candidate = {g: round(shrunk[g], 4) for g in GROUPS}

    # ---------------- 全币种分层自适应模型 ----------------
    # 每币都有独立档案；只有多折时间外推、NW 显著性和父模型增量同时达标才晋级。
    # 未晋级者进入影子模式继续学习，前端不会因为“必须有模型”而采用噪声权重。
    def parent_weights_of(sym):
        meta = symbol_meta.get(sym, {})
        cs = segments.get("cat:" + str(meta.get("cat")))
        if cs and cs.get("good") and cs.get("weights"):
            return cs["weights"]
        zs = segments.get("size:" + str(meta.get("size")))
        if zs and zs.get("good") and zs.get("weights"):
            return zs["weights"]
        return candidate

    from coin_models import train_all_coin_models
    coin_models = train_all_coin_models(
        X=X, y=y, ss=ss, tt=tt, nn=nn, symbol_meta=symbol_meta,
        parent_weights_of=parent_weights_of, spearman=spearman,
        newey_west_t=newey_west_t, groups=GROUPS, embargo=EMBARGO,
        hgb_enabled=os.environ.get("TQ_COIN_HGB", "1") not in ("0", "false", "False"),
    )
    active_coin_models = sum(v.get("status") == "active" for v in coin_models.values())

    # 闸门 1：信息显著性硬门槛——横截面 IC（选币能力，对工程化标签）必须为正且
    # Newey-West t ≥ 2（时序自相关调整后的显著性，防止 IC 均值被自相关虚增）
    accepted = True
    reject_reasons = []
    if ic_xs is None or ic_xs < MIN_XS_IC:
        accepted = False
        reject_reasons.append(f"横截面IC {None if ic_xs is None else round(ic_xs, 4)} < {MIN_XS_IC}")
    if nw_t is None or nw_t < MIN_NW_T:
        accepted = False
        reject_reasons.append(f"XS IC 的 NW t {None if nw_t is None else round(nw_t, 2)} < {MIN_NW_T}（不显著）")

    # 闸门 2：实盘追踪 IC（仅模型选择，不参与拟合；样本不足则跳过）
    tracker_rows = load_tracker()
    tk_ic_new = tracker_ic(candidate, tracker_rows) if len(tracker_rows) >= TRACKER_MIN_N else None
    tk_ic_prev = tracker_ic(prev_weights, tracker_rows) if len(tracker_rows) >= TRACKER_MIN_N else None
    if tk_ic_new is not None and tk_ic_prev is not None:
        if tk_ic_new < tk_ic_prev - TRACKER_TOLERANCE:
            accepted = False
            reject_reasons.append(f"实盘追踪IC退化 {tk_ic_new:.4f} < {tk_ic_prev:.4f} - {TRACKER_TOLERANCE}")

    final_weights = candidate if accepted else {g: round(float(prev_weights.get(g, 0)), 4) for g in ALL_GROUPS}
    for g in GROUPS:
        final_weights.setdefault(g, 0.0)

    tracker_info = {
        "n": len(tracker_rows),
        "icNew": round(tk_ic_new, 4) if tk_ic_new is not None else None,
        "icPrev": round(tk_ic_prev, 4) if tk_ic_prev is not None else None,
        "gate": "applied" if tk_ic_new is not None else "skipped(<30样本)",
    }

    trained_at = datetime.now(timezone.utc).isoformat(timespec="seconds")

    # 评分标定：学习权重含正负号会系统性压缩综合评分尺度（排序能力不受影响）。
    # 关键细节：必须用「横截面标准差」（每个时间戳内各币种评分的离散度，取中位数），
    # 而不是混合标准差——扫描页比较的是同一时刻的币种间差异，混合口径含时间序列波动会高估。
    w_vec = np.array([final_weights.get(g, 0.0) for g in GROUPS])
    comp_all = X @ w_vec
    buckets = {}
    for k in range(len(comp_all)):
        buckets.setdefault(int(ts[k]), []).append(comp_all[k])
    xs_stds = [float(np.std(v)) for v in buckets.values() if len(v) >= 5]
    score_scale = float(np.median(xs_stds)) if xs_stds else float(np.std(comp_all))
    if score_scale <= 1e-8:
        score_scale = 1.0
    print(f"[train] 评分尺度 scoreScale(横截面): {score_scale:.6f}（混合 {float(np.std(comp_all)):.6f}）")

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
        "fwdSet": FWD_SET,
        "weights": final_weights,
        "factorIC": factor_ic,
        "icInSample": round(ic_in, 4),
        "icOOS": round(ic_oos, 4),
        "icXS": round(ic_xs, 4) if ic_xs is not None else None,
        "icXSRaw4": round(ic_xs_raw4, 4) if ic_xs_raw4 is not None else None,
        "nwT": round(nw_t, 2) if nw_t is not None else None,
        "icPerSym": round(ic_ps_mean, 4),
        "icPerSymMedian": round(ic_ps_med, 4),
        "icDecay": ic_decay,
        "gapInOut": round(gap_in_out, 4),
        "randIC": {"mean": round(float(rand_ics.mean()), 4), "std": round(float(rand_ics.std()), 4),
                   "percentile": round(rand_pct, 4)},
        "lsSpread": round(spread, 6),
        "lsSharpeOOS": round(ls_sharpe, 2),
        "dcor": dcor_res,
        "conditionalIC": conditional_ic,
        "segments": {k: {kk: v[kk] for kk in ("icXS", "nwT", "n", "symbols", "good") if kk in v} | {"flipped": v.get("flipped", False), "modelType": v.get("modelType", "ridge")} for k, v in segments.items()},
        "etExperiments": et_report,
        "coinModels": {
            "covered": len(coin_models), "adopted": active_coin_models,
            "shadow": sum(v.get("status") == "shadow" for v in coin_models.values()),
            "warmup": sum(v.get("status") == "warmup" for v in coin_models.values()),
            "hgb": sum(v.get("status") == "active" and v.get("hgbBlend", 0) > 0 for v in coin_models.values()),
            "icMean": round(float(np.mean([v["ic"] for v in coin_models.values() if v.get("ic") is not None])), 4)
                      if any(v.get("ic") is not None for v in coin_models.values()) else None,
        },
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
        "engine": "ridge-v7-coin-ensemble",
        "fwdSet": FWD_SET,
        "weights": final_weights,
        "scoreScale": round(score_scale, 8),
        "staticWeights": STATIC_WEIGHTS,
        "segments": segments,
        "symbolMeta": symbol_meta,
        "coinModels": coin_models,
        "etExperiments": et_report,
        "factorIC": factor_ic,
        "oos": {"ic": round(ic_oos, 4), "icInSample": round(ic_in, 4),
                "icXS": round(ic_xs, 4) if ic_xs is not None else None,
                "icXSRaw4": round(ic_xs_raw4, 4) if ic_xs_raw4 is not None else None,
                "nwT": round(nw_t, 2) if nw_t is not None else None,
                "icPerSymbolMean": round(ic_ps_mean, 4), "icPerSymbolMedian": round(ic_ps_med, 4),
                "gapInOut": round(gap_in_out, 4),
                "lsSpread": round(spread, 6), "lsSharpe": round(ls_sharpe, 2)},
        "diagnostics": {
            "icDecay": ic_decay,
            "perSymbol": {"mean": round(ic_ps_mean, 4), "median": round(ic_ps_med, 4),
                          "worst": round(ic_ps_worst, 4), "best": round(ic_ps_best, 4)},
            "randomIC": {"mean": round(float(rand_ics.mean()), 4), "std": round(float(rand_ics.std()), 4),
                         "percentile": round(rand_pct, 4)},
            "dcor": dcor_res,
            "conditionalIC": conditional_ic,
            "xsBuckets": xs_buckets,
            "embargo": EMBARGO,
        },
        "accepted": accepted,
        "rejectReason": "; ".join(reject_reasons),
        "tracker": tracker_info,
        "meta": {"symbols": used, "samples": int(len(y)), "interval": INTERVAL,
                 "ridgeLambda": RIDGE_LAMBDA, "alpha": EMA_ALPHA, "embargo": EMBARGO,
                 "label": f"mh{'-'.join(map(str, FWD_SET))}_volnorm_xsneutral_clip5mad",
                 "note": "标签=短期多视野(2/4/8bar)均值×波动率归一×横截面中性×MAD截断；闸门=XS IC≥0.02且NW t≥2；分段模型按规模/板块独立训练，前端按币种分段取权重(good=true才启用)；dCor检验非线性信息存在性，条件IC按ADX/波动/资金费率分桶；实盘追踪仅用于闸门不参与拟合"},
    }
    with open(os.path.join(DATA_DIR, "model.json"), "w", encoding="utf-8") as f:
        json.dump(model, f, ensure_ascii=False, indent=1)

    status = "接受" if accepted else f"拒绝（{'; '.join(reject_reasons)}）"
    print(f"[train] v{version} 完成 | 横截面IC {ic_xs if ic_xs is None else round(ic_xs, 4)} (原始4bar口径 {ic_xs_raw4 if ic_xs_raw4 is None else round(ic_xs_raw4, 4)}) | NW t {None if nw_t is None else round(nw_t, 2)} | 单币种IC 均值 {ic_ps_mean:.4f} | 混合IC {ic_oos:.4f}(参考) | 更新{status}")
    print(f"[train] IC衰减 {json.dumps(ic_decay)} | 随机对照分位 {rand_pct:.1%} | 样本内外差距 {gap_in_out:.4f}")
    if tk_ic_new is not None:
        print(f"[train] 实盘追踪: n={len(tracker_rows)} IC 新 {tk_ic_new:.4f} / 旧 {tk_ic_prev:.4f}")
    print(f"[train] 权重: {json.dumps(final_weights, ensure_ascii=False)}")

if __name__ == "__main__":
    main()
