import test from 'node:test';
import assert from 'node:assert/strict';
import { fundingDynamics, fundingDynamicScores } from '../js/lib/funding.js';

test('funding dynamics use event history and preserve causal prefixes', () => {
  const hist = Array.from({ length: 12 }, (_, i) => i * 0.0001);
  const d = fundingDynamics(hist);
  assert.equal(fundingDynamics(hist.slice(0, 9)).z, null);
  assert.ok(Number.isFinite(d.z));
  assert.ok(Math.abs(d.delta - 0.0001) < 1e-12);
  assert.ok(Math.abs(d.accel) < 1e-12);
  assert.deepEqual(fundingDynamics(hist.slice(0, 7)), fundingDynamics(hist.slice(0, 7)));
  assert.deepEqual(fundingDynamicScores({ z: 4, delta: -0.001, accel: 0.0001 }), [-1, 1, -0.2]);
});

test('funding window is 90 events and current rate replaces no history', () => {
  const hist = Array.from({ length: 120 }, (_, i) => (i - 50) * 0.00001);
  const d = fundingDynamics(hist);
  const last = hist.slice(-90), mean = last.reduce((a, b) => a + b, 0) / 90;
  const sd = Math.sqrt(last.reduce((s, x) => s + (x - mean) ** 2, 0) / 90);
  assert.ok(Math.abs(d.z - (hist.at(-1) - mean) / sd) < 1e-12);
  assert.equal(fundingDynamics([], 0.0002).rate, 0.0002);
  assert.equal(fundingDynamics([], 0.0002).events, 1);
});
