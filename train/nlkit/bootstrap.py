#!/usr/bin/env python3
# ============================================================
# nlkit/bootstrap.py · 云端冷启动（GitHub Actions 上从零建库）
# ------------------------------------------------------------
# 云端铁律（2026-10-17 实测得出，非常关键）：
#   GitHub Actions runner 访问 **fapi.binance.com 返回 HTTP 451**
#   （Unavailable For Legal Reasons：币安按来源地区封禁 Azure/云机房出口）。
#   所以云端绝不能依赖期货端点。可用的是官方公共现货镜像
#   `data-api.binance.vision`（本仓库 train.py 的 HOSTS 首选就是它，25 次运行成功）。
#
# 因此云端策略：
#   · K 线 / 币种列表 → 一律走 data-api.binance.vision 现货镜像
#   · 资金费率 / 多空比 / 持仓量 → 期货才有的数据，451 时留 NaN（不阻断）
#     代价：37 维特征里 fr_*/ls_*/doi_z 与 futures 组得分退化为缺失值，
#     训练仍可进行（HistGBM 与中位数补齐都能处理）。
#   · 本地管线仍用完整期货数据 —— 这正是双管线存在的意义之一。
# ============================================================
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
TRAIN_DIR = os.path.dirname(HERE)
CACHE = os.path.join(TRAIN_DIR, "cache_drift")

SPOT = "https://data-api.binance.vision"
FAPI = "https://fapi.binance.com"
BARS = int(os.environ.get("NL_BOOT_BARS", "4000"))
TOP_N = int(os.environ.get("NL_TOP_N", "60"))
UA = {"User-Agent": "nlkit-bootstrap/1.0"}
FORBIDDEN = (451, 403)


def _get(base: str, path: str, params: dict | None = None, timeout: float = 20.0):
    url = base + path
    if params:
        url += "?" + "&".join(f"{k}={v}" for k, v in params.items())
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in FORBIDDEN:
                raise PermissionError(f"{e.code} {base}{path}")
            if e.code in (429, 418):
                wait = float(e.headers.get("Retry-After") or 5)
                print(f"[bootstrap] 限频 {e.code}，等待 {wait:.0f}s", flush=True)
                time.sleep(min(wait, 60))
                continue
            if attempt == 3:
                raise
            time.sleep(1.0 + attempt)
        except Exception:
            if attempt == 3:
                raise
            time.sleep(1.0 + attempt)


def _get_first(cands, params=None, timeout=20.0):
    """按顺序试 (base, path) 候选；451/403 直接跳到下一个候选。"""
    last = None
    for base, path in cands:
        try:
            return _get(base, path, params, timeout)
        except PermissionError as e:
            last = e
            continue
        except Exception as e:
            last = e
            continue
    raise RuntimeError(f"全部候选不可用: {last}")


def pick_symbols() -> list[str]:
    """按 24h 成交额取前 N 个 USDT 币种（现货镜像；排除稳定币/锚定/代币化股票）。"""
    sys.path.insert(0, TRAIN_DIR)
    import train as T  # noqa: PLC0415

    tickers = _get_first([(SPOT, "/api/v3/ticker/24hr"),
                          (FAPI, "/fapi/v1/ticker/24hr")], timeout=30)
    rows = [(t["symbol"], float(t.get("quoteVolume", 0) or 0)) for t in tickers
            if t["symbol"].endswith("USDT")]
    rows.sort(key=lambda x: -x[1])

    pegged = {"PAXG", "XAUT", "EUR", "RLUSD", "BFUSD", "XUSD", "USDC", "FDUSD", "DAI", "USDP"}
    out = []
    for sym, _vol in rows:
        base = sym[:-4]
        if base in T.EXCLUDE_BASE or base in pegged:
            continue
        if len(base) >= 4 and base.endswith("B"):   # 代币化股票/指数
            continue
        out.append(sym)
        if len(out) >= TOP_N:
            break
    return out


def fetch_klines(sym: str, bars: int = BARS) -> np.ndarray:
    """往回分页拉 1h K 线（现货优先，451 时退回期货）。返回升序 (n,6)。"""
    got: list[list[float]] = []
    end = None
    while len(got) < bars:
        params = {"symbol": sym, "interval": "1h", "limit": 1000}
        if end:
            params["endTime"] = end
        chunk = _get_first([(SPOT, "/api/v3/klines"), (FAPI, "/fapi/v1/klines")], params)
        if not chunk:
            break
        rows = [[float(k[0]), float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[5])]
                for k in chunk]
        got = rows + got
        end = int(rows[0][0]) - 1
        if len(chunk) < 1000:
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


def _try_futures(bar: np.ndarray, sym: str) -> tuple:
    """期货专属字段。云端 451 → 返回全 NaN（不阻断训练）。"""
    fr = np.full(len(bar), np.nan)
    ls = np.full(len(bar), np.nan)
    oi = np.full(len(bar), np.nan)
    try:
        f = _get(FAPI, "/fapi/v1/fundingRate", {"symbol": sym, "limit": 1000})
        if f:
            ms = np.array([float(x["fundingTime"]) for x in f])
            vv = np.array([float(x["fundingRate"]) for x in f])
            fr = _ffill(bar, ms, vv)
    except Exception:
        pass
    for path, key in (("/futures/data/globalLongShortAccountRatio", "longShortRatio"),
                      ("/futures/data/openInterestHist", "sumOpenInterest")):
        try:
            a = _get(FAPI, path, {"symbol": sym, "period": "1h", "limit": 500})
            if a:
                ms = np.array([float(x["timestamp"]) for x in a])
                vv = np.array([float(x[key]) for x in a])
                filled = _ffill(bar, ms, vv)
                if key == "longShortRatio":
                    ls = filled
                else:
                    oi = filled
        except Exception:
            pass
    return fr, ls, oi


def build_one(sym: str) -> dict:
    import train as T  # noqa: PLC0415
    ohlcv = fetch_klines(sym)
    if len(ohlcv) < 800:
        return {"ok": False, "sym": sym, "reason": f"bar 太少 {len(ohlcv)}"}
    bar = ohlcv[:, 0]
    fr, ls, oi = _try_futures(bar, sym)

    os.makedirs(CACHE, exist_ok=True)
    np.savez_compressed(os.path.join(CACHE, f"{sym}_raw.npz"),
                        ohlcv=ohlcv, fr=fr, ls=ls, oi=oi)
    gs, aux = T.group_scores(ohlcv, (list(fr), list(ls), list(oi)))
    X = np.column_stack([gs[g] for g in T.GROUPS])
    np.savez_compressed(os.path.join(CACHE, f"{sym}_feat.npz"),
                        X=X, sig=aux["sig"], adx=aux["adx"], c=ohlcv[:, 4],
                        t0=ohlcv[:, 0], fr=fr)
    fut_cov = float(np.isfinite(fr).mean())
    return {"ok": True, "sym": sym, "bars": len(ohlcv), "futCoverage": round(fut_cov, 3)}


def bootstrap(max_symbols: int | None = None) -> dict:
    sys.path.insert(0, TRAIN_DIR)
    syms = pick_symbols()
    if max_symbols:
        syms = syms[:max_symbols]
    print(f"[bootstrap] 目标 {len(syms)} 个币种，每币最多 {BARS} 根 1h（现货镜像优先）", flush=True)
    ok, fail, n_fut = 0, [], 0
    for i, s in enumerate(syms, 1):
        try:
            r = build_one(s)
            if r.get("ok"):
                ok += 1
                if r.get("futCoverage", 0) > 0.5:
                    n_fut += 1
            else:
                fail.append(r)
        except Exception as e:
            fail.append({"sym": s, "reason": f"{type(e).__name__}: {e}"})
        if i % 10 == 0:
            print(f"[bootstrap] {i}/{len(syms)} ok={ok} fail={len(fail)}", flush=True)
        time.sleep(0.2)

    from . import data as D  # noqa: PLC0415
    meta = D.build_dataset(verbose=True)
    return {"ok": ok > 0, "nOk": ok, "nFail": len(fail), "failSample": fail[:5],
            "nWithFutures": n_fut,
            "dataset": {k: meta[k] for k in ("nRows", "nSymbols", "nFeatures", "tsMax")}}


if __name__ == "__main__":
    print(json.dumps(bootstrap(), ensure_ascii=False, indent=1))
