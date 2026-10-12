// ============================================================
// screener.js · 全市场扫描（全部 USDT 永续 / 现货）
// ============================================================
import { Stats } from './lib/stats.js';
import { loadAllSymbols, loadTickers, fetchKlines, fetchAllPremiumIndex } from './lib/api.js';
import { computeFactors, computePosition, detectRegime, signalOf, buildTradePlan } from './lib/quant.js';
import { renderNav, setNet, fmtPrice, fmtPct100, fmtPct, fmtNum, fmtVol, clsBySign, goDashboard, disclaimerHTML } from './lib/ui.js';

renderNav('screener');
document.getElementById('disclaimerSlot').innerHTML = disclaimerHTML();

const $ = id => document.getElementById(id);
const CACHE_KEY = 'bq_scan_cache_v1';
const state = {
  market: 'futures', interval: '1h',
  symbols: [], tickers: {}, funding: {}, results: [],
  scanning: false, autoTimer: null,
  sortKey: 'score', sortDir: -1,
};

// ---------------- 结果持久化（刷新不丢） ----------------
function saveCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      market: state.market, interval: state.interval,
      minVol: parseFloat($('minVolInput').value) || 0,
      time: Date.now(), funding: state.funding, results: state.results,
    }));
  } catch (e) { console.warn('缓存写入失败（结果过大？）', e); }
}

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return false;
    const c = JSON.parse(raw);
    if (!c.results || !c.results.length) return false;
    state.market = c.market || 'futures';
    state.interval = c.interval || '1h';
    state.results = c.results;
    state.funding = c.funding || {};
    $('marketSelect').value = state.market;
    $('intervalSelect').value = state.interval;
    if (c.minVol) $('minVolInput').value = c.minVol;
    $('heatPanel').style.display = state.market === 'futures' ? '' : 'none';
    const t = new Date(c.time);
    $('scanStatus').innerHTML = `📦 已恢复上次扫描缓存（${t.toLocaleString()}），后台自动更新中…`;
    renderBreadth();
    renderOpportunities();
    renderTable();
    if (state.market === 'futures' && Object.keys(state.funding).length) renderHeatmap();
    return true;
  } catch (e) { return false; }
}

async function init() {
  setNet('加载币种列表…', 'connecting');
  try {
    state.symbols = await loadAllSymbols(state.market);
    state.tickers = await loadTickers(state.market);
    setNet(`就绪 · ${state.symbols.length} 个交易对`, 'connected');
    $('scanStatus').textContent = `${state.symbols.length} 个交易对待扫描`;
  } catch (e) {
    setNet('初始化失败: ' + e.message, '');
  }

  $('scanBtn').addEventListener('click', scanMarket);
  $('autoScan').addEventListener('change', e => {
    clearInterval(state.autoTimer);
    if (e.target.checked) state.autoTimer = setInterval(scanMarket, 300000);
  });
  $('marketSelect').addEventListener('change', async e => {
    state.market = e.target.value;
    state.results = [];
    setNet('加载币种列表…', 'connecting');
    try {
      state.symbols = await loadAllSymbols(state.market);
      state.tickers = await loadTickers(state.market);
      setNet(`就绪 · ${state.symbols.length} 个交易对`, 'connected');
    } catch (e2) { setNet('加载失败', ''); }
    $('heatPanel').style.display = state.market === 'futures' ? '' : 'none';
    if (state.market === 'futures') {
      try { state.funding = await fetchAllPremiumIndex(); renderHeatmap(); } catch (e3) {}
    }
  });
  $('intervalSelect').addEventListener('change', e => { state.interval = e.target.value; });
  $('signalFilter').addEventListener('change', renderTable);

  document.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const k = th.dataset.key;
      if (state.sortKey === k) state.sortDir *= -1;
      else { state.sortKey = k; state.sortDir = -1; }
      renderTable();
    });
  });

  // 先恢复上次扫描缓存（页面秒开），再后台自动刷新
  loadCache();

  // 自动开始首次扫描
  if (state.symbols.length) scanMarket();
}

// ---------------- 扫描 ----------------
async function scanMarket() {
  if (state.scanning) return;
  state.scanning = true;
  $('scanBtn').disabled = true;
  $('scanBtn').textContent = '⏳ 扫描中…';
  $('scanProgressWrap').style.display = 'block';

  // 刷新 ticker + 资金费率
  try { state.tickers = await loadTickers(state.market); } catch (e) {}
  if (state.market === 'futures') {
    try {
      state.funding = await fetchAllPremiumIndex();
      renderHeatmap();
    } catch (e) {
      $('heatPanel').style.display = '';
      $('heatGrid').innerHTML = '<div class="placeholder" style="grid-column:1/-1;">当前网络无法访问币安合约接口，资金费率热力图暂不可用（K线分析不受影响）</div>';
    }
  } else {
    $('heatPanel').style.display = 'none';
  }

  const minVol = parseFloat($('minVolInput').value) || 0;
  const symbols = state.symbols.filter(s => (state.tickers[s]?.quoteVolume ?? Infinity) >= minVol);
  const total = symbols.length;
  let done = 0, idx = 0;
  const results = [];
  const CONCURRENCY = 8;

  async function worker() {
    while (idx < total) {
      const sym = symbols[idx++];
      try {
        const candles = await fetchKlines(sym, state.interval, 120, state.market);
        if (candles.length >= 60) {
          const f = computeFactors(candles, null);
          if (f) {
            const pos = computePosition(f.composite, candles, state.interval);
            const tk = state.tickers[sym] || {};
            results.push({
              symbol: sym,
              price: candles[candles.length - 1].close,
              change24h: tk.change24h ?? null,
              quoteVolume: tk.quoteVolume ?? 0,
              score: f.composite,
              rsi: f.rawIndicators.rsi,
              adx: f.rawIndicators.adx,
              squeeze: f.rawIndicators.squeeze,
              volRatio: f.rawIndicators.volRatio,
              annVol: pos.annualizedVol,
              atr: f.rawIndicators.atr,
              position: pos.size,
              direction: pos.direction,
              regime: detectRegime(f.rawIndicators),
            });
          }
        }
      } catch (e) { /* 单个失败不影响整体 */ }
      done++;
      if (done % 10 === 0 || done === total) {
        $('scanProgress').style.width = Math.round(done / total * 100) + '%';
        $('scanStatus').textContent = `扫描 ${done}/${total}`;
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  state.results = results;
  state.scanning = false;
  $('scanBtn').disabled = false;
  $('scanBtn').textContent = '🔍 开始扫描';
  $('scanProgressWrap').style.display = 'none';
  $('scanStatus').textContent = `完成 · ${results.length} 个币种 · ${new Date().toLocaleTimeString()}`;
  setNet('扫描完成', 'connected');

  renderBreadth();
  renderOpportunities();
  renderTable();
  saveCache(); // 持久化，刷新页面不丢失
}

// ---------------- 市场宽度 ----------------
function renderBreadth() {
  const r = state.results;
  if (!r.length) return;
  const up = r.filter(x => x.score >= 0.15).length;
  const down = r.filter(x => x.score <= -0.15).length;
  const flat = r.length - up - down;
  const pc = x => (x / r.length * 100).toFixed(1);
  $('breadthBar').innerHTML = `
    <div class="b-up" style="width:${pc(up)}%">${up > 4 ? up + ' 多' : ''}</div>
    <div class="b-flat" style="width:${pc(flat)}%">${flat > 4 ? flat + ' 观望' : ''}</div>
    <div class="b-down" style="width:${pc(down)}%">${down > 4 ? down + ' 空' : ''}</div>`;
  $('breadthSub').textContent = `${state.interval} 周期 · 共 ${r.length} 个币种`;

  const avgScore = Stats.mean(r.map(x => x.score));
  const gainers = r.filter(x => (x.change24h ?? 0) > 0).length;
  const cells = [
    { k: '市场平均评分', v: fmtNum(avgScore, 3), cls: avgScore > 0.05 ? 'good' : avgScore < -0.05 ? 'bad' : '' },
    { k: '24h上涨家数占比', v: fmtPct(gainers / r.length, 1, false) },
    { k: '强多信号', v: r.filter(x => x.score >= 0.35).length, cls: 'good' },
    { k: '强空信号', v: r.filter(x => x.score <= -0.35).length, cls: 'bad' },
    { k: '挤压蓄势 (BBW<0.6均值)', v: r.filter(x => x.squeeze < 0.6).length },
    { k: '放量 (量>1.5×均量)', v: r.filter(x => x.volRatio > 1.5).length },
  ];
  $('marketStats').innerHTML = cells.map(c => `<div class="metric ${c.cls || ''}"><div class="k">${c.k}</div><div class="v">${c.v}</div></div>`).join('');
}

// ---------------- 资金费率热力图 ----------------
function fundingColor(fr) {
  // fr 为小数，±0.0005 = ±0.05%
  if (fr == null) return 'background:#1b212b;color:#5e6773;';
  if (fr >= 0.001) return 'background:rgba(246,70,93,0.95);color:#fff;';
  if (fr >= 0.0005) return 'background:rgba(246,70,93,0.75);color:#fff;';
  if (fr >= 0.0001) return 'background:rgba(246,70,93,0.35);color:#ffb3bd;';
  if (fr <= -0.001) return 'background:rgba(33,150,243,0.95);color:#fff;';
  if (fr <= -0.0005) return 'background:rgba(33,150,243,0.7);color:#fff;';
  if (fr <= -0.0001) return 'background:rgba(33,150,243,0.3);color:#a8cfff;';
  return 'background:#242c38;color:#848e9c;';
}

function renderHeatmap() {
  $('heatPanel').style.display = '';
  const entries = Object.keys(state.funding)
    .filter(s => state.tickers[s] && state.tickers[s].quoteVolume > 0)
    .sort((a, b) => state.tickers[b].quoteVolume - state.tickers[a].quoteVolume)
    .slice(0, 60);
  if (!entries.length) { $('heatGrid').innerHTML = '<div class="placeholder">资金费率数据不可用</div>'; return; }
  $('heatGrid').innerHTML = entries.map(sym => {
    const f = state.funding[sym];
    return `<div class="heat-cell" style="${fundingColor(f.fundingRate)}" data-sym="${sym}" title="${sym} · 资金费率 ${fmtPct(f.fundingRate, 4)}">
      <div class="hs">${sym.replace('USDT', '')}</div>
      <div class="hv">${fmtPct(f.fundingRate, 3, false)}</div>
    </div>`;
  }).join('');
  $('heatGrid').querySelectorAll('.heat-cell').forEach(cell => {
    cell.addEventListener('click', () => goDashboard(cell.dataset.sym, state.market, state.interval));
  });
  $('heatSub').textContent = `按 24h 成交额 Top ${entries.length} · 红 = 多头付费（拥挤看多，警惕回撤） · 蓝 = 空头付费（拥挤看空，警惕反弹）`;
}

// ---------------- 机会发现 ----------------
function renderOpportunities() {
  const r = state.results;
  if (!r.length) return;
  const sections = [];

  // 为机会卡生成迷你交易计划（使用扫描时计算的真实 ATR）
  const miniPlan = x => {
    const plan = buildTradePlan(x.price, x.atr, x.annVol, x.score);
    if (!plan || Math.abs(x.score) < 0.15) return '';
    return `<div class="plan-footer" style="margin-top:8px;padding-top:8px;">
      <div class="cell-mini"><div class="k">止损</div><div class="v down" style="font-size:11px;">${fmtPrice(plan.stopLoss)}</div></div>
      <div class="cell-mini"><div class="k">止盈二</div><div class="v up" style="font-size:11px;">${fmtPrice(plan.tp2)}</div></div>
      <div class="cell-mini"><div class="k">杠杆·保证金</div><div class="v" style="font-size:11px;color:var(--accent);">${plan.leverage}x · ${plan.marginPct.toFixed(0)}%</div></div>
    </div>`;
  };

  const mk = (title, list, cls, reasonFn, withPlan) => {
    if (!list.length) return;
    sections.push(`
      <div style="margin-bottom:16px;">
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px;">${title}</div>
        <div class="opp-grid">
          ${list.map(x => `
            <div class="opp-card ${cls}" data-sym="${x.symbol}">
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <span class="sym">${x.symbol.replace('USDT', '')}<span style="color:var(--text-dim);font-size:10px;">/USDT</span></span>
                <span class="${clsBySign(x.score)}" style="font-weight:700;">${fmtNum(x.score, 2)}</span>
              </div>
              <div class="meta">${fmtPrice(x.price)} · 24h ${x.change24h != null ? fmtPct100(x.change24h) : '—'} · 额 ${fmtVol(x.quoteVolume)}</div>
              <div class="reason">${reasonFn(x)}</div>
              ${withPlan ? miniPlan(x) : ''}
            </div>`).join('')}
        </div>
      </div>`);
  };

  mk('🟢 做多机会（评分最高）', [...r].sort((a, b) => b.score - a.score).slice(0, 4), '',
    x => `RSI ${fmtNum(x.rsi, 0)} · ADX ${fmtNum(x.adx, 0)} · ${x.regime.label} · 建议仓位 ${fmtPct(x.position, 0, false)}`, true);
  mk('🔴 做空机会（评分最低）', [...r].sort((a, b) => a.score - b.score).slice(0, 4), 'sell',
    x => `RSI ${fmtNum(x.rsi, 0)} · ADX ${fmtNum(x.adx, 0)} · ${x.regime.label} · 建议仓位 ${fmtPct(x.position, 0, false)}`, true);
  mk('🟡 挤压蓄势（波动率收缩，等待突破）', r.filter(x => x.squeeze < 0.6).sort((a, b) => b.quoteVolume - a.quoteVolume).slice(0, 4), 'squeeze',
    x => `BBW 收缩至均值 ${fmtPct(x.squeeze, 0, false)} · 24h额 ${fmtVol(x.quoteVolume)}`);
  mk('🔵 放量异动（量能 > 2.5 倍）', r.filter(x => x.volRatio > 2.5).sort((a, b) => b.volRatio - a.volRatio).slice(0, 4), 'accum',
    x => `量比 ${fmtNum(x.volRatio, 1)}× · 24h ${x.change24h != null ? fmtPct100(x.change24h) : '—'}`);

  $('oppContent').innerHTML = sections.join('') || '<div class="placeholder">未发现明显机会</div>';
  $('oppContent').querySelectorAll('.opp-card').forEach(card => {
    card.addEventListener('click', () => goDashboard(card.dataset.sym, state.market, state.interval));
  });
}

// ---------------- 结果表 ----------------
function renderTable() {
  let list = [...state.results];
  const filter = $('signalFilter').value;
  if (filter === 'long') list = list.filter(x => x.score >= 0.15);
  else if (filter === 'short') list = list.filter(x => x.score <= -0.15);
  else if (filter === 'strong') list = list.filter(x => Math.abs(x.score) >= 0.35);

  const { sortKey, sortDir } = state;
  list.sort((a, b) => {
    const va = a[sortKey], vb = b[sortKey];
    if (typeof va === 'string') return va.localeCompare(vb) * sortDir;
    return ((va ?? -Infinity) - (vb ?? -Infinity)) * sortDir;
  });

  $('resultCount').textContent = `${list.length} 个币种 · 点击行查看深度分析`;
  $('screenerBody').innerHTML = list.map(x => {
    const sig = signalOf(x.score);
    return `<tr data-sym="${x.symbol}">
      <td><b>${x.symbol.replace('USDT', '')}</b><span style="color:var(--text-dim);font-size:10px;">/USDT</span></td>
      <td>${fmtPrice(x.price)}</td>
      <td class="${clsBySign(x.change24h)}">${x.change24h != null ? fmtPct100(x.change24h) : '—'}</td>
      <td>${fmtVol(x.quoteVolume)}</td>
      <td class="${clsBySign(x.score)}" style="font-weight:700">${fmtNum(x.score, 3)}</td>
      <td class="${x.rsi > 70 ? 'down' : x.rsi < 30 ? 'up' : ''}">${fmtNum(x.rsi, 1)}</td>
      <td>${fmtNum(x.adx, 1)}</td>
      <td>${fmtPct(x.annVol, 0, false)}</td>
      <td>${x.position > 0 ? fmtPct(x.position, 0, false) : '—'}</td>
      <td><span class="chip ${x.regime.cls}">${x.regime.label}</span></td>
      <td><span class="chip ${sig.dir > 0 ? 'long' : sig.dir < 0 ? 'short' : 'flat'}">${sig.label}</span></td>
    </tr>`;
  }).join('') || '<tr><td colspan="11" class="placeholder">无匹配结果</td></tr>';

  $('screenerBody').querySelectorAll('tr[data-sym]').forEach(tr => {
    tr.addEventListener('click', () => goDashboard(tr.dataset.sym, state.market, state.interval));
  });
}

init();
