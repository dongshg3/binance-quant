// ============================================================
// news.js · 消息面因子数据层
// 数据源：GitHub Actions 每小时抓取的 data/news.json 静态快照
//   （RSS 五源 + Reddit + Fear & Greed Index，VADER 情绪打分）
// 前端零 API key、零跨域问题；30 分钟本地缓存。
// ============================================================

const CACHE_KEY = 'bq_news_cache_v1';
const CACHE_MS = 30 * 60 * 1000;

let memSnap = null;

export async function getNewsSnapshot() {
  if (memSnap && Date.now() - memSnap._fetchedAt < CACHE_MS) return memSnap;
  try {
    const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (cache && Date.now() - cache._fetchedAt < CACHE_MS) { memSnap = cache; return cache; }
  } catch (e) { /* ignore */ }
  try {
    const res = await fetch('data/news.json?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('news.json HTTP ' + res.status);
    const snap = await res.json();
    snap._fetchedAt = Date.now();
    memSnap = snap;
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(snap)); } catch (e) { /* 快照大约几十 KB，超配额则只留内存 */ }
    return snap;
  } catch (e) {
    if (memSnap) return memSnap;
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (e2) { return null; }
  }
}

// 喂给因子引擎的 per-coin 消息面因子（无该币新闻时仍返回全局情绪项）
export function newsFactorFor(snap, symbol) {
  if (!snap) return null;
  const base = (symbol || '').replace(/USDT$/, '');
  const coin = snap.coins && snap.coins[base];
  const out = {
    fgiZ: snap.fgi?.z ?? null,
    coinSent: coin?.sent ?? null,
    coinBuzz: coin?.buzz ?? 0,
    coinBuzzRel: coin?.buzzRel ?? 0,
  };
  if (out.fgiZ == null && out.coinSent == null) return null;
  return out;
}

// 仪表盘「消息面」面板用的完整信息
export async function getNewsView(symbol) {
  const snap = await getNewsSnapshot();
  if (!snap) return null;
  const base = (symbol || '').replace(/USDT$/, '');
  const coin = snap.coins && snap.coins[base];
  return {
    updatedAt: snap.updatedAt,
    ageH: snap.updatedAt ? (Date.now() - new Date(snap.updatedAt).getTime()) / 36e5 : null,
    fgi: snap.fgi || null,
    globalSent: snap.globalSent ?? null,
    totalItems: snap.totalItems ?? 0,
    coinSent: coin?.sent ?? null,
    coinBuzz: coin?.buzz ?? 0,
    coinBuzzRel: coin?.buzzRel ?? 0,
    top: coin?.top || [],
  };
}
