#!/usr/bin/env python3
"""币安公开微观结构采集器：只读 REST，不加载密钥，不具备下单能力。

示例：
  python train/microstructure_collector.py --symbols BTCUSDT,ETHUSDT --once
  python train/microstructure_collector.py --symbols BTCUSDT --interval 5

原始 depth20 与 aggTrades 以 JSONL 按币按日落盘。只有积累足够长时间并完成
时间对齐、样本外检验后，才允许把衍生特征加入训练；本脚本本身不修改模型。
"""
import argparse
import json
import os
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

REST = "https://fapi.binance.com/fapi/v1"


def get_json(path, params, timeout=12):
    url = REST + path + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "binance-quant-research/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def capture(symbol):
    depth = get_json("/depth", {"symbol": symbol, "limit": 20})
    trades = get_json("/aggTrades", {"symbol": symbol, "limit": 1000})
    return {
        "receivedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        "symbol": symbol,
        "depth": depth,
        "aggTrades": trades,
    }


def append_record(root, record):
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    directory = os.path.join(root, record["symbol"])
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, day + ".jsonl")
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    return path


def main():
    parser = argparse.ArgumentParser(description="只读采集币安 depth20 / aggTrades 历史")
    parser.add_argument("--symbols", default="BTCUSDT,ETHUSDT,SOLUSDT")
    parser.add_argument("--output", default=os.path.join("data_cache", "microstructure"))
    parser.add_argument("--once", action="store_true", help="每个币采集一次后退出")
    parser.add_argument("--interval", type=float, default=5.0, help="连续采集间隔秒数，最低 2 秒")
    args = parser.parse_args()
    symbols = [s.strip().upper() for s in args.symbols.split(",") if s.strip()]
    if not symbols:
        parser.error("至少需要一个币种")
    interval = max(2.0, args.interval)
    while True:
        started = time.monotonic()
        for symbol in symbols:
            try:
                record = capture(symbol)
                path = append_record(args.output, record)
                print(f"[micro] {symbol} depth20 + {len(record['aggTrades'])} trades -> {path}", flush=True)
            except Exception as exc:
                print(f"[micro] {symbol} 采集失败: {exc}", flush=True)
        if args.once:
            break
        time.sleep(max(0.0, interval - (time.monotonic() - started)))


if __name__ == "__main__":
    main()
