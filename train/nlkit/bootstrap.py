#!/usr/bin/env python3
# ============================================================
# nlkit/bootstrap.py · 云端冷启动（GitHub Actions 上没有本地缓存）
# ------------------------------------------------------------
# train.yml 每小时/6 小时的训练都跑在 ubuntu runner 上，那台机器每次都是全新的：
# cache_drift 不存在。所以云端迭代必须先能"从零建库"。
# 这里只用 REST 分页拉 K 线（每币 4000 根 = 3 次请求），不碰任何月度 zip，
# 避免一次性下载历史期货数据包导致作业超时。
# ============================================================
from __future__ import annotations

import os
import sys
import time
import urllib.request
import urllib.error
import json

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
TRAIN_DIR = os.path.dirname(HERE)
CACHE = os.path.join(TRAIN_DIR, "cache_drift")
FAPI = "https://fapi.binance.com"
BARS = int(os.environ.get("NL_BOOT_BARS", "4000"))
TOP_N = int(os.environ.get("NL_TOP_N", "60"))
UA = {"User-Agent": "nlkit-bootstrap/1.0"}


def _get(path: str, params: dict | None = None, timeout: float = 20.0):
    url = FAPI + path
    if params:
        url += "?" + "&".join(f"{k}={v}" for k, v in params.items())
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            # 429/418 是币安的限频/封禁信号：必须按 Retry-After 等待，硬重试只会加重
            if e.code in (429, 418):
                wait = float(e.headers.get("Retry-After") or 5)
                print(f"[bootstrap] 触发限频 {e.code}，等待 {wait:.0f}s", flush=True)
                time.sleep(min(wait, 60))
                continue
            if attempt == 3:
                raise
            time.sleep(1.0 + attempt)
        except Exception:
            if attempt == 3:
                raise
            time.sleep(1.0 + attempt)


def pick_symbols() -> list[str]:
    """按 24h 成交额取前 N 个 USDT 永续，排除稳定币/锚定资产/代币化股票。"""
    sys.path.insert(0, TRAIN_DIR)
    import train as T  # noqa: PLC0415

    info = _get("/fapi/v1/exchangeInfo")
    perp = {s["symbol"] for s in info["symbols"]
            if s.get("contractType") == "PERPETUAL" and s.get("status") == "TRADING"
            and s.get("quoteAsset") == "USDT"}
    tickers = _get("/fapi/v1/ticker/24hr")
    rows = [(t["symbol"], float(t.get("quoteVolume", 0) or 0)) for t in tickers
            if t["symbol"] in perp]
    rows.sort(key=lambda x: -x[1])

    pegged = {"PAXG", "XAUT", "EUR", "RLUSD", "BFUSD", "XUSD", "USDC", "FDUSD", "DAI", "USDP"}
    out = []
    for sym, _vol in rows:
        base = sym[:-4]
        if base in T.EXCLUDE_BASE or base in pegged:
            continue
        if len(base) >= 4 and base.endswith("B"):   # 代币化股票/指数合约
            continue
        out.append(sym)
        if len(out) >= TOP_N:
            break
    return out


def fetch_klines(sym: str, bars: int = BARS) -> np.ndarray:
    """从最新往回分页拉 bars 根 1h K 线，返回按时间升序的 (n,6)。"""
    got: list[list[float]] = []
    end = None
    while len(got) < bars:
        params = {"symbol": sym, "interval": "1h", "limit": 1500}
        if end:
            params["endTime"] = end
        chunk = _get("/fapi/v1/klines", params)
        if not chunk:
            break
        rows = [[float(k[0]), float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[5])]
                for k in chunk]
        got = rows + got
        end = int(rows[0][0]) - 1
        if len(chunk) < 1500:
            break
    arr = np.array(got, dtype=np.float64)
    return arr[-bars:] if len(arr) > bars else arr


def _ffill(bar_ms, src_ms, src_v):
    out = np.full(len(bar_ms), np.nan)
    if len(src_ms) == 0:
        return out
    i = np.searchsorted(src_ms, bar_ms, side="right") - 1
    ok = i >= 0
    out[ok] = src_v[i[ok]]
    return out


def build_one(sym: str) -> dict:
    import train as T  # noqa: PLC0415
    ohlcv = fetch_klines(sym)
    if len(ohlcv) < 800:
        return {"ok": False, "sym": sym, "reason": f"bar 太少 {len(ohlcv)}"}
    bar = ohlcv[:, 0]
    fr = np.full(len(bar), np.nan)
    ls = np.full(len(bar), np.nan)
    oi = np.full(len(bar), np.nan)
    try:
        f = _get("/fapi/v1/fundingRate", {"symbol": sym, "limit": 1000})
        if f:
            _ffill(bar, np.array([float(x["fundingTime"]) for x in f]),
                   np.array([float(x["fundingRate"]) for x in f]))
            fr = _ffill(bar, np.array([float(x["fundingTime"]) for x in f]),
                        np.array([float(x["fundingRate"]) for x in f]))
    except Exception:
        pass
    for path, key, target in (("/futures/data/globalLongShortAccountRatio", "longShortRatio", "ls"),
                              ("/futures/data/openInterestHist", "sumOpenInterest", "oi")):
        try:
            a = _get(path, {"symbol": sym, "period": "1h", "limit": 500})
            if a:
                v = _ffill(bar, np.array([float(x["timestamp"]) for x in a]),
                           np.array([float(x[key]) for x in a]))
                if target == "ls":
                    ls = v
                else:
                    oi = v
        except Exception:
            pass

    os.makedirs(CACHE, exist_ok=True)
    np.savez_compressed(os.path.join(CACHE, f"{sym}_raw.npz"),
                        ohlcv=ohlcv, fr=fr, ls=ls, oi=oi)
    gs, aux = T.group_scores(ohlcv, (list(fr), list(ls), list(oi)))
    X = np.column_stack([gs[g] for g in T.GROUPS])
    np.savez_compressed(os.path.join(CACHE, f"{sym}_feat.npz"),
                        X=X, sig=aux["sig"], adx=aux["adx"], c=ohlcv[:, 4],
                        t0=ohlcv[:, 0], fr=fr)
    return {"ok": True, "sym": sym, "bars": len(ohlcv)}


def bootstrap(max_symbols: int | None = None) -> dict:
    """云端冷启动：建 cache_drift → 建 dataset。返回统计。"""
    sys.path.insert(0, TRAIN_DIR)
    syms = pick_symbols()
    if max_symbols:
        syms = syms[:max_symbols]
    print(f"[bootstrap] 目标 {len(syms)} 个币种，每币 {BARS} 根 1h", flush=True)
    ok, fail = 0, []
    for i, s in enumerate(syms, 1):
        try:
            r = build_one(s)
            ok += 1 if r.get("ok") else 0
            if not r.get("ok"):
                fail.append(r)
        except Exception as e:
            fail.append({"sym": s, "reason": f"{type(e).__name__}: {e}"})
        if i % 10 == 0:
            print(f"[bootstrap] {i}/{len(syms)} ok={ok} fail={len(fail)}", flush=True)
        time.sleep(0.25)   # 主动降速：60 币 × 5 个端点，突发请求容易撞限频

    from . import data as D  # noqa: PLC0415
    meta = D.build_dataset(verbose=True)
    return {"ok": ok > 0, "nOk": ok, "nFail": len(fail), "failSample": fail[:5],
            "dataset": {k: meta[k] for k in ("nRows", "nSymbols", "nFeatures", "tsMax")}}


if __name__ == "__main__":
    print(json.dumps(bootstrap(), ensure_ascii=False, indent=1))
