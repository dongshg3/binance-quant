// ============================================================
// ui.js · 共享 UI：导航栏 / 格式化 / 控件
// ============================================================

export function renderNav(active) {
  const pages = [
    { href: 'index.html', id: 'dashboard', label: '深度分析' },
    { href: 'screener.html', id: 'screener', label: '全市场扫描' },
    { href: 'backtest.html', id: 'backtest', label: '回测中心' },
    { href: 'strategy.html', id: 'strategy', label: '策略方法论' },
  ];
  const nav = document.createElement('div');
  nav.className = 'nav';
  nav.innerHTML = `
    <div class="brand">币安量化系统 <small>Quant Research · 仅供学习研究</small></div>
    ${pages.map(p => `<a class="tab ${p.id === active ? 'active' : ''}" href="${p.href}">${p.label}</a>`).join('')}
    <div class="net"><span class="dot" id="netDot"></span><span id="netText">连接中…</span></div>
  `;
  document.body.prepend(nav);
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
    ⚠️ <b>风险提示</b>：本系统所有内容仅供量化研究与学习使用，不构成任何投资建议。信号、预测与回测均基于历史数据的统计推断，<b>不代表未来收益</b>。加密货币合约交易具有极高风险，可能导致本金全部损失。实盘前请进行充分的样本外验证与小资金实测，并自行承担全部交易风险。
  </div>`;
}
