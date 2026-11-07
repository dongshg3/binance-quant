import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { existsSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';

const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const executablePath = process.env.CHROME_PATH || (existsSync(chrome) ? chrome : edge);
mkdirSync('.tmp', { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
let browser;
const errors = [];
const badResponses = [];
try {
  await server.listen();
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('response', res => { if (res.status() === 404) badResponses.push(res.url()); });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/arena.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.master-entry', { timeout: 30000 });
  assert.equal(await page.locator('.master-entry').count(), 50);
  assert.match(await page.locator('#masterMetrics').textContent(), /50 位/);
  assert.match(await page.locator('#masterMetrics').textContent(), /42 位/);
  assert.match(await page.locator('#masterMetrics').textContent(), /8 位/);
  assert.equal(await page.locator('.waiting-status').count(), 42);

  await page.locator('#masterSearch').fill('Connors');
  assert.equal(await page.locator('.master-entry').count(), 1);
  assert.match(await page.locator('.master-name').textContent(), /Larry Connors/);
  await page.locator('.master-name').click();
  assert.equal(await page.locator('.master-name').getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator('.master-detail:visible .detail-block').count(), 5);
  assert.ok(await page.locator('.master-detail:visible .sources-block a').count() >= 1);
  assert.match(await page.locator('.master-detail:visible').textContent(), /RSI\(2\)/);
  await page.locator('.master-name').click();
  assert.equal(await page.locator('.master-detail:visible').count(), 0);

  await page.locator('#masterSearch').fill('');
  await page.locator('#masterCategory').selectOption({ label: '均值回归' });
  assert.equal(await page.locator('.master-entry').count(), 1);
  await page.locator('#masterCategory').selectOption('all');
  await page.locator('#masterPool').selectOption('archive');
  assert.equal(await page.locator('.master-entry').count(), 8);
  await page.locator('#masterSearch').fill('Dalton');
  assert.equal(await page.locator('.master-entry').count(), 1);
  await page.locator('.master-name').click();
  assert.match(await page.locator('.master-detail:visible').textContent(), /不进入当前竞技场/);
  assert.equal(await page.locator('.master-detail:visible .master-weight-row').count(), 0);
  await page.locator('#masterPool').selectOption('all');
  await page.locator('#masterSearch').fill('');
  await page.locator('#masterEvidence').selectOption('C');
  assert.equal(await page.locator('.master-entry').count(), 2);
  await page.locator('#masterEvidence').selectOption('all');
  await page.screenshot({ path: '.tmp/arena-masters-desktop.png', fullPage: true });
  console.log('[masters] 50 档案、42 入池、8 仅档案、搜索筛选与详情来源通过');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#masterSearch').fill('Minervini');
  assert.equal(await page.locator('.master-entry').count(), 1);
  await page.locator('.master-name').click();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 2, `移动端横向溢出 ${overflow}px`);
  const targetHeight = await page.locator('.master-name').evaluate(el => el.getBoundingClientRect().height);
  assert.ok(targetHeight >= 44);
  await page.screenshot({ path: '.tmp/arena-masters-mobile.png', fullPage: true });
  console.log('[masters] 390px 移动端、44px 触控与详情布局通过');

  assert.deepEqual(errors, [], `浏览器错误：${errors.join('\n')}`);
  assert.deepEqual(badResponses, [], `404：${badResponses.join('\n')}`);
  console.log('[masters] 无浏览器脚本错误、无 404');
} finally {
  if (browser) await browser.close();
  await server.close();
}
