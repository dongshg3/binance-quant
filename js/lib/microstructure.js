// 订单簿与成交流纯函数。这里不预测方向，只产生可核验的实时诊断。
const finite = x => Number.isFinite(Number(x));

function levels(rows, limit) {
  return (Array.isArray(rows) ? rows : []).slice(0, limit)
    .map(x => ({ price: Number(x[0]), qty: Number(x[1]) }))
    .filter(x => x.price > 0 && x.qty >= 0);
}

export function bookMetrics(book, depth = 20) {
  const bids = levels(book?.bids, depth), asks = levels(book?.asks, depth);
  if (!bids.length || !asks.length) return null;
  const bid = bids[0], ask = asks[0];
  if (!(bid.price > 0 && ask.price > bid.price)) return null;
  const mid = (bid.price + ask.price) / 2;
  const denom = bid.qty + ask.qty;
  const microprice = denom > 0 ? (ask.price * bid.qty + bid.price * ask.qty) / denom : mid;
  const imbalanceAt = n => {
    const b = bids.slice(0, n).reduce((s, x) => s + x.qty, 0);
    const a = asks.slice(0, n).reduce((s, x) => s + x.qty, 0);
    return b + a > 0 ? (b - a) / (b + a) : null;
  };
  return {
    bestBid: bid.price, bestAsk: ask.price, bidQty: bid.qty, askQty: ask.qty,
    mid, microprice,
    spreadBps: (ask.price - bid.price) / mid * 10000,
    micropriceDeviationBps: (microprice - mid) / mid * 10000,
    imbalance1: imbalanceAt(1), imbalance5: imbalanceAt(5), imbalance20: imbalanceAt(depth),
    levels: Math.min(depth, Math.max(bids.length, asks.length)),
  };
}

// Cont 等的最优买卖价 OFI 离散更新。单个快照没有前序状态，不能计算 OFI。
export function orderFlowImbalance(previous, current) {
  const a = bookMetrics(previous, 1), b = bookMetrics(current, 1);
  if (!a || !b) return null;
  let bidFlow;
  if (b.bestBid > a.bestBid) bidFlow = b.bidQty;
  else if (b.bestBid < a.bestBid) bidFlow = -a.bidQty;
  else bidFlow = b.bidQty - a.bidQty;
  let askFlow;
  if (b.bestAsk < a.bestAsk) askFlow = -b.askQty;
  else if (b.bestAsk > a.bestAsk) askFlow = a.askQty;
  else askFlow = a.askQty - b.askQty;
  const ofi = bidFlow + askFlow;
  const scale = (a.bidQty + a.askQty + b.bidQty + b.askQty) / 4;
  return { ofi, bidFlow, askFlow, normalized: scale > 0 ? ofi / scale : 0 };
}

// Binance aggTrade.m=true 表示买方是 maker，因此是主动卖出，记为负 CVD。
export function signedTradeVolume(trade) {
  if (!trade || !finite(trade.q) || Number(trade.q) < 0) return 0;
  return Number(trade.q) * (trade.m ? -1 : 1);
}

export function aggregateTrades(trades, seenIds = null) {
  const out = { cvd: 0, buyVolume: 0, sellVolume: 0, count: 0, firstTime: null, lastTime: null, ids: [] };
  for (const t of Array.isArray(trades) ? trades : []) {
    const id = t.a ?? t.aggTradeId ?? `${t.T}:${t.p}:${t.q}:${t.m}`;
    if (seenIds?.has(id)) continue;
    const signed = signedTradeVolume(t), qty = Math.abs(signed);
    if (!(qty > 0)) continue;
    out.ids.push(id);
    out.cvd += signed;
    if (signed > 0) out.buyVolume += qty; else out.sellVolume += qty;
    out.count++;
    const time = Number(t.T ?? t.time);
    if (Number.isFinite(time)) {
      out.firstTime = out.firstTime == null ? time : Math.min(out.firstTime, time);
      out.lastTime = out.lastTime == null ? time : Math.max(out.lastTime, time);
    }
  }
  return out;
}
