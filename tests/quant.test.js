import test from 'node:test';
import assert from 'node:assert/strict';
import { evalModelAST, runBacktest, setModel, weightSourceInfo, computeFactors } from '../js/lib/quant.js';

function candles(n = 480) {
  let price = 100;
  return Array.from({ length: n }, (_, i) => {
    const ret = Math.sin(i * 0.17) * 0.008 + Math.cos(i * 0.047) * 0.004;
    const open = price;
    const close = open * Math.exp(ret);
    const high = Math.max(open, close) * 1.003;
    const low = Math.min(open, close) * 0.997;
    price = close;
    return { time: 1700000000000 + i * 3600000, open, high, low, close, volume: 1e6 * (1 + 0.3 * Math.sin(i * 0.11)) };
  });
}

test('AST preprocessing and tree traversal match the exported contract', () => {
  const ast = { type: 'trees', cols: [0, 2], prep: { kind: 'median', med: [5, 1] }, base: 0.2, scale: 0.5,
    trees: [{ nodes: [{ f: 1, t: 2, l: 1, r: 2, leaf: false }, { f: -1, t: 0, l: -1, r: -1, v: 1, leaf: true }, { f: -1, t: 0, l: -1, r: -1, v: 3, leaf: true }] }] };
  assert.equal(evalModelAST(ast, [1, 99, 3]), 1.7);
  assert.equal(evalModelAST(ast, [1, 99, NaN]), 0.7);
});

test('only active coin models take over; shadow models retain parent routing', () => {
  setModel({ version: 1, weights: { trend: 1 }, scoreScale: 1, oos: { icXS: 0.02 }, segments: {}, symbolMeta: {},
    coinModels: { AAA: { status: 'active', weights: { trend: 1 }, ic: 0.04 }, BBB: { status: 'shadow', weights: { trend: 1 }, ic: 0.4 } } });
  assert.equal(weightSourceInfo('AAA').kind, 'coin');
  assert.equal(weightSourceInfo('BBB').kind, 'global');
  assert.equal(weightSourceInfo('BBB').coinStatus, 'shadow');
  setModel(null);
});

test('backtest prefix is invariant to future candles', () => {
  const data = candles();
  const full = runBacktest(data, '1h', { warmup: 60, bootstrap: false });
  const prefix = runBacktest(data.slice(0, 450), '1h', { warmup: 60, bootstrap: false });
  assert.equal(prefix.error, undefined);
  assert.deepEqual(prefix.returns, full.returns.slice(0, prefix.returns.length));
  assert.deepEqual(prefix.equity, full.equity.slice(0, prefix.equity.length));
  assert.ok(prefix.trades.every(t => t.signalTime < t.time));
});

test('higher execution costs cannot improve identical-signal net results', () => {
  const data = candles();
  const low = runBacktest(data, '1h', { warmup: 60, feeRate: 0.0002, slippage: 0.0001, bootstrap: false });
  const high = runBacktest(data, '1h', { warmup: 60, feeRate: 0.002, slippage: 0.001, bootstrap: false });
  assert.ok(high.metrics.totalReturn <= low.metrics.totalReturn);
  assert.ok(high.metrics.totalCosts >= low.metrics.totalCosts);
  assert.equal(high.robustness, null);
});

test('robustness reports PSR and reproducible bootstrap intervals', () => {
  const a = runBacktest(candles(), '1h', { warmup: 60 });
  const b = runBacktest(candles(), '1h', { warmup: 60 });
  assert.ok(a.robustness.psr >= 0 && a.robustness.psr <= 1);
  assert.deepEqual(a.robustness.returnCI95, b.robustness.returnCI95);
  assert.equal(a.robustness.simulations, 240);
});

test('funding follows UTC timestamps rather than candle array indexes', () => {
  const aligned = candles().map((c, i) => {
    const open = 100 * Math.exp(i * 0.001), close = 100 * Math.exp((i + 1) * 0.001);
    return { ...c, time: Date.UTC(2026, 0, 2) + i * 3600000, open, close, high: close * 1.001, low: open * 0.999 };
  });
  const offset = aligned.map(c => ({ ...c, time: c.time + 1800000 }));
  // Isolate the funding clock from factor routing: a trend-only model keeps a
  // deterministic long position instead of accidentally staying flat all test.
  setModel({ version: 1, weights: { trend: 1 }, scoreScale: 0.5, segments: {}, symbolMeta: {}, coinModels: {} });
  try {
    const onClock = runBacktest(aligned, '1h', { warmup: 60, bootstrap: false });
    const offClock = runBacktest(offset, '1h', { warmup: 60, bootstrap: false });
    assert.ok(onClock.metrics.fundingEvents > 0);
    assert.equal(offClock.metrics.fundingEvents, 0);
    assert.equal(offClock.metrics.fundingCashflow, 0);
  } finally {
    setModel(null);
  }
});

test('funding dynamics are gated by the model feature contract', () => {
  const data = candles();
  const extra = { fundingRate: 0.0011, fundingHist: Array.from({ length: 20 }, (_, i) => 0.0001 * Math.sin(i)) };
  try {
    setModel({ version: 1, weights: { futures: 1 }, scoreScale: 1, segments: {}, symbolMeta: {}, coinModels: {} });
    const legacy = computeFactors(data, extra);
    assert.equal(legacy.groups.futures.length, 3);
    assert.ok(Number.isFinite(legacy.rawIndicators.fundingZ));
    setModel({ version: 2, featureSet: { fundingDynamics: true }, weights: { futures: 1 }, scoreScale: 1, segments: {}, symbolMeta: {}, coinModels: {} });
    const current = computeFactors(data, extra);
    assert.equal(current.groups.futures.length, 6);
    assert.notEqual(current.groupAverages.futures, legacy.groupAverages.futures);
  } finally {
    setModel(null);
  }
});
