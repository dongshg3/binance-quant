// ============================================================
// arena.js · 策略竞技场（云端版）：只读客户端
//
// 竞技场引擎已迁移到云端（train/arena_tick.py · GitHub Actions 每 30 分钟），
// 状态存 data/arena/state.json。浏览器不再跑 tick —— 不开网站竞技场也持续运行，
// 选手进程不会被人为打断（页面无重置/手动运行入口）。
//
// 本文件只负责：拉取云端状态 + 派生页面数据结构。
// ============================================================

export const ARENA_INTERVALS = {
  '15m': { ms: 9e5,    seasonMs: 3 * 864e5,  horizon: 8,  entryThreshold: 0.20 },
  '1h':  { ms: 36e5,   seasonMs: 7 * 864e5,  horizon: 12, entryThreshold: 0.15 },
  '4h':  { ms: 144e5,  seasonMs: 21 * 864e5, horizon: 12, entryThreshold: 0.12 },
  '1d':  { ms: 864e5,  seasonMs: 60 * 864e5, horizon: 14, entryThreshold: 0.10 },
};

export const FAMILIES = {
  trend:      { name: '趋势跟随' }, meanRev: { name: '均值回归' }, momentum: { name: '动量突破' },
  hybrid:     { name: '混合均衡' }, contrarian: { name: '逆向反转' }, volumeOnly: { name: '纯量能' },
  htfTrend:   { name: '高周期趋势' }, random: { name: '随机对照' }, staticRef: { name: '静态对照' },
  learned:    { name: '云端模型' }, coin: { name: '逐币模型' },
};
const CONTROL_FAMILIES = new Set(['random', 'staticRef', 'learned', 'coin']);
export const FEE_RT = 0.0014; // 往返手续费 + 滑点（与引擎一致）

const STATE_URL = 'data/arena/state.json';
const CACHE_MS = 5 * 60 * 1000;
let cache = { time: 0, promise: null, data: null };

export async function loadArenaState(force = false) {
  if (!force && cache.data && Date.now() - cache.time < CACHE_MS) return cache.data;
  if (cache.promise) return cache.promise;
  cache.promise = (async () => {
    try {
      const res = await fetch(`${STATE_URL}?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('state.json HTTP ' + res.status);
      const data = await res.json();
      cache = { time: Date.now(), promise: null, data };
      return data;
    } catch (e) {
      cache.promise = null;
      if (cache.data) return cache.data;
      throw e;
    }
  })();
  return cache.promise;
}

// ---------------- 派生统计 ----------------
function deriveStats(agg) {
  const n = agg ? agg.n : 0;
  if (!n) return { n: 0, wins: 0, totalRet: 0, meanRet: 0, tStat: 0, sharpe: 0, winRate: 0, mfeAvg: 0, maeAvg: 0 };
  const mean = agg.sum / n;
  const sd = Math.sqrt(Math.max(0, agg.sumSq / n - mean * mean));
  return {
    n, wins: agg.wins, totalRet: agg.sum, meanRet: mean,
    tStat: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0,
    sharpe: sd > 0 ? mean / sd : 0,
    winRate: agg.wins / n, mfeAvg: agg.mfeSum / n, maeAvg: agg.maeSum / n,
  };
}

function rankScore(st) {
  // 带符号 t 值：稳定盈利居前、稳定亏损居末（旧版 |t| 会把稳定亏损者排第一，已修正）
  const n = st.n || 0;
  return n >= 8 ? (st.tStat || 0) : -999 + n * 0.01;
}

// ---------------- 页面数据接口 ----------------
export async function getArenaState() {
  const state = await loadArenaState();
  const players = state.players || [];
  const signals = state.signals || [];
  const seasons = state.seasons || [];
  const out = {};
  for (const iv of Object.keys(ARENA_INTERVALS)) {
    const ivPlayers = players.filter(p => p.interval === iv);
    const active = ivPlayers.filter(p => p.status !== 'retired')
      .sort((a, b) => rankScore(b.stats || deriveStats(b.career)) - rankScore(a.stats || deriveStats(a.career)));
    out[iv] = {
      players: active,
      retired: ivPlayers.filter(p => p.status === 'retired'),
      season: [...seasons].reverse().find(s => s.interval === iv) || null,
      seasonStart: active.length ? Math.min(...active.map(p => p.seasonStart)) : Date.now(),
      pending: signals.filter(s => s.interval === iv && (s.status === 'pending_entry' || s.status === 'pending_exit')).length,
      filled: signals.filter(s => s.interval === iv && s.status === 'filled').length,
    };
  }
  const totalFilledEver = players.reduce((a, p) => a + ((p.career && p.career.n) || 0), 0);
  return {
    intervals: out,
    seasons: [...seasons].reverse().slice(0, 12),
    totalSignals: totalFilledEver + signals.length,
    updatedAt: state.updatedAt || null,
    symbols: state.symbols || [],
    raw: state,
  };
}

// 当前冠军们的最新信号（首个赛季完成前：每周期取当前第一的进化组选手）
export async function getChampionSignals(limit = 12) {
  const state = await loadArenaState();
  const players = state.players || [];
  let champs = players.filter(p => p.isChampion && p.status === 'active');
  if (!champs.length) {
    for (const iv of Object.keys(ARENA_INTERVALS)) {
      const top = players
        .filter(p => p.interval === iv && p.status === 'active' && !CONTROL_FAMILIES.has(p.family))
        .sort((a, b) => rankScore(b.stats || {}) - rankScore(a.stats || {}))[0];
      if (top) champs.push(top);
    }
  }
  const champSet = new Set(champs.map(p => p.id));
  return (state.signals || [])
    .filter(s => champSet.has(s.playerId) && s.status !== 'invalid')
    .sort((a, b) => b.signalBarTime - a.signalBarTime)
    .slice(0, limit);
}

// 选手详情：持仓 / 待入场 / 最近操作 / 迭代谱系
export async function getPlayerDetail(playerId, recentN = 8) {
  const state = await loadArenaState();
  const players = state.players || [];
  const me = players.find(p => p.id === playerId);
  if (!me) return null;
  const sigs = (state.signals || []).filter(s => s.playerId === playerId)
    .sort((a, b) => b.signalBarTime - a.signalBarTime);
  // 谱系：向上找祖先，向下找后代（含已退役）
  const byId = Object.fromEntries(players.map(p => [p.id, p]));
  const lineage = [];
  let cur = me;
  while (cur) { lineage.unshift(cur); cur = cur.parentId ? byId[cur.parentId] : null; }
  const children = players.filter(p => p.parentId === playerId);
  return {
    player: me,
    openPositions: sigs.filter(s => s.status === 'pending_exit'),
    pendingEntry: sigs.filter(s => s.status === 'pending_entry'),
    recent: sigs.filter(s => s.status === 'filled' || s.status === 'invalid').slice(0, recentN),
    lineage, children,
  };
}

// 逐币模型实盘战绩（供「模型进化」页对照训练 IC）
export async function getCoinLiveStats() {
  const state = await loadArenaState();
  const coinLive = state.coinLive || {};
  const pendingBySym = {};
  let pendingTotal = 0;
  for (const s of state.signals || []) {
    if (s.family === 'coin' && (s.status === 'pending_entry' || s.status === 'pending_exit')) {
      pendingBySym[s.symbol] = (pendingBySym[s.symbol] || 0) + 1;
      pendingTotal++;
    }
  }
  const mk = (agg, pending) => {
    const st = deriveStats(agg);
    return {
      signals: st.n + pending, pending,
      n: st.n, winRate: st.n ? st.winRate : null, totalRet: st.n ? st.totalRet : null,
      meanRet: st.n ? st.meanRet : null, tStat: st.n > 1 ? st.tStat : null,
    };
  };
  const bySym = {};
  const totalAgg = { n: 0, wins: 0, sum: 0, sumSq: 0, mfeSum: 0, maeSum: 0 };
  const syms = new Set([...Object.keys(coinLive), ...Object.keys(pendingBySym)]);
  for (const sym of syms) {
    const agg = coinLive[sym];
    bySym[sym] = mk(agg, pendingBySym[sym] || 0);
    if (agg) for (const k in totalAgg) totalAgg[k] += agg[k] || 0;
  }
  return { bySym, overall: mk(totalAgg, pendingTotal) };
}
