#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# news_fetch.py · 消息面因子数据管线（GitHub Actions 每小时运行，全程免费零 key）
#
# 数据源：
#   · alternative.me Fear & Greed Index（最新 + 30 天历史 → z-score）
#   · RSS：CoinDesk / Cointelegraph / Decrypt / Bitcoin Magazine / The Block
#   · Reddit：r/CryptoCurrency + r/CryptoMarkets hot 100
# 情绪打分：VADER（开源英文情绪词典，Hutto & Gilbert 2014，MIT）
# 币种匹配：币安合约 Top150（按成交额）币名/符号词典，常见英文单词符号进黑名单防误配
#
# 产出：
#   data/news.json          最新快照（前端「消息面」因子直接消费）
#   data/news_history.json  30 天滚动历史（供未来把消息面纳入云端训练，只存聚合值，不存标题）
import json
import re
import time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path

try:
    from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
except ImportError:
    raise SystemExit("请先 pip install vaderSentiment")

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "news.json"
HIST = ROOT / "data" / "news_history.json"
UA = {"User-Agent": "Mozilla/5.0 (quant-research; +https://github.com/dongshg3/binance-quant)"}

RSS_FEEDS = [
    ("CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/"),
    ("Cointelegraph", "https://cointelegraph.com/rss"),
    ("Decrypt", "https://decrypt.co/feed"),
    ("BitcoinMagazine", "https://bitcoinmagazine.com/feed"),
    ("TheBlock", "https://www.theblock.co/rss.xml"),
]
REDDIT = [
    ("r/CryptoCurrency", "https://www.reddit.com/r/CryptoCurrency/.rss"),
    ("r/CryptoMarkets", "https://www.reddit.com/r/CryptoMarkets/.rss"),
]

# 币名 → 币安合约基础币（词表外的币只用符号匹配）
ALIASES = {
    "bitcoin": "BTC", "ethereum": "ETH", "ripple": "XRP", "xrp": "XRP", "solana": "SOL",
    "dogecoin": "DOGE", "doge": "DOGE", "cardano": "ADA", "tron": "TRX", "avalanche": "AVAX",
    "chainlink": "LINK", "polkadot": "DOT", "polygon": "POL", "matic": "POL", "litecoin": "LTC",
    "shiba inu": "SHIB", "shib": "SHIB", "uniswap": "UNI", "cosmos": "ATOM", "stellar": "XLM",
    "near protocol": "NEAR", "aptos": "APT", "arbitrum": "ARB", "optimism": "OP",
    "injective": "INJ", "sui": "SUI", "sei": "SEI", "pepe": "PEPE", "bonk": "BONK",
    "dogwifhat": "WIF", "wif": "WIF", "floki": "FLOKI", "filecoin": "FIL", "aave": "AAVE",
    "maker": "MKR", "lido": "LDO", "render": "RENDER", "fet": "FET", "fetch.ai": "FET",
    "ethereum classic": "ETC", "bitcoin cash": "BCH", "bnb": "BNB", "binance": "BNB",
    "the sandbox": "SAND", "decentraland": "MANA", "axie": "AXS", "gala": "GALA",
    "immutable": "IMX", "stacks": "STX", "toncoin": "TON", "hedera": "HBAR", "vechain": "VET",
    "algorand": "ALGO", "fantom": "FTM", "sonic": "S", "theta": "THETA", "eos": "EOS",
    "monero": "XMR", "zcash": "ZEC", "dash": "DASH", "kusama": "KSM", "celestia": "TIA",
    "wormhole": "W", "jupiter": "JUP", "pendle": "PENDLE", "ondo": "ONDO", "ethena": "ENA",
    "hyperliquid": "HYPE", "pudgy": "PENGU", "trump": "TRUMP", "worldcoin": "WLD",
    "bittensor": "TAO", "kaspa": "KAS", "internet computer": "ICP", "arweave": "AR",
    "solana etf": "SOL", "bitcoin etf": "BTC", "ethereum etf": "ETH", "spot etf": "BTC",
}
# 符号本身是常见英文单词 → 禁用纯符号匹配，只认币名（防误配）
SYMBOL_BLOCKLIST = {
    "ONE", "LINK", "APE", "SAND", "SUN", "NEAR", "ATOM", "ROSE", "GAS", "DATA", "FUN",
    "KEY", "HOT", "CITY", "OG", "BOND", "CAKE", "DODO", "MASK", "RARE", "RAY", "LIT",
    "BEL", "HARD", "FARM", "KEEP", "W", "S", "VANA", "MOVE", "ME", "THE", "AXL", "ENJ",
    "BAT", "COMP", "ANKR", "AUDIO", "ICX", "IOST", "STMX", "TWT", "WIN", "ACH", "EDU",
    "ID", "HOOK", "MAGIC", "HIGH", "PIXEL", "PORTAL", "AI", "AUCTION", "BOME", "MEME",
    "PEOPLE", "PUNDIX", "SPELL", "SUPER", "TON", "TRB", "USTC", "1000SATS", "ORDI",
}


def http_json(url, timeout=15):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def http_text(url, timeout=15):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def fetch_fgi():
    """Fear & Greed Index：最新值 + 30 天均值/标准差/24h 变化/z-score"""
    try:
        d = http_json("https://api.alternative.me/fng/?limit=30&format=json")
        rows = [{"v": int(x["value"]), "t": int(x["timestamp"]),
                 "label": x.get("value_classification", "")} for x in d.get("data", [])]
        if not rows:
            return None
        rows.sort(key=lambda x: x["t"])
        vals = [r["v"] for r in rows]
        cur = vals[-1]
        mean = sum(vals) / len(vals)
        sd = (sum((x - mean) ** 2 for x in vals) / len(vals)) ** 0.5
        return {
            "value": cur, "label": rows[-1]["label"],
            "delta24h": cur - vals[-2] if len(vals) > 1 else 0,
            "mean30": round(mean, 1), "std30": round(sd, 1),
            "z": round((cur - mean) / sd, 2) if sd > 0 else 0.0,
        }
    except Exception as e:
        print("FGI 拉取失败：", e)
        return None


def fetch_top_symbols():
    """币安合约 Top150（按 24h 成交额）→ ['BTC', 'ETH', ...]"""
    try:
        tk = http_json("https://fapi.binance.com/fapi/v1/ticker/24hr")
        rows = [x for x in tk if x.get("symbol", "").endswith("USDT")]
        rows.sort(key=lambda x: float(x.get("quoteVolume", 0)), reverse=True)
        return [x["symbol"][:-4] for x in rows[:150]]
    except Exception as e:
        print("合约列表拉取失败，退回内置名单：", e)
        return sorted(set(ALIASES.values()))


def parse_feed_items(name, url, cutoff):
    """解析 RSS 2.0 / Atom，返回 [(title, ts)]，仅保留 cutoff 之后的条目"""
    items = []
    try:
        root = ET.fromstring(http_text(url))
    except Exception as e:
        print(f"RSS {name} 失败：", e)
        return items
    # RSS 2.0
    for it in root.iter("item"):
        t = it.findtext("title") or ""
        pub = it.findtext("pubDate") or ""
        try:
            ts = parsedate_to_datetime(pub).timestamp() if pub else time.time()
        except Exception:
            ts = time.time()
        if ts >= cutoff and t.strip():
            items.append((t.strip(), ts, name))
    # Atom
    ns = {"a": "http://www.w3.org/2005/Atom"}
    for it in root.findall("a:entry", ns):
        t = (it.findtext("a:title", default="", namespaces=ns) or "").strip()
        pub = it.findtext("a:published", namespaces=ns) or it.findtext("a:updated", namespaces=ns) or ""
        try:
            ts = datetime.fromisoformat(pub.replace("Z", "+00:00")).timestamp() if pub else time.time()
        except Exception:
            ts = time.time()
        if ts >= cutoff and t:
            items.append((t, ts, name))
    return items


def build_matchers(top_bases):
    """(正则, 基础币) 列表：先币名（含别名），后符号（黑名单外）"""
    pairs = []
    for name, base in ALIASES.items():
        if base in top_bases:
            pairs.append((re.compile(r"\b" + re.escape(name) + r"\b", re.I), base))
    for base in top_bases:
        if base in SYMBOL_BLOCKLIST or len(base) < 4 or base.startswith("1000"):
            continue
        pairs.append((re.compile(r"\b" + re.escape(base) + r"\b"), base))  # 符号区分大小写
        pairs.append((re.compile(r"\$" + re.escape(base) + r"\b", re.I), base))  # $BTC 式标签
    return pairs


def main():
    now = datetime.now(timezone.utc)
    cutoff = (now - timedelta(hours=48)).timestamp()
    print(f"开始抓取消息面数据 @ {now.isoformat()}")

    fgi = fetch_fgi()
    top_bases = fetch_top_symbols()
    matchers = build_matchers(top_bases)

    items = []
    for name, url in RSS_FEEDS:
        got = parse_feed_items(name, url, cutoff)
        print(f"  RSS {name}: {len(got)} 条")
        items.extend(got)
    rd = []
    for name, url in REDDIT:
        got = parse_feed_items(name, url, cutoff)  # .rss 端点即 Atom，复用同一解析器
        print(f"  Reddit {name}: {len(got)} 条")
        rd.extend(got)
        time.sleep(4)  # Reddit 限流敏感，串行间隔请求
    items.extend(rd)

    analyzer = SentimentIntensityAnalyzer()
    coins = {}
    all_scores = []
    for title, ts, src in items:
        compound = analyzer.polarity_scores(title)["compound"]
        all_scores.append(compound)
        hit = set()
        for rx, base in matchers:
            if base not in hit and rx.search(title):
                hit.add(base)
        for base in hit:
            c = coins.setdefault(base, {"buzz": 0, "sentSum": 0.0, "top": []})
            c["buzz"] += 1
            c["sentSum"] += compound
            if abs(compound) >= 0.3 and len(c["top"]) < 3:
                c["top"].append({"t": title[:110], "src": src, "s": round(compound, 2)})

    buzz_all = sorted(c["buzz"] for c in coins.values())
    med_buzz = buzz_all[len(buzz_all) // 2] if buzz_all else 1
    out_coins = {}
    for base, c in coins.items():
        out_coins[base] = {
            "sent": round(c["sentSum"] / c["buzz"], 3),
            "buzz": c["buzz"],
            "buzzRel": round(c["buzz"] / max(med_buzz, 1), 2),
            "top": c["top"],
        }

    snap = {
        "updatedAt": now.isoformat(),
        "fgi": fgi,
        "globalSent": round(sum(all_scores) / len(all_scores), 3) if all_scores else None,
        "totalItems": len(items),
        "medianBuzz": med_buzz,
        "coins": out_coins,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(snap, ensure_ascii=False, separators=(",", ":")), "utf-8")
    print(f"写入 {OUT} · 条目 {len(items)} · 命中币种 {len(out_coins)}")

    # 30 天滚动历史（聚合值，供未来训练；不存标题，控制体积）
    hist = []
    if HIST.exists():
        try:
            hist = json.loads(HIST.read_text("utf-8"))
        except Exception:
            hist = []
    hist.append({
        "t": now.isoformat(),
        "fgi": fgi["value"] if fgi else None,
        "fgiZ": fgi["z"] if fgi else None,
        "gSent": snap["globalSent"],
        "coins": {b: {"sent": c["sent"], "buzz": c["buzz"]} for b, c in out_coins.items()},
    })
    cutoff_hist = (now - timedelta(days=30)).isoformat()
    hist = [h for h in hist if h.get("t", "") >= cutoff_hist]
    HIST.write_text(json.dumps(hist, ensure_ascii=False, separators=(",", ":")), "utf-8")
    print(f"历史累计 {len(hist)} 条（30 天滚动窗口）")


if __name__ == "__main__":
    main()
