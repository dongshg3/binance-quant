// ============================================================
// tracker.js · 浏览器端信号追踪（IndexedDB 反馈闭环）
// 每次深度分析加载时记录信号快照；后续访问时回填实际走势，
// 形成「信号 → 结果」的本地验证数据。数据只存在用户浏览器，
// 可在「模型进化」页导出 CSV 用于离线分析。
// ============================================================

const DB_NAME = 'bq_signal_tracker';
const DB_VER = 1;
const STORE = 'signals';
const HORIZONS = [4, 12, 24]; // 前向 bar 数
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error('IndexedDB 不可用')); return; }
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'key' });
        os.createIndex('by_symbol', 'symbol', { unique: false });
        os.createIndex('by_time', 'time', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const out = fn(store);
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
  });
}

// 记录一条信号快照。同一币种+周期+小时内只记一条（去重）。
export async function logSignal(snapshot) {
  try {
    const db = await openDB();
    const hourBucket = Math.floor(snapshot.time / 36e5);
    const key = `${snapshot.symbol}|${snapshot.interval}|${hourBucket}`;
    const rec = {
      key,
      time: snapshot.time,
      symbol: snapshot.symbol,
      interval: snapshot.interval,
      market: snapshot.market,
      price: snapshot.price,
      composite: snapshot.composite,
      fused: snapshot.fused,
      direction: snapshot.direction, // 1 多 / -1 空 / 0 观望
      weightSource: snapshot.weightSource || 'static',
      origin: snapshot.origin || 'dashboard',
      groupAverages: snapshot.groupAverages,
      regime: snapshot.regime || '',
      outcomes: null, // 回填后: { ret4, ret12, ret24, mfe24, mae24, labeledAt }
    };
    await tx(db, 'readwrite', s => s.put(rec));
  } catch (e) { /* 静默失败，不影响主流程 */ }
}

// 回填已到期信号的实际收益。fetchKlines(symbol, interval, limit, market) → candles
export async function labelOutcomes(fetchKlines) {
  const stats = { scanned: 0, labeled: 0, errors: 0 };
  try {
    const db = await openDB();
    const all = await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, 'readonly');
      const req = t.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    const pending = all.filter(r => !r.outcomes);
    stats.scanned = pending.length;
    // 按 symbol|interval 分组，每组只拉一次K线
    const groups = {};
    for (const r of pending) {
      const gk = `${r.symbol}|${r.interval}|${r.market}`;
      (groups[gk] = groups[gk] || []).push(r);
    }
    const intervalMs = { '15m': 9e5, '1h': 36e5, '4h': 144e5, '1d': 864e5 };
    for (const gk in groups) {
      const recs = groups[gk];
      const { symbol, interval, market } = recs[0];
      const needBars = HORIZONS[HORIZONS.length - 1] + 2;
      // 最早的待回填信号到现在是否已过 24 bar
      const oldest = Math.min(...recs.map(r => r.time));
      if (Date.now() - oldest < HORIZONS[HORIZONS.length - 1] * (intervalMs[interval] || 36e5)) continue;
      let candles;
      try {
        candles = await fetchKlines(symbol, interval, Math.min(300, needBars + Math.ceil((Date.now() - oldest) / (intervalMs[interval] || 36e5)) + 5), market);
      } catch (e) { stats.errors++; continue; }
      if (!candles || !candles.length) continue;
      for (const r of recs) {
        // 找到信号时间之后第一根完整 bar 作为入场基准
        const idx = candles.findIndex(k => k.time >= r.time);
        if (idx < 0 || idx + HORIZONS[HORIZONS.length - 1] >= candles.length) continue; // 还没到 24 bar
        const entry = candles[idx].close;
        if (!entry) continue;
        const fwd = h => (candles[idx + h].close - entry) / entry;
        let mfe = -Infinity, mae = Infinity;
        for (let i = 1; i <= HORIZONS[HORIZONS.length - 1]; i++) {
          const ret = (candles[idx + i].close - entry) / entry;
          const signed = ret * (r.direction || 1);
          if (signed > mfe) mfe = signed;
          if (signed < mae) mae = signed;
        }
        r.outcomes = {
          ret4: fwd(4), ret12: fwd(12), ret24: fwd(24),
          mfe24: mfe, mae24: mae,
          labeledAt: Date.now(),
        };
        try {
          await tx(db, 'readwrite', s => s.put(r));
          stats.labeled++;
        } catch (e) { stats.errors++; }
      }
    }
  } catch (e) { /* IndexedDB 不可用时整体静默 */ }
  return stats;
}

// 汇总统计：按方向 × horizon 的胜率/平均收益（以信号方向为准的有向收益）
export async function getStats() {
  try {
    const db = await openDB();
    const all = await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, 'readonly');
      const req = t.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    const labeled = all.filter(r => r.outcomes && r.direction !== 0);
    const horizons = [['ret4', 4], ['ret12', 12], ['ret24', 24]];
    const byDir = { long: {}, short: {}, all: {} };
    for (const [hk, h] of horizons) {
      for (const bucket of ['long', 'short', 'all']) {
        const rows = labeled.filter(r => bucket === 'all' || (bucket === 'long' ? r.direction > 0 : r.direction < 0));
        if (!rows.length) { byDir[bucket][h] = null; continue; }
        const signed = rows.map(r => r.outcomes[hk] * r.direction);
        const wins = signed.filter(x => x > 0).length;
        byDir[bucket][h] = {
          n: rows.length,
          winRate: wins / rows.length,
          avgRet: signed.reduce((a, b) => a + b, 0) / rows.length,
        };
      }
    }
    return {
      total: all.length,
      labeled: labeled.length,
      pending: all.length - all.filter(r => r.outcomes).length,
      byDir,
      byWeightSource: groupCount(labeled, r => r.weightSource),
      byOrigin: originBreakdown(labeled),
    };
  } catch (e) {
    return null;
  }
}

function groupCount(rows, keyFn) {
  const m = {};
  for (const r of rows) { const k = keyFn(r); m[k] = (m[k] || 0) + 1; }
  return m;
}

// 按来源（深度分析页 / 扫描页）拆分 T+24bar 表现
function originBreakdown(labeled) {
  const out = {};
  for (const r of labeled) {
    const k = r.origin || 'dashboard';
    const o = out[k] = out[k] || { n: 0, wins: 0, sum: 0 };
    const signed = r.outcomes.ret24 * r.direction;
    o.n++;
    if (signed > 0) o.wins++;
    o.sum += signed;
  }
  for (const k in out) {
    out[k].winRate = out[k].wins / out[k].n;
    out[k].avgRet = out[k].sum / out[k].n;
    delete out[k].wins; delete out[k].sum;
  }
  return out;
}

// 导出全部记录为 CSV 并触发下载
export async function exportCSV() {
  const db = await openDB();
  const all = await new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readonly');
    const req = t.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  const head = ['time', 'symbol', 'interval', 'market', 'price', 'composite', 'fused', 'direction', 'weightSource', 'regime',
    'trend', 'momentum', 'meanRev', 'volume', 'volatility', 'position', 'futures',
    'ret4', 'ret12', 'ret24', 'mfe24', 'mae24'];
  const lines = [head.join(',')];
  for (const r of all) {
    const g = r.groupAverages || {};
    const o = r.outcomes || {};
    lines.push([
      new Date(r.time).toISOString(), r.symbol, r.interval, r.market, r.price, r.composite, r.fused, r.direction,
      r.weightSource, `"${(r.regime || '').replace(/"/g, '""')}"`,
      g.trend, g.momentum, g.meanRev, g.volume, g.volatility, g.position, g.futures,
      o.ret4, o.ret12, o.ret24, o.mfe24, o.mae24,
    ].map(x => x == null ? '' : x).join(','));
  }
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `signal-tracker-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  return all.length;
}
