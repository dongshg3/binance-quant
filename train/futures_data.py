#!/usr/bin/env python3
# ============================================================
# futures_data.py · 合约因子历史数据（data.binance.vision 月度 dump）
# 为什么不用 fapi 实时 API：GitHub Actions 在美国 IP，fapi 对其 451 封锁；
# data.binance.vision 是官方静态数据站，免费公开、全球可达。
# 数据：
#   fundingRate 月度 zip：calc_time(ms), funding_interval_hours, last_funding_rate
#   metrics     日度 zip（无月度文件）：5 分钟快照，create_time 为 UTC 字符串，
#               含 sum_open_interest / count_long_short_ratio
# 对齐规则：每根 K 线只使用「不晚于该 bar 开盘时刻」的最新值（无未来函数）。
# ============================================================
import csv
import io
import os
import time
import urllib.request
import zipfile
from bisect import bisect_right
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

BASE = "https://data.binance.vision/data/futures/um"
CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data_cache", "futures")
os.makedirs(CACHE_DIR, exist_ok=True)

UA = {"User-Agent": "binance-quant-trainer/1.0"}

def parse_ts(v):
    """时间戳解析：兼容毫秒整数与 'YYYY-MM-DD HH:MM:SS' UTC 字符串"""
    try:
        return int(v)
    except (TypeError, ValueError):
        return int(datetime.strptime(v, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).timestamp() * 1000)

def months_covering(start_ms, end_ms):
    """覆盖 [start, end] 的全部自然月，格式 YYYY-MM"""
    out = []
    d = datetime.fromtimestamp(start_ms / 1000, tz=timezone.utc).replace(day=1)
    end_d = datetime.fromtimestamp(end_ms / 1000, tz=timezone.utc)
    while d <= end_d:
        out.append(f"{d.year:04d}-{d.month:02d}")
        d = d.replace(year=d.year + 1, month=1) if d.month == 12 else d.replace(month=d.month + 1)
    return out

def days_covering(start_ms, end_ms):
    """覆盖 [start, end] 的全部自然日，格式 YYYY-MM-DD"""
    out = []
    d = datetime.fromtimestamp(start_ms / 1000, tz=timezone.utc).replace(hour=0, minute=0, second=0)
    end_d = datetime.fromtimestamp(end_ms / 1000, tz=timezone.utc)
    while d <= end_d:
        out.append(d.strftime("%Y-%m-%d"))
        d += timedelta(days=1)
    return out

def _download(url, timeout=30, retries=3):
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # noqa
            last = e
            time.sleep(1.0 * (i + 1))
    raise last

def _load_zip_csv(symbol, dataset, period, freq):
    """freq='monthly'|'daily'；历史文件走本地缓存，当期文件每次重下（会滚动更新）"""
    fname = f"{symbol}-{dataset}-{period}.zip"
    fpath = os.path.join(CACHE_DIR, fname)
    now = datetime.now(timezone.utc)
    current = now.strftime("%Y-%m") if freq == "monthly" else now.strftime("%Y-%m-%d")
    if os.path.exists(fpath) and period != current:
        with open(fpath, "rb") as f:
            blob = f.read()
    else:
        blob = _download(f"{BASE}/{freq}/{dataset}/{symbol}/{fname}")
        if period != current:
            with open(fpath, "wb") as f:
                f.write(blob)
    z = zipfile.ZipFile(io.BytesIO(blob))
    with z.open(z.namelist()[0]) as f:
        return list(csv.DictReader(io.TextIOWrapper(f, encoding="utf-8")))

def load_series(symbol, bar_start_ms, bar_end_ms):
    """下载某币种覆盖区间的 fundingRate(月) + metrics(日)，返回按时间排序的
    funding=[(ms, rate)]，metrics=[(ms, oi, ls_ratio)]；任何失败静默降级为空列表"""
    funding, metrics = [], []
    months = months_covering(bar_start_ms, bar_end_ms)
    days = days_covering(bar_start_ms, bar_end_ms)

    def one_funding(month):
        rows = []
        try:
            for r in _load_zip_csv(symbol, "fundingRate", month, "monthly"):
                try:
                    rows.append((parse_ts(r["calc_time"]), float(r["last_funding_rate"])))
                except (KeyError, ValueError, TypeError):
                    continue
        except Exception:
            pass
        return rows

    def one_metrics(day):
        rows = []
        try:
            for r in _load_zip_csv(symbol, "metrics", day, "daily"):
                try:
                    rows.append((parse_ts(r["create_time"]), float(r["sum_open_interest"]),
                                 float(r["count_long_short_ratio"])))
                except (KeyError, ValueError, TypeError):
                    continue
        except Exception:
            pass
        return rows

    with ThreadPoolExecutor(max_workers=8) as ex:
        for rows in ex.map(one_funding, months):
            funding.extend(rows)
        for rows in ex.map(one_metrics, days):
            metrics.extend(rows)
    funding.sort(key=lambda x: x[0])
    metrics.sort(key=lambda x: x[0])
    return funding, metrics

def align_to_bars(bar_times_ms, funding, metrics, oi_window_ms=30 * 3600 * 1000):
    """把 funding / 多空比 / OI 30h 变化率对齐到每根 bar（仅用 ≤ bar 开盘时刻的值）。
    返回 (fr_arr, ls_arr, oi_chg_arr)，缺失为 None。与前端定义逐字对齐：
      fundingRate  → premiumIndex.lastFundingRate（最近 funding 事件）
      多空比       → globalLongShortAccountRatio（账户数多空比）
      OI 变化率    → openInterestHist 30 期首尾比值 - 1"""
    n = len(bar_times_ms)
    fr_t = [t for t, _ in funding]
    me_t = [t for t, _, _ in metrics]
    fr_out, ls_out, oi_out = [None] * n, [None] * n, [None] * n
    for i in range(n):
        t = bar_times_ms[i]
        j = bisect_right(fr_t, t) - 1
        if j >= 0:
            fr_out[i] = funding[j][1]
        k = bisect_right(me_t, t) - 1
        if k >= 0:
            ls_out[i] = metrics[k][2]
            k0 = bisect_right(me_t, t - oi_window_ms) - 1
            if k0 >= 0 and metrics[k0][1] > 0:
                oi_out[i] = metrics[k][1] / metrics[k0][1] - 1
    return fr_out, ls_out, oi_out
