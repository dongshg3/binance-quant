import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const UPDATE = process.argv.includes('--update');
const FIXED_NOW = Date.UTC(2026, 0, 2, 12, 0, 0);
const BASELINE_DIR = resolve('tests/visual-baseline');
const OUTPUT_DIR = resolve('.tmp/visual-regression');
const ALLOWED_DIFF_RATIO = 0.005;
const PIXEL_THRESHOLD = 0.15;
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const executablePath = process.env.CHROME_PATH || (existsSync(chrome) ? chrome : edge);

mkdirSync(BASELINE_DIR, { recursive: true });
mkdirSync(OUTPUT_DIR, { recursive: true });

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'UNIUSDT', 'AAVEUSDT'];
const model = {
  version: 42,
  trainedAt: '2026-01-02T10:00:00+00:00',
  weights: { trend: 0.22, momentum: 0.18, meanRev: 0.13, volume: 0.13, volatility: 0.09, position: 0.05, htf: 0.10, futures: 0.10, news: 0.05 },
  scoreScale: 0.12,
  oos: { ic: 0.027, icXS: 0.031 },
  segments: {},
  symbolMeta: {},
  coinModels: {
    BTCUSDT: {
      status: 'active', modelType: 'hgb-ridge-ensemble', weights: { trend: 0.28, momentum: 0.17, meanRev: 0.08, volume: 0.12, volatility: 0.08, position: 0.05, htf: 0.12, futures: 0.10 },
      scoreScale: 0.12, ic: 0.036, t: 2.74, deltaIC: 0.006, n: 1840, hgbBlend: 0, shrinkage: 0.68,
      foldICs: [0.041, 0.029, 0.035], reason: '固定视觉夹具：逐币模型已通过三折外推并接管评分。',
    },
    ETHUSDT: { status: 'shadow', weights: { trend: 1 }, ic: 0.024, t: 1.82, foldICs: [0.02, -0.01, 0.03] },
  },
};
const news = {
  updatedAt: '2026-01-02T11:30:00+00:00',
  fgi: { value: 54, label: 'Neutral', delta24h: 3, mean30: 60, std30: 8, z: -0.75 },
  globalSent: 0.08, totalItems: 36, medianBuzz: 2,
  coins: {
    BTC: { sent: 0.21, buzz: 6, buzzRel: 2.4, top: [
      { t: 'Bitcoin market depth improves as volatility normalizes', src: 'Fixture', s: 0.42 },
      { t: 'ETF flows remain balanced across major venues', src: 'Fixture', s: 0.08 },
    ] },
    ETH: { sent: 0.12, buzz: 3, buzzRel: 1.5, top: [] },
  },
};

function seededRandom(seed) {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

function candlesFor(symbol, requestedLimit) {
  const count = Math.max(60, Math.min(Number(requestedLimit) || 400, 1500));
  const symbolSeed = [...symbol].reduce((s, c) => s + c.charCodeAt(0), 0);
  const intervalMs = 3600000;
  const start = FIXED_NOW - (count - 1) * intervalMs;
  let price = 80 + symbolSeed % 40;
  return Array.from({ length: count }, (_, i) => {
    const ret = 0.00045 + Math.sin((i + symbolSeed) * 0.071) * 0.006 + Math.cos(i * 0.019) * 0.003;
    const open = price;
    const close = open * Math.exp(ret);
    const high = Math.max(open, close) * (1.002 + 0.001 * Math.sin(i * 0.13) ** 2);
    const low = Math.min(open, close) * (0.998 - 0.001 * Math.cos(i * 0.11) ** 2);
    const volume = 900000 * (1 + 0.35 * Math.sin(i * 0.09) + 0.12 * Math.cos(i * 0.23));
    price = close;
    return [start + i * intervalMs, String(open), String(high), String(low), String(close), String(volume), start + i * intervalMs + intervalMs - 1];
  });
}

const tickers = SYMBOLS.map((symbol, i) => {
  const candles = candlesFor(symbol, 2);
  return {
    symbol, lastPrice: candles[1][4], priceChangePercent: String((i - 3) * 0.72),
    quoteVolume: String(8.2e8 - i * 6.1e7), highPrice: candles[1][2], lowPrice: candles[1][3], count: String(182000 - i * 7000),
  };
});
const premiums = SYMBOLS.map((symbol, i) => ({
  symbol, lastFundingRate: String((i - 3.5) * 0.00017), markPrice: tickers[i].lastPrice, nextFundingTime: Date.UTC(2026, 0, 2, 16),
}));

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
}

async function installNetworkFixtures(context, pageName) {
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (url.hostname === '127.0.0.1' && path.endsWith('/data/model.json')) return json(route, model);
    if (url.hostname === '127.0.0.1' && path.endsWith('/data/news.json')) return json(route, news);
    if (!/binance\.com$|\.binance\.com$/.test(url.hostname)) return route.continue();

    if (path.endsWith('/exchangeInfo')) {
      // Screener restores a complete fixed cache. An empty universe prevents its
      // automatic rescan from replacing that cache before the screenshot.
      const symbols = pageName === 'screener' ? [] : SYMBOLS.map(symbol => ({
        symbol, baseAsset: symbol.replace('USDT', ''), quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING',
      }));
      return json(route, { symbols });
    }
    if (path.endsWith('/ticker/24hr')) return json(route, tickers);
    if (path.endsWith('/klines')) return json(route, candlesFor(url.searchParams.get('symbol') || 'BTCUSDT', url.searchParams.get('limit')));
    if (path.endsWith('/premiumIndex')) {
      const symbol = url.searchParams.get('symbol');
      return json(route, symbol ? premiums.find(x => x.symbol === symbol) : premiums);
    }
    if (path.endsWith('/fundingRate')) {
      const symbol = url.searchParams.get('symbol') || 'BTCUSDT';
      return json(route, Array.from({ length: 30 }, (_, i) => ({ symbol, fundingRate: String(0.0001 + Math.sin(i * 0.4) * 0.00035), fundingTime: FIXED_NOW - (29 - i) * 28800000 })));
    }
    if (path.endsWith('/globalLongShortAccountRatio')) return json(route, [{ longShortRatio: '1.18', timestamp: FIXED_NOW }]);
    if (path.endsWith('/openInterestHist')) return json(route, Array.from({ length: 30 }, (_, i) => ({ sumOpenInterest: String(1000000 * (1 + i * 0.002)), timestamp: FIXED_NOW - (29 - i) * 3600000 })));
    if (path.endsWith('/takerlongshortRatio')) return json(route, [{ buySellRatio: '1.07', timestamp: FIXED_NOW }]);
    return json(route, { error: `Unmocked Binance fixture: ${url.href}` }, 500);
  });
}

function scanRows() {
  const scores = [0.48, 0.27, -0.39, 0.08, -0.19, 0.36, -0.06, 0.17];
  return SYMBOLS.map((symbol, i) => ({
    symbol, price: Number(tickers[i].lastPrice), change24h: Number(tickers[i].priceChangePercent), quoteVolume: Number(tickers[i].quoteVolume),
    score: scores[i], quality: 0.55 + Math.abs(scores[i]) * 0.5, rsi: 50 + i * 2.3, adx: 20 + i * 3.1,
    squeeze: 0.48 + i * 0.08, volRatio: 0.9 + i * 0.21, annVol: 0.42 + i * 0.035, atr: 1.2 + i * 0.1,
    position: Math.min(0.8, Math.abs(scores[i])), direction: Math.sign(scores[i]), regime: { label: i % 3 ? '趋势市' : '震荡市', cls: i % 3 ? 'trend' : 'range' },
    funding: premiums[i].lastFundingRate, edgeKind: i < 2 ? 'coin' : 'global', edgeIC: i < 2 ? 0.036 : 0.031,
    coinStatus: i === 0 ? 'active' : i === 1 ? 'shadow' : 'uncovered', coinT: i === 0 ? 2.74 : null,
    xsPct: i / (SYMBOLS.length - 1), xsZ: scores[i] * 4,
  }));
}

async function createContext(browser, baseURL, pageName, viewport) {
  const context = await browser.newContext({ baseURL, viewport, deviceScaleFactor: 1, locale: 'zh-CN', timezoneId: 'UTC', reducedMotion: 'reduce' });
  await context.addInitScript(({ fixedNow, cacheRows, funding, pageName }) => {
    const NativeDate = Date;
    class FixedDate extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [fixedNow])); }
      static now() { return fixedNow; }
    }
    Object.setPrototypeOf(FixedDate, NativeDate);
    window.Date = FixedDate;
    let seed = 0x51f15e;
    Math.random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    window.WebSocket = class {
      constructor() { this.readyState = 0; queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
      close() { this.readyState = 3; }
    };
    localStorage.clear();
    if (pageName === 'screener') {
      localStorage.setItem('bq_scan_cache_v2', JSON.stringify({
        market: 'futures', interval: '1h', minVol: 1000000, time: fixedNow - 300000, funding, results: cacheRows,
      }));
    }
  }, { fixedNow: FIXED_NOW, cacheRows: scanRows(), funding: Object.fromEntries(premiums.map(x => [x.symbol, x])), pageName });
  await installNetworkFixtures(context, pageName);
  return context;
}

async function settlePage(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(900);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function prepare(page, pageName) {
  if (pageName === 'dashboard') {
    await page.goto('/index.html?symbol=BTCUSDT&market=futures&interval=1h', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#priceNow')?.textContent !== '—', null, { timeout: 45000 });
    await page.waitForFunction(() => document.querySelectorAll('#coinModelContent .metric').length === 8, null, { timeout: 45000 });
    await page.waitForSelector('#chart canvas', { timeout: 45000 });
  } else if (pageName === 'screener') {
    await page.goto('/screener.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(expected => document.querySelectorAll('#screenerBody tr[data-sym]').length === expected, SYMBOLS.length, { timeout: 30000 });
    await page.waitForFunction(expected => document.querySelectorAll('#heatGrid .heat-cell').length === expected, SYMBOLS.length, { timeout: 30000 });
  } else {
    await page.goto('/backtest.html?symbol=BTCUSDT&market=futures&interval=1h', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#symInput', { timeout: 45000 });
    await page.locator('#limitInput').fill('900');
    await page.locator('#runBtn').click();
    await page.waitForFunction(() => {
      const status = document.querySelector('#btStatus')?.textContent || '';
      if (status.startsWith('失败')) throw new Error(status);
      return status.startsWith('完成');
    }, null, { timeout: 90000 });
    await page.waitForFunction(() => document.querySelectorAll('#foldTrack .fold-item').length === 3 && document.querySelectorAll('#sensitivityBody tr').length === 5, null, { timeout: 30000 });
    await page.waitForSelector('#eqChart canvas', { timeout: 30000 });
  }
  await settlePage(page);
}

const scenarios = [
  ...['dashboard', 'screener', 'backtest'].flatMap(pageName => [
    { pageName, device: 'desktop', viewport: { width: 1440, height: 1000 } },
    { pageName, device: 'mobile', viewport: { width: 390, height: 844 } },
  ]),
];

const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: true }, logLevel: 'error' });
let browser;
const failures = [];
try {
  await server.listen();
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--force-color-profile=srgb'] });
  const baseURL = `http://127.0.0.1:${server.httpServer.address().port}`;
  for (const scenario of scenarios) {
    const name = `${scenario.pageName}-${scenario.device}`;
    const context = await createContext(browser, baseURL, scenario.pageName, scenario.viewport);
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await prepare(page, scenario.pageName);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 2, `${name} horizontal overflow: ${overflow}px`);
      assert.deepEqual(errors, [], `${name} browser errors: ${errors.join('; ')}`);

      const masks = {
        dashboard: ['#updateTime'],
        screener: ['#scanStatus'],
        backtest: ['#btStatus', '#btSub'],
      }[scenario.pageName];
      const actualPath = resolve(OUTPUT_DIR, `${name}.png`);
      const diffPath = resolve(OUTPUT_DIR, `${name}-diff.png`);
      const baselinePath = resolve(BASELINE_DIR, `${name}.png`);
      const actual = await page.screenshot({
        path: actualPath, fullPage: true, animations: 'disabled', caret: 'hide',
        mask: masks.map(selector => page.locator(selector)), maskColor: '#0A0E14',
      });
      if (UPDATE) {
        writeFileSync(baselinePath, actual);
        console.log(`[visual:update] ${name} ${actual.length} bytes`);
        continue;
      }
      if (!existsSync(baselinePath)) {
        failures.push(`${name}: missing baseline; run npm run test:visual:update`);
        continue;
      }
      const expected = PNG.sync.read(readFileSync(baselinePath));
      const received = PNG.sync.read(actual);
      if (expected.width !== received.width || expected.height !== received.height) {
        failures.push(`${name}: dimensions ${received.width}x${received.height}, expected ${expected.width}x${expected.height}`);
        continue;
      }
      const diff = new PNG({ width: expected.width, height: expected.height });
      const pixels = pixelmatch(expected.data, received.data, diff.data, expected.width, expected.height, { threshold: PIXEL_THRESHOLD });
      const ratio = pixels / (expected.width * expected.height);
      if (ratio > ALLOWED_DIFF_RATIO) {
        writeFileSync(diffPath, PNG.sync.write(diff));
        failures.push(`${name}: ${(ratio * 100).toFixed(3)}% pixels differ; actual=${actualPath}; diff=${diffPath}`);
      } else {
        console.log(`[visual] ${name}: ${(ratio * 100).toFixed(3)}% difference`);
      }
    } catch (error) {
      failures.push(`${name}: ${error.stack || error.message}`);
    } finally {
      await context.close();
    }
  }
  if (failures.length) throw new Error(`Visual regression failed:\n${failures.join('\n')}`);
  console.log(`[visual] ${scenarios.length} deterministic baselines ${UPDATE ? 'updated' : 'passed'}`);
} finally {
  if (browser) await browser.close();
  await server.close();
}
