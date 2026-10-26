import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { existsSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';

const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const executablePath = process.env.CHROME_PATH || (existsSync(chrome) ? chrome : edge);
mkdirSync('.tmp', { recursive: true });
const port = Number(process.env.UI_TEST_PORT || 0);
const server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true }, logLevel: 'error' });
let browser;
const errors = [];
try {
  await server.listen();
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const baseURL = `http://127.0.0.1:${server.httpServer.address().port}`;
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const watch = page => {
    page.on('pageerror', e => errors.push(`${page.url()}: ${e.message}`));
    page.on('console', msg => { if (msg.type() === 'error' || msg.type() === 'warning') console.log(`[browser:${msg.type()}] ${msg.text()}`); });
    page.on('requestfailed', req => console.log(`[request failed] ${req.url()} ${req.failure()?.errorText}`));
  };

  const dashboard = await context.newPage(); watch(dashboard);
  await dashboard.goto('/index.html?symbol=BTCUSDT&market=futures&interval=1h', { waitUntil: 'domcontentloaded' });
  await dashboard.waitForFunction(() => document.querySelector('#priceNow')?.textContent !== '—', null, { timeout: 45000 });
  await dashboard.waitForSelector('#coinModelContent .metric');
  assert.equal(await dashboard.locator('#coinModelContent .metric').count(), 8);
  assert.ok(await dashboard.locator('#marketQualityMetrics .metric').count() >= 8);
  await dashboard.keyboard.press('Control+k');
  assert.equal(await dashboard.locator('.command-palette').isVisible(), true);
  await dashboard.keyboard.press('Escape');
  await dashboard.locator('#densityBtn').click();
  assert.equal(await dashboard.locator('body.compact').count(), 1);
  await dashboard.locator('#densityBtn').click();
  await dashboard.screenshot({ path: '.tmp/dashboard.png', fullPage: true });
  console.log('[ui] 深度分析、模型诊断、快捷导航、密度切换通过');

  const evolution = await context.newPage(); watch(evolution);
  await evolution.goto('/evolution.html', { waitUntil: 'domcontentloaded' });
  await evolution.waitForSelector('.coin-model-row', { timeout: 45000 });
  await evolution.locator('#coinModelSearch').fill('BTC');
  const btcRows = evolution.locator('.coin-model-row:visible');
  assert.ok(await btcRows.count() >= 1);
  for (let i = 0; i < await btcRows.count(); i++) {
    assert.ok((await btcRows.nth(i).getAttribute('data-sym')).includes('BTC'));
  }
  await btcRows.first().locator('.coin-expand').click();
  assert.equal(await btcRows.first().locator('.coin-expand').getAttribute('aria-expanded'), 'true');
  assert.equal(await evolution.locator('.coin-detail-row:visible .evidence-section').count(), 3);
  await evolution.locator('#coinModelSearch').fill('');
  await evolution.locator('#coinModelFilters [data-filter="shadow"]').click();
  const shadowRows = evolution.locator('.coin-model-row:visible');
  assert.ok(await shadowRows.count() >= 1);
  for (let i = 0; i < Math.min(await shadowRows.count(), 20); i++) {
    assert.equal(await shadowRows.nth(i).getAttribute('data-status'), 'shadow');
  }
  await evolution.locator('#coinModelFilters [data-filter="all"]').click();
  await evolution.screenshot({ path: '.tmp/evolution.png', fullPage: true });
  console.log('[ui] 逐币搜索、状态筛选、证据展开和页内导航通过');

  const scanRows = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'].map((symbol, i) => ({
    symbol, price: 100 + i, change24h: i - 1, quoteVolume: 2e8, score: [0.4, -0.2, 0.05][i],
    rsi: 50 + i, adx: 30, squeeze: 0.8, volRatio: 1.8, annVol: 0.6, atr: 2, position: 0.2,
    direction: 1, regime: { label: '趋势市', cls: 'trend' }, funding: 0.0001,
    edgeKind: 'coin', edgeIC: 0.03, coinStatus: i === 2 ? 'shadow' : 'active', coinT: 2.3, xsPct: 1 - i / 2, xsZ: 1 - i,
  }));
  const screener = await context.newPage(); watch(screener);
  await screener.addInitScript(rows => {
    localStorage.setItem('bq_scan_cache_v2', JSON.stringify({ market: 'futures', interval: '1h', minVol: 1000000, time: Date.now(), funding: {}, results: rows }));
  }, scanRows);
  await screener.goto('/screener.html', { waitUntil: 'domcontentloaded' });
  await screener.waitForSelector('#screenerBody tr[data-sym]');
  await screener.locator('#coinSearch').fill('BTC');
  await screener.waitForTimeout(150);
  assert.equal(await screener.locator('#screenerBody tr[data-sym]').count(), 1);
  await screener.locator('#coinSearch').fill('');
  const downloadPromise = screener.waitForEvent('download');
  await screener.locator('#exportScanBtn').click();
  const download = await downloadPromise;
  assert.ok(download.suggestedFilename().endsWith('.csv'));
  await screener.locator('#coinSearch').fill('');
  await screener.screenshot({ path: '.tmp/screener.png', fullPage: true });
  console.log('[ui] 全市场缓存恢复、搜索、模型字段和 CSV 导出通过');

  const backtest = await context.newPage(); watch(backtest);
  await backtest.goto('/backtest.html?symbol=BTCUSDT&market=spot&interval=1h', { waitUntil: 'domcontentloaded' });
  await backtest.waitForSelector('#symInput', { timeout: 60000 });
  await backtest.locator('#limitInput').fill('900');
  await backtest.locator('#runBtn').click();
  await backtest.waitForFunction(() => {
    const status = document.querySelector('#btStatus')?.textContent || '';
    if (status.startsWith('失败')) throw new Error(status);
    return status.startsWith('完成');
  }, null, { timeout: 60000 });
  assert.ok(await backtest.locator('#btMetrics .metric').count() >= 15);
  assert.equal(await backtest.locator('#sensitivityBody tr').count(), 5);
  assert.equal(await backtest.locator('#foldTrack .fold-item').count(), 3);
  const btDownloadPromise = backtest.waitForEvent('download');
  await backtest.locator('#exportBtBtn').click();
  await btDownloadPromise;
  await backtest.screenshot({ path: '.tmp/backtest.png', fullPage: true });
  console.log('[ui] 完整回测、稳健性、压力测试和交易导出通过');

  const mobile = await context.newPage(); watch(mobile);
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto('/index.html?symbol=BTCUSDT&market=spot&interval=1h', { waitUntil: 'domcontentloaded' });
  await mobile.waitForSelector('#coinModelContent .metric', { timeout: 45000 });
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 2) console.log('[mobile overflow]', await mobile.evaluate(() => [...document.querySelectorAll('body *')].map(el => ({ tag: el.tagName, id: el.id, cls: el.className, left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right, width: el.getBoundingClientRect().width })).filter(x => x.right > window.innerWidth + 2 || x.left < -2).slice(0, 30)));
  assert.ok(overflow <= 2, `移动端页面横向溢出 ${overflow}px`);
  await mobile.screenshot({ path: '.tmp/mobile.png', fullPage: true });
  await mobile.goto('/evolution.html', { waitUntil: 'domcontentloaded' });
  await mobile.waitForSelector('.coin-model-row', { timeout: 45000 });
  const evolutionOverflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (evolutionOverflow > 2) console.log('[evolution mobile overflow]', await mobile.evaluate(() => [...document.querySelectorAll('body *')].map(el => ({ tag: el.tagName, id: el.id, cls: el.className, left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right, width: el.getBoundingClientRect().width })).filter(x => x.right > window.innerWidth + 2 || x.left < -2).slice(0, 30)));
  assert.ok(evolutionOverflow <= 2, `逐币覆盖台移动端横向溢出 ${evolutionOverflow}px`);
  await mobile.locator('#coinModelSearch').fill('UNI');
  assert.ok(await mobile.locator('.coin-model-row:visible').count() >= 1);
  await mobile.screenshot({ path: '.tmp/evolution-mobile.png', fullPage: true });
  console.log('[ui] 390px 移动端布局与逐币覆盖台通过');

  assert.deepEqual(errors, [], `浏览器脚本错误：\n${errors.join('\n')}`);
  console.log('[ui] 全部页面无未捕获脚本错误');
} finally {
  if (browser) await browser.close();
  await server.close();
}
