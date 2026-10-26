import test from 'node:test';
import assert from 'node:assert/strict';
import { bookMetrics, orderFlowImbalance, signedTradeVolume, aggregateTrades } from '../js/lib/microstructure.js';

const book = (bp, bq, ap, aq) => ({ bids: [[bp, bq], [bp - 1, bq * 2], [bp - 2, bq * 3], [bp - 3, bq * 4], [bp - 4, bq * 5]], asks: [[ap, aq], [ap + 1, aq * 2], [ap + 2, aq * 3], [ap + 3, aq * 4], [ap + 4, aq * 5]] });

test('book metrics compute imbalance, spread and microprice', () => {
  const m = bookMetrics(book(99, 3, 101, 1));
  assert.equal(m.mid, 100);
  assert.equal(m.microprice, 100.5);
  assert.equal(m.spreadBps, 200);
  assert.equal(m.micropriceDeviationBps, 50);
  assert.equal(m.imbalance1, 0.5);
  assert.equal(m.imbalance5, 0.5);
  assert.equal(m.imbalance20, 0.5);
});

test('OFI needs two snapshots and has the expected pressure sign', () => {
  assert.equal(orderFlowImbalance(null, book(99, 3, 101, 1)), null);
  const up = orderFlowImbalance(book(99, 3, 101, 1), book(100, 4, 102, 1));
  assert.equal(up.ofi, 5); // 新买量 4 + 撤走原卖量 1
  const down = orderFlowImbalance(book(99, 3, 101, 1), book(98, 3, 100, 2));
  assert.equal(down.ofi, -5); // 原买量撤走 3 - 新卖量 2
  const equal = orderFlowImbalance(book(99, 3, 101, 1), book(99, 4, 101, 0.5));
  assert.equal(equal.ofi, 1.5);
});

test('aggTrade maker flag gives CVD the correct sign and ids deduplicate', () => {
  assert.equal(signedTradeVolume({ q: 2, m: true }), -2);
  assert.equal(signedTradeVolume({ q: 2, m: false }), 2);
  const trades = [{ a: 1, q: 2, m: false, T: 10 }, { a: 2, q: 3, m: true, T: 20 }];
  const first = aggregateTrades(trades);
  assert.equal(first.cvd, -1);
  assert.equal(first.buyVolume, 2);
  assert.equal(first.sellVolume, 3);
  const seen = new Set(first.ids);
  assert.equal(aggregateTrades([...trades, { a: 3, q: 4, m: false, T: 30 }], seen).cvd, 4);
});
