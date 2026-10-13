# 离线冒烟测试：合成数据驱动 train.py 全流程（网络不可用时验证新代码路径）
import os, sys, math
import numpy as np

os.environ.setdefault("TQ_TOP_N", "12")
os.environ.setdefault("TQ_LIMIT", "1200")
os.environ.setdefault("TQ_MIN_SAMPLES", "20000")
os.environ.setdefault("TQ_DCOR_SUB", "800")
os.environ.setdefault("TQ_DCOR_PERMS", "10")
os.environ.setdefault("TQ_ET_FOLDS", "2")
os.environ.setdefault("TQ_ET_TREES", "40")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import train  # noqa: E402

SYMS = [f"COIN{i}USDT" for i in range(12)]
CATS = ["major", "l1", "defi", "meme", "ai", "gaming"]

def fake_get_symbols():
    meta = {}
    for i, s in enumerate(SYMS):
        size = "large" if i < 4 else ("mid" if i < 8 else "small")
        meta[s] = {"size": size, "cat": CATS[i % len(CATS)]}
    return SYMS, meta

def fake_get_klines(sym):
    rng = np.random.default_rng(abs(hash(sym)) % (2**32))
    n = 4500
    rets = rng.normal(0, 0.008, n)
    for i in range(1, n):
        rets[i] += -0.35 * rets[i - 1]   # 注入短期反转 → 因子应能预测（验证采纳路径）
    close = 100 * np.exp(np.cumsum(rets))
    open_ = np.roll(close, 1); open_[0] = close[0]
    high = np.maximum(open_, close) * (1 + np.abs(rng.normal(0, 0.003, n)))
    low = np.minimum(open_, close) * (1 - np.abs(rng.normal(0, 0.003, n)))
    vol = np.abs(rng.normal(1e6, 3e5, n))
    t0 = 1700000000000 + np.arange(n) * 3600000
    return np.column_stack([t0, open_, high, low, close, vol])

train.get_symbols = fake_get_symbols
train.get_klines = fake_get_klines
train.load_series = lambda sym, a, b: (None, None)
train.align_to_bars = lambda t0, f, m: None
train.SEG_MIN_SAMPLES = 1500   # 小样本测试环境放宽分段门槛
train.SEG_MIN_SYMS = 2

train.main()
print("[offline-test] 全流程完成")
