// ============================================================
// arena.js · 策略竞技场：多周期选手池 · 全自动模拟实盘 · 赛季进化
//
// 与「每 6 小时重训一个模型」互补的另一条进化路线：
//   · 8 个策略族 × 4 个周期 = 32 名选手同时跑模拟实盘
//   · 信号在 K 线收盘时冻结记录，下一根开盘入场，到期结算
//   · 赛季结束按「样本外」战绩自然选择：淘汰末位、复制变异强者
//   · 随机对照组 + 静态对照组永在场：冠军若跑不赢随机，说明无 alpha
// 全部数据存在用户浏览器 IndexedDB，零 token、零服务器。
// ============================================================
import { fetchKlines, loadTickers, EXCLUDED_BASES } from './api.js';
import { computeFactors } from './quant.js';

const DB_NAME = 'bq_arena';
const DB_VER = 1;
const TICK_MS = 10 * 60 * 1000;          // 全站节流：两次 tick 至少间隔 10 分钟
const SCAN_SYMBOLS = 24;                  // 每周期扫描的币种数（按 24h 成交额）
const FEE_RT = 0.0005 * 2 + 0.0002 * 2;   // 往返手续费 + 滑点

export const ARENA_INTERVALS = {
  '15m': { ms: 9e5,    seasonMs: 3 * 864e5,  horizon: 8,  entryThreshold: 0.20 },
  '1h':  { ms: 36e5,   seasonMs: 7 * 864e5,  horizon: 12, entryThreshold: 0.15 },
  '4h':  { ms: 144e5,  seasonMs: 21 * 864e5, horizon: 12, entryThreshold: 0.12 },
  '1d':  { ms: 864e5,  seasonMs: 60 * 864e5, horizon: 14, entryThreshold: 0.10 },
};

// 8 个策略族：权重直接作用在七因子组得分上（与主引擎同一套 groupAverages）
export const FAMILIES = {
  trend:      { name: '趋势跟随', weights: { trend: 0.50, momentum: 0.15, meanRev: 0.05, volume: 0.15, volatility: 0.05, position: 0.05, htf: 0.05, futures: 0.00 } },
  meanRev:    { name: '均值回归', weights: { trend: 0.05, momentum: 0.10, meanRev: 0.55, volume: 0.10, volatility: 0.10, position: 0.05, htf: 0.00, futures: 0.05 } },
  momentum:   { name: '动量突破', weights: { trend: 0.15, momentum: 0.45, meanRev: 0.05, volume: 0.20, volatility: 0.05, position: 0.05, htf: 0.05, futures: 0.00 } },
  hybrid:     { name: '混合均衡', weights: { trend: 0.25, momentum: 0.20, meanRev: 0.15, volume: 0.15, volatility: 0.10, position: 0.05, htf: 0.05, futures: 0.05 } },
  contrarian: { name: '逆向反转', weights: { trend: -0.30, momentum: -0.25, meanRev: 0.30, volume: -0.10, volatility: 0.05, position: 0.05, htf: 0.00, futures: 0.05 } },
  volumeOnly: { name: '纯量能',   weights: { trend: 0.10, momentum: 0.05, meanRev: 0.05, volume: 0.65, volatility: 0.05, position: 0.05, htf: 0.05, futures: 0.00 } },
  htfTrend:   { name: '高周期趋势', weights: { trend: 0.20, momentum: 0.05, meanRev: 0.05, volume: 0.05, volatility: 0.05, position: 0.05, htf: 0.50, futures: 0.05 } },
  random:     { name: '随机对照', weights: null },   // 每赛季重新随机：冠军的及格线
  staticRef:  { name: '静态对照', weights: { trend: 0.22, momentum: 0.18, meanRev: 0.13, volume: 0.13, volatility: 0.09, position: 0.05, htf: 0.10, futures: 0.10 } },
  learned:    { name: '云端模型', weights: null },   // data/model.json 全局学习权重，随云端训练自动更新
  coin:       { name: '逐币模型', weights: null },   // data/model.json coinModels：34 个单币种专训权重，实盘验证场
};
const CONTROL_FAMILIES = new Set(['random', 'staticRef', 'learned', 'coin']); // 基准组：不淘汰、不复制

// 云端学习权重（6 小时缓存；learned 族用全局权重，coin 族用 coinModels 逐币权重）
async function fetchLearnedWeights() {
  try {
    const cache = JSON.parse(localStorage.getItem('bq_arena_model') || 'null');
    if (cache && Date.now() - cache.time < 6 * 36e5 && cache.coinModels) return cache;
  } catch (e) { /* ignore */ }
  try {
    const res = await fetch('data/model.json?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('model.json HTTP ' + res.status);
    const m = await res.json();
    if (!m || !m.weights) throw new Error('model.json 无权重');
    const out = { time: Date.now(), trainedAt: m.trainedAt, weights: m.weights, coinModels: m.coinModels || {} };
    try { localStorage.setItem('bq_arena_model', JSON.stringify(out)); } catch (e) { /* ignore */ }
    return out;
  } catch (e) {
    try { return JSON.parse(localStorage.getItem('bq_arena_model') || 'null'); } catch (e2) { return null; }
  }
}

// ---------------- IndexedDB ----------------
let dbPromise = null;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error('IndexedDB 不可用')); return; }
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('players')) {
        const p = db.createObjectStore('players', { keyPath: 'id' });
        p.createIndex('by_iv', 'interval', { unique: false });
      }
      if (!db.objectStoreNames.contains('signals')) {
        const s = db.createObjectStore('signals', { keyPath: 'id' });
        s.createIndex('by_status', 'status', { unique: false });
        s.createIndex('by_player', 'playerId', { unique: false });
      }
      if (!db.objectStoreNames.contains('seasons')) {
        db.createObjectStore('seasons', { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function txStore(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
  });
}
async function getAll(store, indexName, query) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readonly');
    const src = indexName ? t.objectStore(store).index(indexName) : t.objectStore(store);
    const req = query !== undefined ? src.getAll(query) : src.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

// ---------------- 选手 ----------------
const rid = () => Math.random().toString(36).slice(2, 8);
const emptyStats = () => ({ n: 0, wins: 0, totalRet: 0, meanRet: 0, tStat: 0, sharpe: 0, winRate: 0, mfeAvg: 0, maeAvg: 0 });

function randomWeights() {
  const keys = ['trend', 'momentum', 'meanRev', 'volume', 'volatility', 'position', 'htf', 'futures'];
  const w = {};
  let sum = 0;
  for (const k of keys) { w[k] = (Math.random() * 2 - 1) * 0.4; sum += Math.abs(w[k]); }
  for (const k of keys) w[k] /= sum || 1;
  return w;
}

let poolsPromise = null;
async function ensurePools() {
  if (poolsPromise) return poolsPromise;  // 单例防并发重复建池
  poolsPromise = (async () => {
    const db = await openDB();
    const existing = await getAll('players');
    const have = new Set(existing.map(p => `${p.interval}|${p.family}`));
    const adds = [];
    const needLearned = Object.keys(ARENA_INTERVALS).some(iv => !have.has(`${iv}|learned`) || !have.has(`${iv}|coin`));
    const learned = needLearned ? await fetchLearnedWeights() : null;
    for (const iv of Object.keys(ARENA_INTERVALS)) {
      for (const [fam, def] of Object.entries(FAMILIES)) {
        if (have.has(`${iv}|${fam}`)) continue;  // 该周期该族已存在（任何世代）
        const w = (fam === 'learned' || fam === 'coin')
          ? { ...(learned?.weights || FAMILIES.hybrid.weights) }   // coin 族占位权重；实盘计分按币种动态取 coinModels
          : (def.weights ? { ...def.weights } : randomWeights());
        adds.push({
          id: `${iv}_${fam}_g0_${rid()}`,
          interval: iv, family: fam, familyName: def.name,
          generation: 0, parentId: null,
          weights: w,
          modelTrainedAt: (fam === 'learned' || fam === 'coin') ? (learned?.trainedAt || null) : undefined,
          params: { horizon: ARENA_INTERVALS[iv].horizon, entryThreshold: ARENA_INTERVALS[iv].entryThreshold },
          status: 'active',
          createdAt: Date.now(), seasonStart: Date.now(),
          stats: emptyStats(), seasonStats: null,
        });
      }
    }
    for (const p of adds) await txStore(db, 'players', 'readwrite', s => s.put(p));
    return getAll('players');
  })();
  try {
    return await poolsPromise;
  } finally {
    poolsPromise = null;
  }
}

// ---------------- 信号生成 ----------------
// 计分：coin 族按币种动态取 coinModels 专训权重；该币无专训模型时返回 null（跳过）
function playerScore(p, g, sym, coinModels) {
  let w = p.weights;
  if (p.family === 'coin') {
    const cm = coinModels && coinModels[sym];
    if (!cm || !cm.weights) return null;
    w = cm.weights;
  }
  let s = 0;
  for (const k in w) s += (w[k] || 0) * (g[k] || 0);
  return s;
}

async function generateForInterval(iv, symbols) {
  const cfg = ARENA_INTERVALS[iv];
  const lastKey = `bq_arena_lastbar_${iv}`;
  const players = (await getAll('players', 'by_iv', iv)).filter(p => p.status !== 'retired');
  if (!players.length) return 0;
  const hasCoin = players.some(p => p.family === 'coin');
  const coinModels = hasCoin ? ((await fetchLearnedWeights())?.coinModels || null) : null;
  const db = await openDB();
  let created = 0;
  for (const sym of symbols) {
    let candles;
    try { candles = await fetchKlines(sym, iv, 130, 'futures'); } catch (e) { continue; }
    if (!candles || candles.length < 80) continue;
    const lastBar = candles[candles.length - 1];
    // 只在新收盘 bar 上生成一次
    const seenKey = `${lastKey}_${sym}`;
    if (Number(localStorage.getItem(seenKey) || 0) >= lastBar.time) continue;
    localStorage.setItem(seenKey, String(lastBar.time));
    const f = computeFactors(candles, null, sym);
    if (!f) continue;
    const g = f.groupAverages;
    for (const p of players) {
      const score = playerScore(p, g, sym, coinModels);
      if (score == null || Math.abs(score) < p.params.entryThreshold) continue;
      const id = `${p.id}|${sym}|${lastBar.time}`;
      const rec = {
        id, playerId: p.id, interval: iv, symbol: sym,
        family: p.family, generation: p.generation,
        signalBarTime: lastBar.time,
        direction: score > 0 ? 'long' : 'short',
        score: Math.round(score * 10000) / 10000,
        entryBarTime: lastBar.time + cfg.ms,
        entryPrice: null, exitBarTime: null, exitPrice: null,
        grossReturn: null, netReturn: null, mfe: null, mae: null,
        status: 'pending_entry', createdAt: Date.now(),
        ...(p.family === 'coin' && coinModels?.[sym] ? { coinIc: coinModels[sym].ic, coinN: coinModels[sym].n } : {}),
      };
      try { await txStore(db, 'signals', 'readwrite', s => s.put(rec)); created++; } catch (e) { /* 重复 id 忽略 */ }
    }
  }
  return created;
}

// ---------------- 回填与结算 ----------------
async function backfill() {
  const pe = await getAll('signals', 'by_status', 'pending_entry');
  const px = await getAll('signals', 'by_status', 'pending_exit');
  const pending = pe.concat(px);
  if (!pending.length) return 0;
  const db = await openDB();
  const players = {};
  for (const p of await getAll('players')) players[p.id] = p;
  // 按 symbol|interval 分组，每组只拉一次 K 线
  const groups = {};
  for (const r of pending) {
    const gk = `${r.symbol}|${r.interval}`;
    (groups[gk] = groups[gk] || []).push(r);
  }
  let filled = 0;
  for (const gk in groups) {
    const recs = groups[gk];
    const { symbol, interval } = recs[0];
    const cfg = ARENA_INTERVALS[interval];
    const maxHorizon = Math.max(...recs.map(r => (players[r.playerId]?.params.horizon) || cfg.horizon));
    let candles;
    try {
      candles = await fetchKlines(symbol, interval, Math.min(400, maxHorizon + 10), 'futures');
    } catch (e) { continue; }
    if (!candles || !candles.length) continue;
    for (const r of recs) {
      const horizon = (players[r.playerId]?.params.horizon) || cfg.horizon;
      if (r.status === 'pending_entry') {
        const eb = candles.find(c => c.time === r.entryBarTime);
        if (!eb) {
          if (Date.now() > r.entryBarTime + cfg.ms * 3) { r.status = 'invalid'; await txStore(db, 'signals', 'readwrite', s => s.put(r)); }
          continue;
        }
        r.entryPrice = eb.open;
        r.status = 'pending_exit';
        await txStore(db, 'signals', 'readwrite', s => s.put(r));
      }
      const exitBarTime = r.entryBarTime + cfg.ms * horizon;
      if (Date.now() < exitBarTime + cfg.ms) continue; // 出场 bar 未收盘
      const xb = candles.find(c => c.time === exitBarTime);
      if (!xb) continue;
      const dir = r.direction === 'long' ? 1 : -1;
      const entry = r.entryPrice;
      r.grossReturn = dir * (xb.close - entry) / entry;
      r.netReturn = r.grossReturn - FEE_RT;
      const path = candles.filter(c => c.time > r.entryBarTime && c.time <= exitBarTime);
      if (path.length) {
        r.mfe = Math.max(...path.map(c => dir * (c.high - entry) / entry));
        r.mae = Math.min(...path.map(c => dir * (c.low - entry) / entry));
      }
      r.exitBarTime = exitBarTime;
      r.exitPrice = xb.close;
      r.status = 'filled';
      await txStore(db, 'signals', 'readwrite', s => s.put(r));
      filled++;
    }
  }
  if (filled) await recomputeStats();
  return filled;
}

function statsFromSignals(sigs) {
  const st = emptyStats();
  if (!sigs.length) return st;
  const rets = sigs.map(s => s.netReturn).filter(x => x != null);
  if (!rets.length) return st;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / rets.length);
  st.n = rets.length;
  st.totalRet = rets.reduce((a, b) => a + b, 0);
  st.meanRet = mean;
  st.wins = rets.filter(r => r > 0).length;
  st.winRate = st.wins / rets.length;
  st.tStat = sd > 0 ? mean / (sd / Math.sqrt(rets.length)) : 0;
  st.sharpe = sd > 0 ? mean / sd : 0;
  st.mfeAvg = sigs.reduce((a, s) => a + (s.mfe || 0), 0) / sigs.length;
  st.maeAvg = sigs.reduce((a, s) => a + (s.mae || 0), 0) / sigs.length;
  return st;
}

async function recomputeStats() {
  const db = await openDB();
  const players = await getAll('players');
  const filled = await getAll('signals', 'by_status', 'filled');
  const byPlayer = {};
  for (const s of filled) (byPlayer[s.playerId] = byPlayer[s.playerId] || []).push(s);
  for (const p of players) {
    p.stats = statsFromSignals(byPlayer[p.id] || []);
    await txStore(db, 'players', 'readwrite', s => s.put(p));
  }
}

// ---------------- 赛季进化 ----------------
function mutateWeights(w, sigma) {
  const out = {};
  let sum = 0;
  for (const k in w) { out[k] = w[k] + (Math.random() * 2 - 1) * sigma * Math.max(0.15, Math.abs(w[k])); sum += Math.abs(out[k]); }
  if (sum > 0) for (const k in out) out[k] /= sum;
  return out;
}

async function maybeRunSeason(iv) {
  const cfg = ARENA_INTERVALS[iv];
  const players = (await getAll('players', 'by_iv', iv)).filter(p => p.status !== 'retired');
  if (!players.length) return null;
  const seasonStart = Math.min(...players.map(p => p.seasonStart));
  if (Date.now() - seasonStart < cfg.seasonMs) return null;

  const db = await openDB();
  const filled = (await getAll('signals', 'by_status', 'filled')).filter(s => s.interval === iv && s.exitBarTime >= seasonStart);
  const byPlayer = {};
  for (const s of filled) (byPlayer[s.playerId] = byPlayer[s.playerId] || []).push(s);

  // 赛季内战绩排名（对照组也参与排名 —— 它们就是及格线）
  const ranked = players.map(p => {
    const ss = statsFromSignals(byPlayer[p.id] || []);
    p.seasonStats = ss;
    const score = ss.n >= 8 ? ss.tStat * Math.sign(ss.meanRet || 0) : -999 + ss.n * 0.01;
    return { p, ss, score };
  }).sort((a, b) => b.score - a.score);

  const evolvable = ranked.filter(r => !CONTROL_FAMILIES.has(r.p.family));
  const champion = ranked[0];            // 赛季第一（可能是对照组 —— 如实记录）
  const championEvo = evolvable[0];      // 进化组第一（冠军信号来源）
  const nEv = evolvable.length;
  const retireN = Math.max(1, Math.floor(nEv * 0.3));

  // 淘汰末位（对照组豁免）
  for (const r of evolvable.slice(nEv - retireN)) {
    r.p.status = 'retired';
    r.p.retiredAt = Date.now();
    r.p.retiredReason = `赛季末 t=${r.ss.tStat.toFixed(2)} n=${r.ss.n} 排名末位`;
    await txStore(db, 'players', 'readwrite', s => s.put(r.p));
  }
  // 强者复制 + 变异（保留母体）
  const survivors = evolvable.slice(0, Math.max(1, Math.floor(nEv * 0.5)));
  const activeCount = players.filter(p => p.status === 'active').length;
  let room = Math.max(0, 14 - activeCount + retireN); // 每周期池子上限 ~14
  for (const r of survivors) {
    if (room <= 0) break;
    const child = {
      id: `${iv}_${r.p.family}_g${r.p.generation + 1}_${rid()}`,
      interval: iv, family: r.p.family, familyName: r.p.familyName,
      generation: r.p.generation + 1, parentId: r.p.id,
      weights: mutateWeights(r.p.weights, 0.20),
      params: {
        horizon: Math.max(4, Math.min(30, r.p.params.horizon + Math.round((Math.random() * 2 - 1) * 3))),
        entryThreshold: Math.max(0.06, Math.min(0.30, r.p.params.entryThreshold + (Math.random() * 2 - 1) * 0.03)),
      },
      status: 'active', createdAt: Date.now(), seasonStart: Date.now(),
      stats: emptyStats(), seasonStats: null,
    };
    await txStore(db, 'players', 'readwrite', s => s.put(child));
    room--;
  }
  // 随机对照组每赛季重新随机；全员进入新赛季
  for (const r of ranked) {
    if (r.p.family === 'random') r.p.weights = randomWeights();
    r.p.seasonStart = Date.now();
    r.p.status = r.p.status === 'retired' ? 'retired' : 'active';
    await txStore(db, 'players', 'readwrite', s => s.put(r.p));
  }
  // 冠军标记（进化组第一，用于「冠军当前信号」）
  for (const r of ranked) {
    if (r.p.status !== 'retired') {
      r.p.isChampion = (r === championEvo);
      await txStore(db, 'players', 'readwrite', s => s.put(r.p));
    }
  }
  const log = {
    interval: iv, finishedAt: Date.now(),
    players: ranked.length,
    champion: { family: champion.p.family, name: champion.p.familyName, gen: champion.p.generation, stats: champion.ss },
    randomRank: ranked.findIndex(r => r.p.family === 'random') + 1,
    staticRank: ranked.findIndex(r => r.p.family === 'staticRef') + 1,
    learnedRank: ranked.findIndex(r => r.p.family === 'learned') + 1,
    coinRank: ranked.findIndex(r => r.p.family === 'coin') + 1,
    table: ranked.map(r => ({ family: r.p.family, name: r.p.familyName, gen: r.p.generation, n: r.ss.n, tStat: +r.ss.tStat.toFixed(2), meanRet: +r.ss.meanRet.toFixed(5), winRate: +r.ss.winRate.toFixed(3), retired: r.p.status === 'retired' })),
  };
  await txStore(db, 'seasons', 'readwrite', s => s.put(log));
  return log;
}

// ---------------- 全站自动调度（节流） ----------------
let ticking = false;
export async function arenaAutoTick(force = false) {
  try {
    if (ticking) return null;
    const last = Number(localStorage.getItem('bq_arena_lasttick') || 0);
    if (!force && Date.now() - last < TICK_MS) return null;
    ticking = true;
    localStorage.setItem('bq_arena_lasttick', String(Date.now()));

    await ensurePools();
    // learned 族选手跟随云端模型更新（每 6h 缓存刷新一次）
    const lm = await fetchLearnedWeights();
    if (lm && lm.weights) {
      const db0 = await openDB();
      for (const p of (await getAll('players')).filter(p => p.family === 'learned' || p.family === 'coin')) {
        if (p.modelTrainedAt !== lm.trainedAt) {
          if (p.family === 'learned') p.weights = { ...lm.weights };
          // coin 族权重在计分时按币种实时取自 coinModels，这里只同步模型版本标记
          p.modelTrainedAt = lm.trainedAt;
          await txStore(db0, 'players', 'readwrite', s => s.put(p));
        }
      }
    }
    const filled = await backfill();
    // 币种池：按成交额 Top N，6 小时缓存
    let symbols = [];
    try {
      const cache = JSON.parse(localStorage.getItem('bq_arena_syms') || 'null');
      if (cache && Date.now() - cache.time < 6 * 36e5) symbols = cache.symbols;
    } catch (e) { /* ignore */ }
    if (!symbols.length) {
      const tk = await loadTickers('futures');
      // 只保留 USDT 永续（与主站口径一致），排除稳定币/指数与 USDC 报价
      symbols = Object.keys(tk).filter(s => s.endsWith('USDT') && tk[s].quoteVolume > 0 && !EXCLUDED_BASES.has(s.replace('USDT', '')))
        .sort((a, b) => tk[b].quoteVolume - tk[a].quoteVolume)
        .slice(0, SCAN_SYMBOLS);
      try { localStorage.setItem('bq_arena_syms', JSON.stringify({ time: Date.now(), symbols })); } catch (e) { /* ignore */ }
    }
    let created = 0;
    for (const iv of Object.keys(ARENA_INTERVALS)) {
      created += await generateForInterval(iv, symbols);
      await maybeRunSeason(iv);
    }
    return { filled, created };
  } catch (e) {
    return null; // 竞技场失败不影响主站
  } finally {
    ticking = false;
  }
}

// ---------------- 页面数据接口 ----------------
export async function getArenaState() {
  await ensurePools();
  const players = await getAll('players');
  const seasons = await getAll('seasons');
  const signals = await getAll('signals');
  const out = {};
  for (const iv of Object.keys(ARENA_INTERVALS)) {
    const ps = players.filter(p => p.interval === iv && p.status !== 'retired')
      .sort((a, b) => (b.stats.tStat * Math.sign(b.stats.meanRet || 0)) - (a.stats.tStat * Math.sign(a.stats.meanRet || 0)));
    out[iv] = {
      players: ps,
      season: [...seasons].reverse().find(s => s.interval === iv) || null,
      seasonStart: ps.length ? Math.min(...ps.map(p => p.seasonStart)) : Date.now(),
      pending: signals.filter(s => s.interval === iv && s.status !== 'filled' && s.status !== 'invalid').length,
      filled: signals.filter(s => s.interval === iv && s.status === 'filled').length,
    };
  }
  return { intervals: out, seasons: [...seasons].reverse().slice(0, 12), totalSignals: signals.length };
}

// 当前冠军们的最新待结算信号（机会窗口：竞争选出的策略此刻在看什么）
export async function getChampionSignals(limit = 12) {
  const players = await getAll('players');
  let champs = players.filter(p => p.isChampion && p.status === 'active');
  if (!champs.length) {
    // 首个赛季未完成前：每周期取当前战绩第一的进化组选手
    for (const iv of Object.keys(ARENA_INTERVALS)) {
      const top = players
        .filter(p => p.interval === iv && p.status === 'active' && !CONTROL_FAMILIES.has(p.family))
        .sort((a, b) => (b.stats.tStat * Math.sign(b.stats.meanRet || 0)) - (a.stats.tStat * Math.sign(a.stats.meanRet || 0)))[0];
      if (top) champs.push(top);
    }
  }
  const champSet = new Set(champs.map(p => p.id));
  const sigs = await getAll('signals');
  return sigs
    .filter(s => champSet.has(s.playerId) && s.status !== 'invalid')
    .sort((a, b) => b.signalBarTime - a.signalBarTime)
    .slice(0, limit);
}

// ---------------- 逐币模型实盘战绩（供「模型进化」页对照训练 IC） ----------------
export async function getCoinLiveStats() {
  const sigs = await getAll('signals');
  const coinSigs = sigs.filter(s => s.family === 'coin' && s.status !== 'invalid');
  const agg = (list) => {
    const filled = list.filter(s => s.status === 'filled' && s.netReturn != null);
    const rets = filled.map(s => s.netReturn);
    const n = rets.length;
    const mean = n ? rets.reduce((a, b) => a + b, 0) / n : null;
    const sd = n ? Math.sqrt(rets.reduce((a, x) => a + (x - mean) ** 2, 0) / n) : null;
    return {
      signals: list.length,
      pending: list.length - filled.length,
      n,
      winRate: n ? rets.filter(r => r > 0).length / n : null,
      totalRet: n ? rets.reduce((a, b) => a + b, 0) : null,
      meanRet: mean,
      tStat: n > 1 && sd > 0 ? mean / (sd / Math.sqrt(n)) : null,
    };
  };
  const bySym = {};
  for (const s of coinSigs) (bySym[s.symbol] = bySym[s.symbol] || []).push(s);
  const out = {};
  for (const sym in bySym) out[sym] = agg(bySym[sym]);
  return { bySym: out, overall: agg(coinSigs) };
}

export async function resetArena() {
  const db = await openDB();
  for (const store of ['players', 'signals', 'seasons']) {
    await new Promise((resolve, reject) => {
      const t = db.transaction(store, 'readwrite');
      const req = t.objectStore(store).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
  // 清掉全部竞技场 localStorage 标记（含每币种 bar 去重键，否则重置后永不生成信号）
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith('bq_arena')) localStorage.removeItem(k);
  }
  await ensurePools();
}
