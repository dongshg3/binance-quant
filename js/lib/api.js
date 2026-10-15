// ============================================================
// api.js · 币安公开数据接口封装（REST + WebSocket，无需密钥）
// 网络自适应：
//   · 合约直连 fapi.binance.com 被屏蔽时，K线/ticker/币种列表
//     自动降级到官方现货镜像 data-api.binance.vision（价格几乎一致）
//   · 现货 api.binance.com 不通时同样自动降级
//   · WebSocket 多次失败后报告 'failed'，由页面切换 REST 轮询
// ============================================================

export const API = {
  futuresRest: 'https://fapi.binance.com/fapi/v1',
  spotHosts: ['https://api.binance.com/api/v3', 'https://data-api.binance.vision/api/v3'],
  futuresDataRest: 'https://fapi.binance.com/futures/data',
  futuresWs: 'wss://fstream.binance.com/market/ws',
  spotWs: 'wss://stream.binance.com:9443/ws',
};

// 'direct' = 合约直连可用；'mirror' = 已降级到现货镜像；null = 尚未探测
let futuresBlocked = null;
export function getDataMode() {
  if (futuresBlocked === null) return 'unknown';
  return futuresBlocked ? 'mirror' : 'direct';
}

export async function fetchJSON(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}

async function fetchWithHosts(hosts, path, timeoutMs) {
  let lastErr = null;
  for (const h of hosts) {
    try { return await fetchJSON(h + path, timeoutMs); }
    catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('所有数据源均不可达');
}

export function restBase(market) {
  if (market === 'futures' && !futuresBlocked) return API.futuresRest;
  return API.spotHosts[API.spotHosts.length - 1]; // 镜像兜底
}

// 市场数据 GET：合约优先直连，失败后永久（本次会话）降级到现货镜像
async function marketGet(market, path, timeoutMs) {
  if (market === 'spot') return fetchWithHosts(API.spotHosts, path, timeoutMs);
  // futures
  if (futuresBlocked !== true) {
    try {
      const data = await fetchJSON(API.futuresRest + path, futuresBlocked === null ? 5000 : timeoutMs);
      futuresBlocked = false;
      return data;
    } catch (e) {
      futuresBlocked = true;
      console.warn('[API] 合约直连不可用，降级到现货镜像 data-api.binance.vision');
    }
  }
  // 镜像模式：用现货数据代替（价格走势一致，资金费率等合约专属数据除外）
  return fetchWithHosts(API.spotHosts, path, timeoutMs);
}

// 全部可交易币种（合约 = 全部 USDT 永续；镜像降级时 = 全部 USDT 现货）
// 稳定币/指数合约：价格动态是脱锚噪音或合成指数，因子信号无意义，全站排除
// 含新一代法币稳定币（RLUSD/BFUSD/XUSD/U 等，与 train.py EXCLUDE_BASE 保持一致）
export const EXCLUDED_BASES = new Set(['USDC', 'FDUSD', 'TUSD', 'USDP', 'DAI', 'BUSD', 'USD1', 'USDD', 'USDE', 'USDS', 'BTCDOM',
  'RLUSD', 'BFUSD', 'XUSD', 'U', 'PYUSD', 'USDG', 'AUSD', 'GUSD', 'EURC', 'AEUR', 'EURI', 'LUSD']);

export async function loadAllSymbols(market = 'futures') {
  const data = await marketGet(market, '/exchangeInfo', 10000);
  const mirror = market === 'futures' && futuresBlocked === true;
  const symbols = (data.symbols || []).filter(s => {
    if (EXCLUDED_BASES.has(s.baseAsset)) return false;
    if (market === 'futures' && !mirror) return s.quoteAsset === 'USDT' && s.contractType === 'PERPETUAL' && s.status === 'TRADING';
    return s.quoteAsset === 'USDT' && s.status === 'TRADING' && !s.symbol.includes('UP') && !s.symbol.includes('DOWN') && !s.symbol.includes('BULL') && !s.symbol.includes('BEAR');
  }).map(s => s.symbol);
  return symbols.sort();
}

// 24h ticker 全量（价格、涨跌幅、成交额）
export async function loadTickers(market = 'futures') {
  const tickers = await marketGet(market, '/ticker/24hr', 25000);
  const map = {};
  if (Array.isArray(tickers)) {
    for (const t of tickers) {
      map[t.symbol] = {
        price: parseFloat(t.lastPrice),
        change24h: parseFloat(t.priceChangePercent),
        quoteVolume: parseFloat(t.quoteVolume),
        high24h: parseFloat(t.highPrice),
        low24h: parseFloat(t.lowPrice),
        trades: parseInt(t.count) || 0,
      };
    }
  }
  return map;
}

export async function fetchKlines(symbol, interval, limit, market = 'futures') {
  const data = await marketGet(market, `/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, 15000);
  if (!Array.isArray(data)) throw new Error('K线数据异常');
  return data.map(k => ({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
}

// ---------------- 合约专属数据（镜像模式下不可用，调用方需容错） ----------------
export async function fetchFundingRate(symbol) {
  const d = await fetchJSON(`${API.futuresRest}/premiumIndex?symbol=${symbol}`, 8000);
  return parseFloat(d.lastFundingRate);
}
export async function fetchLongShortRatio(symbol, period = '1h') {
  const d = await fetchJSON(`${API.futuresDataRest}/globalLongShortAccountRatio?symbol=${symbol}&period=${period}&limit=1`, 8000);
  if (Array.isArray(d) && d.length) return parseFloat(d[d.length - 1].longShortRatio);
  return null;
}
// 资金费率历史（约 limit/3 天）：拥挤度必须与自身近期分布比较，而非绝对阈值
export async function fetchFundingHistory(symbol, limit = 90) {
  const d = await fetchJSON(`${API.futuresRest}/fundingRate?symbol=${symbol}&limit=${limit}`, 8000);
  if (Array.isArray(d) && d.length >= 10) return d.map(x => parseFloat(x.fundingRate));
  return null;
}
export async function fetchOpenInterestChange(symbol, period = '1h') {
  const d = await fetchJSON(`${API.futuresDataRest}/openInterestHist?symbol=${symbol}&period=${period}&limit=30`, 8000);
  if (Array.isArray(d) && d.length >= 2) {
    const first = parseFloat(d[0].sumOpenInterest), last = parseFloat(d[d.length - 1].sumOpenInterest);
    if (first > 0) return last / first - 1;
  }
  return null;
}
export async function fetchTakerRatio(symbol, period = '1h') {
  const d = await fetchJSON(`${API.futuresDataRest}/takerlongshortRatio?symbol=${symbol}&period=${period}&limit=1`, 8000);
  if (Array.isArray(d) && d.length) return parseFloat(d[d.length - 1].buySellRatio);
  return null;
}

// 全市场资金费率（一次请求返回全部合约，用于热力图）
export async function fetchAllPremiumIndex() {
  const data = await fetchJSON(`${API.futuresRest}/premiumIndex`, 20000);
  const map = {};
  if (Array.isArray(data)) {
    for (const d of data) {
      map[d.symbol] = {
        fundingRate: parseFloat(d.lastFundingRate),
        markPrice: parseFloat(d.markPrice),
        nextFundingTime: d.nextFundingTime,
      };
    }
  }
  return map;
}

// ---------------- WebSocket 实时 K 线 ----------------
// 重连 maxAttempts 次后放弃并回调 onState('failed')，页面应切换 REST 轮询
export function connectKlineWS(symbol, interval, market, onMessage, onState, maxAttempts = 4) {
  const wsBase = market === 'futures' ? API.futuresWs : API.spotWs;
  const url = `${wsBase}/${symbol.toLowerCase()}@kline_${interval}`;
  let ws = null, reconnectTimer = null, closed = false, attempts = 0, everConnected = false;

  const connect = () => {
    if (closed) return;
    onState && onState('connecting');
    try { ws = new WebSocket(url); } catch (e) { schedule(); return; }
    const timeout = setTimeout(() => { if (ws && ws.readyState === WebSocket.CONNECTING) ws.close(); }, 8000);
    ws.onopen = () => { clearTimeout(timeout); attempts = 0; everConnected = true; onState && onState('connected'); };
    ws.onmessage = ev => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.data && msg.data.k) {
          const k = msg.data.k;
          onMessage({ time: k.t, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v, closed: k.x });
        }
      } catch (e) { /* ignore */ }
    };
    ws.onclose = () => { clearTimeout(timeout); onState && onState('disconnected'); schedule(); };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
  };
  const schedule = () => {
    if (closed) return;
    attempts++;
    if (attempts > maxAttempts && !everConnected) {
      onState && onState('failed');
      return; // 放弃重连，交给轮询
    }
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, Math.min(20000, 2500 * attempts));
  };
  connect();
  return { close() { closed = true; clearTimeout(reconnectTimer); try { ws && ws.close(); } catch (e) {} } };
}

// REST 轮询兜底：每 intervalMs 拉最近 2 根 K 线，模拟实时推送
export function pollKlines(symbol, interval, market, onCandle, intervalMs = 5000) {
  let stopped = false;
  const timer = setInterval(async () => {
    if (stopped) return;
    try {
      const ks = await fetchKlines(symbol, interval, 2, market);
      if (ks.length) onCandle(ks[ks.length - 1]);
    } catch (e) { /* 静默，下轮再试 */ }
  }, intervalMs);
  return { stop() { stopped = true; clearInterval(timer); } };
}
