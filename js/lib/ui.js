// ============================================================
// ui.js · 共享 UI：导航栏 / 图标库 / 动效助手 / 格式化 / 控件
// ============================================================
import { arenaAutoTick } from './arena.js';

// ---------------- Lucide 开源图标（ISC License · lucide.dev） ----------------
const ICON_PATHS = {
  candlestick: '<path d="M9 5v4"/><rect width="4" height="6" x="7" y="9" rx="1"/><path d="M9 15v2"/><path d="M17 3v2"/><rect width="4" height="8" x="15" y="5" rx="1"/><path d="M17 13v3"/><path d="M3 3v16a2 2 0 0 0 2 2h16"/>',
  radar: '<path d="M19.07 4.93A10 10 0 0 0 6.99 3.34"/><path d="M4 6h.01"/><path d="M2.29 9.62A10 10 0 1 0 21.31 8.35"/><path d="M16.24 7.76A6 6 0 1 0 8.23 16.67"/><path d="M12 18h.01"/><path d="M17.99 11.66A6 6 0 0 1 15.77 16.67"/><circle cx="12" cy="12" r="2"/><path d="m13.41 10.59 5.66-5.66"/>',
  flask: '<path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2"/><path d="M8.5 2h7"/><path d="M7 16h10"/>',
  book: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
  cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  scale: '<path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  trendUp: '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
  trendDown: '<polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/>',
  thermometer: '<path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"/>',
  bulb: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  clipboard: '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>',
  sliders: '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
  loader: '<path d="M12 2v4"/><path d="m16.2 7.8 2.9-2.9"/><path d="M18 12h4"/><path d="m16.2 16.2 2.9 2.9"/><path d="M12 18v4"/><path d="m4.9 19.1 2.9-2.9"/><path d="M2 12h4"/><path d="m4.9 4.9 2.9 2.9"/>',
  radio: '<path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"/>',
  package: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  chartLine: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="m19 9-5 5-4-4-3 3"/>',
  swords: '<polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5"/><line x1="13" x2="19" y1="19" y2="13"/><line x1="16" x2="20" y1="16" y2="20"/><line x1="19" x2="21" y1="21" y2="19"/><polyline points="14.5 6.5 18 3 21 3 21 6 17.5 9.5"/><line x1="5" x2="9" y1="14" y2="18"/><line x1="7" x2="4" y1="17" y2="20"/><line x1="3" x2="5" y1="19" y2="21"/>',
  trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
  crown: '<path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.735H5.81a1 1 0 0 1-.957-.735L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"/><path d="M5 21h14"/>',
};

export function icon(name, cls = '') {
  const d = ICON_PATHS[name] || '';
  return `<span class="ic ${cls}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg></span>`;
}

/** 将静态 HTML 中的 <span data-icon="name"></span> 水合为 SVG 图标 */
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => {
    if (el.dataset.hydrated) return;
    el.classList.add('ic');
    el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[el.dataset.icon] || ''}</svg>`;
    el.dataset.hydrated = '1';
  });
}

// ---------------- 动效助手 ----------------
/** 元素轻微回弹（信号变化等状态切换时使用） */
export function pop(el) {
  if (!el) return;
  el.classList.remove('pop');
  void el.offsetWidth;
  el.classList.add('pop');
}

/** 内容无缝交换：淡出 → 替换 → 淡入（类 Morph 过渡） */
export function swapHTML(el, html) {
  if (!el) { return; }
  el.classList.add('swap-out');
  setTimeout(() => {
    el.innerHTML = html;
    el.classList.remove('swap-out');
    el.classList.add('swap-in');
    setTimeout(() => el.classList.remove('swap-in'), 220);
  }, 140);
}

/** 为页面面板注入交错入场延迟 */
export function staggerPanels() {
  requestAnimationFrame(() => {
    document.querySelectorAll('.page .panel, .page .chart-wrap, .page > .controls').forEach((el, i) => {
      el.style.setProperty('--i', Math.min(i, 12));
    });
  });
}

// ---------------- 导航 ----------------
export function renderNav(active) {
  const pages = [
    { href: 'index.html', id: 'dashboard', label: '深度分析', ic: 'candlestick' },
    { href: 'screener.html', id: 'screener', label: '全市场扫描', ic: 'radar' },
    { href: 'arena.html', id: 'arena', label: '策略竞技场', ic: 'swords' },
    { href: 'backtest.html', id: 'backtest', label: '回测中心', ic: 'flask' },
    { href: 'strategy.html', id: 'strategy', label: '策略方法论', ic: 'book' },
    { href: 'evolution.html', id: 'evolution', label: '模型进化', ic: 'cpu' },
  ];
  const nav = document.createElement('div');
  nav.className = 'nav';
  nav.innerHTML = `
    <div class="brand">${icon('candlestick')}币安量化系统 <small>Quant Research · 仅供学习研究</small></div>
    ${pages.map(p => `<a class="tab ${p.id === active ? 'active' : ''}" href="${p.href}">${icon(p.ic)}${p.label}</a>`).join('')}
    <div class="net"><span class="dot" id="netDot"></span><span id="netText">连接中…</span></div>
  `;
  document.body.prepend(nav);
  hydrateIcons();
  staggerPanels();
  // 策略竞技场后台 tick（10 分钟节流，失败静默，不影响页面）
  try { arenaAutoTick(); } catch (e) { /* 竞技场不可用不影响主站 */ }
}

export function setNet(text, cls) {
  const dot = document.getElementById('netDot');
  const t = document.getElementById('netText');
  if (dot) dot.className = 'dot ' + cls;
  if (t) t.textContent = text;
}

// ---------------- 格式化 ----------------
export function fmtPrice(x) {
  if (x == null || isNaN(x)) return '—';
  if (x >= 1000) return x.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (x >= 1) return x.toFixed(3);
  if (x >= 0.01) return x.toFixed(5);
  return x.toPrecision(4);
}
export function fmtPct(x, digits = 2, signed = true) {
  if (x == null || isNaN(x)) return '—';
  const s = signed && x > 0 ? '+' : '';
  return s + (x * 100).toFixed(digits) + '%';
}
export function fmtPct100(x, digits = 2, signed = true) { // 输入已是百分数
  if (x == null || isNaN(x)) return '—';
  const s = signed && x > 0 ? '+' : '';
  return s + x.toFixed(digits) + '%';
}
export function fmtNum(x, digits = 2) {
  if (x == null || isNaN(x)) return '—';
  if (!isFinite(x)) return '∞';
  return x.toFixed(digits);
}
export function fmtVol(x) {
  if (x == null || isNaN(x)) return '—';
  if (x >= 1e9) return (x / 1e9).toFixed(2) + 'B';
  if (x >= 1e6) return (x / 1e6).toFixed(2) + 'M';
  if (x >= 1e3) return (x / 1e3).toFixed(1) + 'K';
  return x.toFixed(0);
}
export function fmtTime(ms) {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
export function clsBySign(x) { return x > 0 ? 'up' : x < 0 ? 'down' : ''; }

// ---------------- URL 参数 ----------------
export function getParams() {
  const p = new URLSearchParams(location.search);
  return { symbol: p.get('symbol'), market: p.get('market'), interval: p.get('interval') };
}
export function goDashboard(symbol, market, interval) {
  const q = new URLSearchParams();
  if (symbol) q.set('symbol', symbol);
  if (market) q.set('market', market);
  if (interval) q.set('interval', interval);
  location.href = 'index.html?' + q.toString();
}

// ---------------- 可搜索币种选择器 ----------------
export function buildSymbolPicker(container, symbols, current, onChange) {
  container.innerHTML = `
    <input list="symList" id="symInput" placeholder="搜索币种" style="width:130px" value="${current || ''}">
    <datalist id="symList">${symbols.map(s => `<option value="${s}">`).join('')}</datalist>
  `;
  const input = container.querySelector('#symInput');
  const commit = () => {
    const v = input.value.trim().toUpperCase();
    if (symbols.includes(v) && v !== current) onChange(v);
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') commit(); });
}

export function disclaimerHTML() {
  return `<div class="disclaimer">
    ${icon('alert')}<b>风险提示</b> 本系统所有内容仅供量化研究与学习使用，不构成任何投资建议。信号、预测与回测均基于历史数据的统计推断，<b>不代表未来收益</b>。加密货币合约交易具有极高风险，可能导致本金全部损失。实盘前请进行充分的样本外验证与小资金实测，并自行承担全部交易风险。
  </div>`;
}
