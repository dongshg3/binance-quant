// ============================================================
// screener.js · 全市场扫描（全部 USDT 永续 / 现货）
// ============================================================
import { Stats } from './lib/stats.js';
import { loadAllSymbols, loadTickers, fetchKlines, fetchAllPremiumIndex } from './lib/api.js';
import { computeFactors, computePosition, detectRegime, signalOf, buildTradePlan, weightSourceInfo } from './lib/quant.js';
import { renderNav, setNet, fmtPrice, fmtPct100, fmtPct, fmtNum, fmtVol, clsBySign, goDashboard, disclaimerHTML, icon, swapHTML } from './lib/ui.js';
import { loadModel, getModel } from './lib/model.js';
import { logSignal, labelOutcomes } from './lib/tracker.js';
import { getNewsSnapshot, newsFactorFor } from './lib/news.js';

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
    $('scanStatus').innerHTML = `${icon('package')} 已恢复上次扫描缓存（${t.toLocaleString()}），后台自动更新中…`;
    renderBreadth();
    renderOpportunities();
    renderTable();
    if (state.market === 'futures' && Object.keys(state.funding).length) renderHeatmap();
    return true;
  } catch (e) { return false; }
}

async function init() {
  setNet('加载币种列表…', 'connecting');
  await loadModel(); // 扫描前先拿到云端学习权重（失败则自动回退静态权重）
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
  $('scanBtn').innerHTML = icon('loader', 'spin') + '扫描中…';
  $('scanProgressWrap').style.display = 'block';

  // 刷新 ticker + 资金费率 + 消息面快照
  try { state.tickers = await loadTickers(state.market); } catch (e) {}
  try { state.newsSnap = await getNewsSnapshot(); } catch (e) { state.newsSnap = null; }
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
          // 合约市场把资金费率喂给因子引擎（futures 因子组参与学习权重，不传则评分系统性缺失一组信号）
          const extra = {};
          if (state.market === 'futures' && state.funding[sym]) extra.fundingRate = state.funding[sym].fundingRate;
          // 消息面因子（云端每小时快照：FGI + 该币新闻情绪/热度，静态权重 0.05 参与评分）
          const nf = newsFactorFor(state.newsSnap, sym);
          if (nf) extra.news = nf;
          const extraArg = Object.keys(extra).length ? extra : null;
          const f = computeFactors(candles, extraArg, sym);
          if (f) {
            const pos = computePosition(f.composite, candles, state.interval);
            const tk = state.tickers[sym] || {};
            const edge = weightSourceInfo(sym);
            // 多空信号（|评分|≥0.15）写入追踪器，后续自动回填实际走势
            if (Math.abs(f.composite) >= 0.15) {
              logSignal({
                time: Date.now(), symbol: sym, interval: state.interval, market: state.market,
                price: candles[candles.length - 1].close, composite: f.composite, fused: null,
                direction: Math.sign(f.composite), weightSource: f.weightSource,
                groupAverages: f.groupAverages, regime: detectRegime(f.rawIndicators).label,
                origin: 'screener',
              });
            }
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
              funding: extra.fundingRate ?? null,
              edgeKind: edge.kind, edgeKey: edge.key, edgeFlipped: edge.flipped, edgeIC: edge.ic,
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

  // 横截面标定：模型训练目标是截面排序（XS IC），相对排名比绝对分更贴近模型本义
  // 为每个币种计算 z 分数与百分位（ signed：做多看高分端，做空看低分端）
  if (results.length > 5) {
    const sorted = results.map(x => x.score).slice().sort((a, b) => a - b);
    const mu = Stats.mean(sorted);
    const sd = Math.sqrt(Stats.mean(sorted.map(s => (s - mu) * (s - mu)))) || 1e-9;
    for (const x of results) {
      x.xsZ = (x.score - mu) / sd;
      let lo = 0, hi = sorted.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < x.score) lo = mid + 1; else hi = mid; }
      x.xsPct = lo / (sorted.length - 1);
    }
  }

  state.results = results;
  state.scanning = false;
  $('scanBtn').disabled = false;
  $('scanBtn').innerHTML = icon('search') + '开始扫描';
  $('scanProgressWrap').style.display = 'none';
  $('scanStatus').textContent = `完成 · ${results.length} 个币种 · ${new Date().toLocaleTimeString()}`;
  setNet('扫描完成', 'connected');

  renderBreadth();
  renderOpportunities();
  renderTable();
  saveCache(); // 持久化，刷新页面不丢失
  labelOutcomes(fetchKlines); // 回填到期信号的实际走势（静默）
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
  // 评分分布监测：|score| 的分位数，用于对照固定阈值 0.15/0.35/0.5 在当前市场的实际含义
  // scoreScale 已把评分锚定到训练期横截面标准差（0.13），阈值本义是 σ 单位（0.15≈1.2σ）
  // 但市场离散度随状态漂移，分位数让「阈值是否过松/过紧」可观测
  const absSorted = r.map(x => Math.abs(x.score)).sort((a, b) => a - b);
  const q = p => absSorted[Math.min(absSorted.length - 1, Math.floor(p * absSorted.length))];
  const cells = [
    { k: '市场平均评分', v: fmtNum(avgScore, 3), cls: avgScore > 0.05 ? 'good' : avgScore < -0.05 ? 'bad' : '' },
    { k: '24h上涨家数占比', v: fmtPct(gainers / r.length, 1, false) },
    { k: '强多信号', v: r.filter(x => x.score >= 0.35).length, cls: 'good' },
    { k: '强空信号', v: r.filter(x => x.score <= -0.35).length, cls: 'bad' },
    { k: '|评分| P90 / P99', v: `${fmtNum(q(0.9), 3)} / ${fmtNum(q(0.99), 3)}`, cls: q(0.9) > 0.15 ? '' : 'bad' },
    { k: '挤压蓄势 (BBW<0.6均值)', v: r.filter(x => x.squeeze < 0.6).length },
    { k: '放量 (量>1.5×均量)', v: r.filter(x => x.volRatio > 1.5).length },
  ];
  $('marketStats').innerHTML = cells.map(c => `<div class="metric ${c.cls || ''}"><div class="k">${c.k}</div><div class="v">${c.v}</div></div>`).join('');
}

// ---------------- 资金费率热力图 ----------------
function fundingColor(fr) {
  // fr 为小数，±0.0005 = ±0.05%
  if (fr == null) return 'background:#f2f4f8;color:#9aa3af;';
  if (fr >= 0.001) return 'background:rgba(220,38,38,0.92);color:#fff;';
  if (fr >= 0.0005) return 'background:rgba(220,38,38,0.68);color:#fff;';
  if (fr >= 0.0001) return 'background:rgba(220,38,38,0.14);color:#dc2626;';
  if (fr <= -0.001) return 'background:rgba(37,99,235,0.92);color:#fff;';
  if (fr <= -0.0005) return 'background:rgba(37,99,235,0.62);color:#fff;';
  if (fr <= -0.0001) return 'background:rgba(37,99,235,0.13);color:#2563eb;';
  return 'background:#eef1f6;color:#5b6472;';
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

// ---------------- 机会分级与质量分 ----------------
function tierOf(score) {
  const a = Math.abs(score);
  if (a >= 0.5) return { key: 'S', label: '极强', cls: 'tS' };
  if (a >= 0.35) return { key: 'A', label: '强烈', cls: 'tA' };
  if (a >= 0.15) return { key: 'B', label: '普通', cls: 'tB' };
  return { key: 'C', label: '弱', cls: 'tC' };
}
// 机会质量分 = 信号强度 60% + 趋势强度(ADX) 25% + 量能参与 15%
// 比裸评分排序更抗噪音：高分但无趋势/无量能配合的信号会被降权
function qualityOf(x) {
  return Math.abs(x.score) * 0.6 + Math.min((x.adx || 0) / 50, 1) * 0.25 + Math.min((x.volRatio || 0) / 3, 1) * 0.15;
}
// 机会排序分 = 质量分 × 模型优势加成
// 该币种生效权重来源的样本外 IC 越高，其信号的历史兑现能力越强，最多加成 2 倍
// 无 IC 信息（旧缓存/静态权重）按全局 IC 0.02 中性处理（加成 1.2）
function oppRank(x) {
  const ic = x.edgeIC != null ? Math.min(Math.max(x.edgeIC, 0), 0.1) : 0.02;
  return qualityOf(x) * (1 + ic / 0.1);
}
// 权重来源的中文标签
const EDGE_KEY_CN = { major: '主流', l1: 'L1', l2: 'L2', defi: 'DeFi', meme: 'Meme', ai: 'AI', gaming: '游戏', infra: '基建', other: '其他', large: '大盘', mid: '中盘', small: '小盘' };
function edgeLabel(x) {
  if (!x.edgeKind) return '—';
  if (x.edgeKind === 'coin') return '逐币模型';
  if (x.edgeKind === 'global') return '全局模型';
  if (x.edgeKind === 'static') return '静态权重';
  return `${EDGE_KEY_CN[x.edgeKey] || x.edgeKey}${x.edgeKind === 'cat' ? '板块' : ''}${x.edgeFlipped ? '·反向' : ''}`;
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
          ${list.map(x => {
            const t = tierOf(x.score);
            const dirCls = x.score < 0 ? 'sell' : 'buy';
            const pctTxt = x.xsPct != null ? `超过 ${(Math.abs(x.xsPct - (x.score < 0 ? 1 : 0)) * 100).toFixed(0)}% 币种` : '';
            const edgeTxt = x.edgeIC != null ? `${edgeLabel(x)} · IC ${x.edgeIC.toFixed(3)}` : edgeLabel(x);
            return `
            <div class="opp-card ${cls} tier-${t.cls}" data-sym="${x.symbol}">
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <span class="sym">${x.symbol.replace('USDT', '')}<span style="color:var(--text-dim);font-size:10px;">/USDT</span></span>
                <span class="tier-badge ${t.cls}-${dirCls}">${t.key} · ${t.label}</span>
              </div>
              <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;">
                <span class="${clsBySign(x.score)}" style="font-weight:700;font-size:16px;">${fmtNum(x.score, 2)}</span>
                <span style="font-size:10px;color:var(--text-faint);">质量分 ${(qualityOf(x) * 100).toFixed(0)}${pctTxt ? ' · ' + pctTxt : ''}</span>
              </div>
              <div class="meta">${fmtPrice(x.price)} · 24h ${x.change24h != null ? fmtPct100(x.change24h) : '—'} · 额 ${fmtVol(x.quoteVolume)}${x.funding != null ? ` · 费率 ${fmtPct(x.funding, 3, false)}` : ''}</div>
              <div class="reason">${reasonFn(x)}</div>
              <div style="font-size:10px;margin-top:4px;"><span class="chip trend" style="padding:1px 6px;">${edgeTxt}</span></div>
              ${withPlan ? miniPlan(x) : ''}
            </div>`;
          }).join('')}
        </div>
      </div>`);
  };

  mk(`${icon('trendUp')} 做多机会（|评分| ≥ 0.15，按 质量×模型优势 排序）`, r.filter(x => x.score >= 0.15).sort((a, b) => oppRank(b) - oppRank(a)).slice(0, 4), '',
    x => `RSI ${fmtNum(x.rsi, 0)} · ADX ${fmtNum(x.adx, 0)} · ${x.regime.label} · 建议仓位 ${fmtPct(x.position, 0, false)}`, true);
  mk(`${icon('trendDown')} 做空机会（|评分| ≥ 0.15，按 质量×模型优势 排序）`, r.filter(x => x.score <= -0.15).sort((a, b) => oppRank(b) - oppRank(a)).slice(0, 4), 'sell',
    x => `RSI ${fmtNum(x.rsi, 0)} · ADX ${fmtNum(x.adx, 0)} · ${x.regime.label} · 建议仓位 ${fmtPct(x.position, 0, false)}`, true);
  mk(`${icon('zap')} 挤压蓄势（波动率收缩 等待突破）`, r.filter(x => x.squeeze < 0.6).sort((a, b) => b.quoteVolume - a.quoteVolume).slice(0, 4), 'squeeze',
    x => `BBW 收缩至均值 ${fmtPct(x.squeeze, 0, false)} · 24h额 ${fmtVol(x.quoteVolume)}`);
  mk(`${icon('activity')} 放量异动（量能 > 2.5 倍）`, r.filter(x => x.volRatio > 2.5).sort((a, b) => b.volRatio - a.volRatio).slice(0, 4), 'accum',
    x => `量比 ${fmtNum(x.volRatio, 1)}× · 24h ${x.change24h != null ? fmtPct100(x.change24h) : '—'}`);

  // 横截面相对强度榜：模型的训练目标是截面排序（XS IC），绝对分未达阈值时相对排名仍含信息
  // 明确标注「相对」——震荡市里全市场绝对分都低时，这是排序意义上的最强/最弱，不等于可交易信号
  const withPct = r.filter(x => x.xsPct != null);
  if (withPct.length > 10) {
    mk(`${icon('chartLine')} 相对强度榜 · 多头侧（横截面排名前 4，非绝对信号）`,
      withPct.slice().sort((a, b) => b.xsPct - a.xsPct).slice(0, 4), '',
      x => `横截面分位 ${(x.xsPct * 100).toFixed(0)}% · z=${fmtNum(x.xsZ, 2)} · ${x.regime.label} · 评分未达 0.15 阈值时仅作排序参考`);
    mk(`${icon('chartLine')} 相对强度榜 · 空头侧（横截面排名末 4，非绝对信号）`,
      withPct.slice().sort((a, b) => a.xsPct - b.xsPct).slice(0, 4), 'sell',
      x => `横截面分位 ${(x.xsPct * 100).toFixed(0)}% · z=${fmtNum(x.xsZ, 2)} · ${x.regime.label} · 评分未达 -0.15 阈值时仅作排序参考`);
  }

  swapHTML($('oppContent'), sections.join('') || '<div class="placeholder">未发现明显机会</div>');
  setTimeout(() => {
    $('oppContent').querySelectorAll('.opp-card').forEach(card => {
      card.addEventListener('click', () => goDashboard(card.dataset.sym, state.market, state.interval));
    });
  }, 160);
}

// ---------------- 结果表 ----------------
function renderTable() {
  let list = [...state.results];
  const filter = $('signalFilter').value;
  if (filter === 'long') list = list.filter(x => x.score >= 0.15);
  else if (filter === 'short') list = list.filter(x => x.score <= -0.15);
  else if (filter === 'strong') list = list.filter(x => Math.abs(x.score) >= 0.35);
  else if (filter === 'edge') list = list.filter(x => (x.edgeIC ?? 0) >= 0.03);
  else if (filter === 'coin') list = list.filter(x => x.edgeKind === 'coin');

  const { sortKey, sortDir } = state;
  list.sort((a, b) => {
    const va = a[sortKey], vb = b[sortKey];
    if (typeof va === 'string') return va.localeCompare(vb) * sortDir;
    return ((va ?? -Infinity) - (vb ?? -Infinity)) * sortDir;
  });

  $('resultCount').textContent = `${list.length} 个币种 · 点击行查看深度分析`;
  const CAT_CN = { major: '主流', l1: 'L1', l2: 'L2', defi: 'DeFi', meme: 'Meme', ai: 'AI', gaming: '游戏', infra: '基建', other: '其他' };
  const SIZE_CN = { large: '大盘', mid: '中盘', small: '小盘' };
  const meta = (getModel() && getModel().symbolMeta) || {};
  $('screenerBody').innerHTML = list.map(x => {
    const sig = signalOf(x.score);
    const t = tierOf(x.score);
    const rowCls = t.cls === 'tS' || t.cls === 'tA' ? (x.score > 0 ? 'row-tA-buy' : 'row-tA-sell')
      : t.cls === 'tB' ? (x.score > 0 ? 'row-tB-buy' : 'row-tB-sell') : '';
    const sm = meta[x.symbol];
    const segChip = sm ? ` <span class="chip flat" style="padding:0 5px;font-size:9px;" title="${SIZE_CN[sm.size]} · ${CAT_CN[sm.cat]}分段模型">${CAT_CN[sm.cat]}</span>` : '';
    return `<tr data-sym="${x.symbol}" class="${rowCls}">
      <td><b>${x.symbol.replace('USDT', '')}</b><span style="color:var(--text-dim);font-size:10px;">/USDT</span>${segChip}</td>
      <td>${fmtPrice(x.price)}</td>
      <td class="${clsBySign(x.change24h)}">${x.change24h != null ? fmtPct100(x.change24h) : '—'}</td>
      <td>${fmtVol(x.quoteVolume)}</td>
      <td><span class="score-chip ${t.cls}-${x.score > 0 ? 'buy' : 'sell'}">${fmtNum(x.score, 3)}${t.key !== 'C' ? ' ' + t.key : ''}</span></td>
      <td>${x.edgeKind ? `<span class="chip ${x.edgeKind === 'coin' ? 'long' : x.edgeFlipped ? 'trend' : 'flat'}" style="padding:1px 6px;font-size:9px;" title="该币种评分使用的权重来源及其样本外 IC">${edgeLabel(x)}${x.edgeIC != null ? ` ${x.edgeIC.toFixed(3)}` : ''}</span>` : '<span style="color:var(--text-faint)">—</span>'}</td>
      <td class="${x.rsi > 70 ? 'down' : x.rsi < 30 ? 'up' : ''}">${fmtNum(x.rsi, 1)}</td>
      <td>${fmtNum(x.adx, 1)}</td>
      <td>${fmtPct(x.annVol, 0, false)}</td>
      <td>${x.position > 0 ? fmtPct(x.position, 0, false) : '—'}</td>
      <td><span class="chip ${x.regime.cls}">${x.regime.label}</span></td>
      <td><span class="chip ${sig.dir > 0 ? 'long' : sig.dir < 0 ? 'short' : 'flat'}">${sig.label}</span></td>
    </tr>`;
  }).join('') || '<tr><td colspan="12" class="placeholder">无匹配结果</td></tr>';

  $('screenerBody').querySelectorAll('tr[data-sym]').forEach(tr => {
    tr.addEventListener('click', () => goDashboard(tr.dataset.sym, state.market, state.interval));
  });
}

init();
