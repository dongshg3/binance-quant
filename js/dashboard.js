// ============================================================
// dashboard.js · 单币种深度分析 + 预测
// ============================================================
import { Stats, EMA } from './lib/stats.js';
import { loadAllSymbols, loadTickers, fetchKlines, fetchFundingRate, fetchFundingHistory, fetchLongShortRatio, fetchOpenInterestChange, fetchTakerRatio, connectKlineWS, pollKlines, getDataMode } from './lib/api.js';
import { computeFactors, computePosition, detectRegime, signalOf, monteCarloCone, conditionalStats, pointForecast, regChannel, riskLevels, buildTradePlan, extremeGroups, fuseMTF, signalConfidence, garchVolForecast, btcLinkage, GROUP_NAMES } from './lib/quant.js';
import { renderNav, setNet, fmtPrice, fmtPct, fmtPct100, fmtNum, fmtVol, clsBySign, getParams, buildSymbolPicker, disclaimerHTML, icon, pop } from './lib/ui.js';
import { loadModel, modelBadgeHTML } from './lib/model.js';
import { logSignal, labelOutcomes } from './lib/tracker.js';
import { newsFactorFor, getNewsSnapshot } from './lib/news.js';

renderNav('dashboard');
document.getElementById('disclaimerSlot').innerHTML = disclaimerHTML();

const params = getParams();
const state = {
  market: params.market || 'futures',
  symbol: (params.symbol || 'BTCUSDT').toUpperCase(),
  interval: params.interval || '1h',
  candles: [],
  allSymbols: [],
  tickers: {},
  ws: null,
  chart: null, candleSeries: null, ema9S: null, ema21S: null, volS: null, fcstS: null,
  coneChart: null,
};

const $ = id => document.getElementById(id);
const INTERVALS = ['15m', '1h', '4h', '1d'];

// ---------------- 初始化 ----------------
async function init() {
  $('marketSelect').value = state.market;
  $('intervalSelect').value = state.interval;
  initChart();
  loadModel().then(() => { const b = $('modelBadge'); if (b) b.innerHTML = modelBadgeHTML(); });

  try {
    setNet('加载币种列表…', 'connecting');
    state.allSymbols = await loadAllSymbols(state.market);
  } catch (e) {
    setNet('币种列表加载失败: ' + e.message, '');
    state.allSymbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'];
  }
  if (!state.allSymbols.includes(state.symbol)) state.symbol = 'BTCUSDT';

  buildSymbolPicker($('symbolPickerWrap'), state.allSymbols, state.symbol, sym => { state.symbol = sym; reload(); });
  try { state.tickers = await loadTickers(state.market); } catch (e) {}

  $('marketSelect').addEventListener('change', async e => {
    state.market = e.target.value;
    state.allSymbols = await loadAllSymbols(state.market).catch(() => state.allSymbols);
    if (!state.allSymbols.includes(state.symbol)) state.symbol = 'BTCUSDT';
    buildSymbolPicker($('symbolPickerWrap'), state.allSymbols, state.symbol, sym => { state.symbol = sym; reload(); });
    try { state.tickers = await loadTickers(state.market); } catch (e2) {}
    reload();
  });
  $('intervalSelect').addEventListener('change', e => { state.interval = e.target.value; reload(); });
  $('refreshBtn').addEventListener('click', reload);

  await reload();
}

// ---------------- 主流程 ----------------
async function reload() {
  setNet('拉取K线…', 'connecting');
  if (state.ws) { state.ws.close(); state.ws = null; }
  if (state.poller) { state.poller.stop(); state.poller = null; }

  try {
    state.candles = await fetchKlines(state.symbol, state.interval, 400, state.market);
  } catch (e) {
    setNet('K线加载失败: ' + e.message + (state.market === 'futures' ? '（当前网络无法访问币安合约 API，部分地区需代理；可切换「现货」模式，已内置镜像自动降级）' : ''), '');
    return;
  }

  // 合约扩展数据（并行、容错）
  const extra = {};
  if (state.market === 'futures') {
    const [fr, ls, oi, tk, fh] = await Promise.allSettled([
      fetchFundingRate(state.symbol),
      fetchLongShortRatio(state.symbol),
      fetchOpenInterestChange(state.symbol),
      fetchTakerRatio(state.symbol),
      fetchFundingHistory(state.symbol),
    ]);
    if (fr.status === 'fulfilled') extra.fundingRate = fr.value;
    if (ls.status === 'fulfilled') extra.lsRatio = ls.value;
    if (oi.status === 'fulfilled') extra.oiChange = oi.value;
    if (tk.status === 'fulfilled') extra.takerRatio = tk.value;
    if (fh.status === 'fulfilled') extra.fundingHist = fh.value;
  }

  // 消息面因子（云端每小时快照，现货/合约通用；静默失败不影响主流程）
  let newsView = null;
  try {
    const snap = await getNewsSnapshot();
    const nf = newsFactorFor(snap, state.symbol);
    if (nf) extra.news = nf;
    if (snap) {
      const base = state.symbol.replace(/USDT$/, '');
      const coin = snap.coins && snap.coins[base];
      newsView = {
        updatedAt: snap.updatedAt,
        ageH: snap.updatedAt ? (Date.now() - new Date(snap.updatedAt).getTime()) / 36e5 : null,
        fgi: snap.fgi || null, globalSent: snap.globalSent ?? null, totalItems: snap.totalItems ?? 0,
        coinSent: coin?.sent ?? null, coinBuzz: coin?.buzz ?? 0, coinBuzzRel: coin?.buzzRel ?? 0,
        top: coin?.top || [],
      };
    }
  } catch (e) { /* 消息面不可用不影响主流程 */ }

  const factors = computeFactors(state.candles, extra, state.symbol);
  if (!factors) { setNet('数据不足', ''); return; }
  const pos = computePosition(factors.composite, state.candles, state.interval);

  // 先算多周期（融合评分与置信度的输入），并行 BTC 联动
  const [mtfRows, btcCandles] = await Promise.all([
    computeMTF(),
    state.symbol !== 'BTCUSDT' ? fetchKlines('BTCUSDT', state.interval, 150, state.market).catch(() => null) : Promise.resolve(null),
  ]);
  const fused = fuseMTF(mtfRows);
  const conf = signalConfidence(factors, mtfRows);
  state.btcLink = btcCandles ? btcLinkage(state.candles, btcCandles) : null;

  // 信号追踪：记录快照 + 回填到期信号的实际走势（静默、不阻塞渲染）
  const mainScoreNow = fused != null ? fused : factors.composite;
  logSignal({
    time: Date.now(), symbol: state.symbol, interval: state.interval, market: state.market,
    price: factors.rawIndicators.price, composite: factors.composite, fused,
    direction: Math.sign(mainScoreNow), weightSource: factors.weightSource,
    groupAverages: factors.groupAverages, regime: detectRegime(factors.rawIndicators).label,
  });
  labelOutcomes(fetchKlines);

  renderOverview(factors, pos, extra, fused, conf);
  renderFactors(factors);
  renderTradePlan(factors, pos, fused);
  renderRisk(factors, pos);
  renderFutures(extra);
  renderNews(newsView);
  renderForecast(factors, fused);
  renderCondStats(factors);
  renderChart(factors);
  renderMTFTable(mtfRows, fused);
  connectLive(extra);

  $('updateTime').textContent = '更新于 ' + new Date().toLocaleTimeString();
  setNet('已连接 · 实时更新中', 'connected');
}

// ---------------- 总览 ----------------
function renderOverview(factors, pos, extra, fused, conf) {
  const tk = state.tickers[state.symbol];
  const price = factors.rawIndicators.price;
  const mirror = state.market === 'futures' && getDataMode() === 'mirror';
  $('symLabel').innerHTML = state.symbol + ' · ' + state.interval + (state.market === 'futures' ? ' · 永续合约' : ' · 现货')
    + (mirror ? ' <span class="chip trend" style="margin-left:4px;">镜像数据模式</span>' : '');
  $('priceNow').textContent = fmtPrice(price);
  if (tk) {
    $('change24h').innerHTML = `<span class="${clsBySign(tk.change24h)}">${fmtPct100(tk.change24h)}</span> <span style="color:var(--text-dim)">24h额 ${fmtVol(tk.quoteVolume)}</span>`;
  }
  // 主信号用融合评分（多周期加权），更抗噪音
  const mainScore = fused != null ? fused : factors.composite;
  const sig = signalOf(mainScore);
  const badge = $('signalBadge');
  const prevSig = badge.textContent;
  badge.className = 'signal-badge ' + sig.cls;
  badge.textContent = sig.label;
  if (prevSig !== sig.label && prevSig !== '—') pop(badge);
  const confChip = conf ? ` · 置信度 <b style="color:${{ S: '#2563eb', A: '#16a34a', B: '#7c3aed', C: '#9aa3af' }[conf.grade]}">${conf.grade}</b>(${conf.score})` : '';
  $('scoreText').innerHTML = `融合分 ${fmtNum(mainScore, 3)} · 本周 ${fmtNum(factors.composite, 3)} · 仓位 ${fmtPct(pos.size, 0, false)}${pos.leverage ? ` · ≤${pos.leverage}x` : ''}${confChip}`;
  const regime = detectRegime(factors.rawIndicators);
  $('regimeChip').className = 'chip ' + regime.cls;
  $('regimeChip').textContent = regime.label;
  $('regimeHint').textContent = regime.hint;

  // 因子极值
  const { strongest, weakest } = extremeGroups(factors.groupAverages);
  if (strongest) $('strongestFactor').innerHTML = `<span class="up">${GROUP_NAMES[strongest.key]}</span> <span style="color:var(--text-dim)">${fmtNum(strongest.value, 2)}</span>`;
  if (weakest) $('weakestFactor').innerHTML = `<span class="down">${GROUP_NAMES[weakest.key]}</span> <span style="color:var(--text-dim)">${fmtNum(weakest.value, 2)}</span>`;

  // BTC 联动
  const link = state.btcLink;
  const el = $('btcLink');
  if (el) {
    if (state.symbol === 'BTCUSDT') {
      el.innerHTML = '<div style="font-size:12px;color:var(--text-dim);line-height:1.9;">当前即 BTC<br>市场基准本体</div>';
    } else if (link) {
      el.innerHTML = `<div style="font-size:12px;line-height:1.9;">
        <div>β <b>${fmtNum(link.beta, 2)}</b> <span style="color:var(--text-dim)">相关 ${fmtNum(link.corr, 2)}</span></div>
        <div>相对强度 <b class="${clsBySign(link.relStrength)}">${fmtPct(link.relStrength, 2)}</b></div>
      </div>`;
    } else {
      el.innerHTML = '<div style="font-size:12px;color:var(--text-dim);">—</div>';
    }
  }
}

// ---------------- 交易计划 ----------------
function renderTradePlan(factors, pos, fused) {
  const raw = factors.rawIndicators;
  const scoreForPlan = fused != null ? fused : factors.composite;
  const plan = buildTradePlan(raw.price, raw.atr, pos.annualizedVol, scoreForPlan);
  const el = $('tradePlan');
  if (!plan) {
    el.innerHTML = '<div class="placeholder">信号强度不足（|融合评分| < 0.08），暂不生成交易计划<br>观望也是一种仓位</div>';
    return;
  }
  // 蒙特卡洛触价概率：先碰到止盈二还是先碰到止损（24 bar 内）
  const mc = monteCarloCone(state.candles, scoreForPlan, 24, 3000, { tp: plan.tp2, stop: plan.stopLoss, isLong: plan.isLong });
  const touchRow = mc && mc.touch ? `
    <div class="plan-footer" style="border-top:1px solid var(--border);">
      <div class="cell-mini"><div class="k">先到止盈二</div><div class="v up">${fmtPct(mc.touch.tpFirst, 0, false)}</div></div>
      <div class="cell-mini"><div class="k">先到止损</div><div class="v down">${fmtPct(mc.touch.stopFirst, 0, false)}</div></div>
      <div class="cell-mini"><div class="k">都未触及</div><div class="v">${fmtPct(mc.touch.none, 0, false)}</div></div>
    </div>` : '';
  el.innerHTML = `
    <div class="plan-header ${plan.isLong ? '' : 'sell'}">
      <span class="dir ${plan.isLong ? 'up' : 'down'}">${icon(plan.isLong ? 'trendUp' : 'trendDown')}${plan.direction} ${state.symbol.replace('USDT', '')}</span>
      <span>融合评分 ${fmtNum(scoreForPlan, 3)}</span>
    </div>
    <div class="plan-grid">
      <span class="k">入场价（市价）</span><span class="v">${fmtPrice(plan.entry)}</span>
      <span class="k">止损（2.5×ATR）</span><span class="v down">${fmtPrice(plan.stopLoss)} <small>-${plan.stopPct.toFixed(2)}%</small></span>
      <span class="k">止盈一（${plan.rr1}）</span><span class="v up">${fmtPrice(plan.tp1)} <small>+${plan.tp1Pct.toFixed(2)}%</small></span>
      <span class="k">止盈二（${plan.rr2}）</span><span class="v up">${fmtPrice(plan.tp2)} <small>+${plan.tp2Pct.toFixed(2)}%</small></span>
      <span class="k">建议杠杆</span><span class="v">${plan.leverage}x</span>
      <span class="k">保证金占比</span><span class="v" style="color:var(--accent)">${plan.marginPct.toFixed(1)}%</span>
    </div>
    <div class="plan-footer">
      <div class="cell-mini"><div class="k">单笔风险</div><div class="v">${plan.riskPerTrade.toFixed(1)}%</div></div>
      <div class="cell-mini"><div class="k">止盈一盈亏比</div><div class="v">${plan.rr1}</div></div>
      <div class="cell-mini"><div class="k">止盈二盈亏比</div><div class="v">${plan.rr2}</div></div>
    </div>
    ${touchRow}
    <div style="font-size:10px;color:var(--text-faint);margin-top:10px;line-height:1.6;">
      保证金% × 杠杆 × 止损% = 账户风险 1%。到达止盈一后可移动止损至入场价。触价概率来自 3000 条 Bootstrap 模拟路径（24 bar 内）。
    </div>`;
}

// ---------------- 因子条 ----------------
function renderFactors(factors) {
  const rows = [];
  for (const g in factors.groupAverages) {
    const v = factors.groupAverages[g];
    const w = Math.min(Math.abs(v), 1) * 50;
    rows.push(`
      <div class="factor-row">
        <span class="name">${GROUP_NAMES[g] || g}</span>
        <div class="fbar"><div class="mid"></div><div class="fill ${v >= 0 ? 'pos' : 'neg'}" style="width:${w}%"></div></div>
        <span class="val ${clsBySign(v)}">${fmtNum(v, 2)}</span>
      </div>`);
  }
  $('factorBars').innerHTML = rows.join('');
}

// ---------------- 风险管理 ----------------
function renderRisk(factors, pos) {
  const raw = factors.rawIndicators;
  const risk = riskLevels(raw.price, raw.atr, pos.direction);
  const rets = Stats.logReturns(state.candles.map(x => x.close).slice(-200));
  const { var: v95, es: es95 } = Stats.varEs(rets, 95);
  const cells = [
    { k: '年化波动率 (EWMA)', v: fmtPct(pos.annualizedVol, 1, false) },
    { k: 'ATR(14)', v: fmtPrice(raw.atr) },
    { k: '建议仓位', v: fmtPct(pos.size, 0, false), cls: pos.direction > 0 ? 'good' : pos.direction < 0 ? 'bad' : '' },
    { k: '建议杠杆上限', v: pos.leverage ? pos.leverage + 'x' : '—' },
    { k: 'VaR 95% (单bar)', v: fmtPct(-v95, 2, false), cls: 'bad' },
    { k: 'ES 95% (单bar)', v: fmtPct(-es95, 2, false), cls: 'bad' },
  ];
  if (risk) {
    cells.push({ k: pos.direction > 0 ? '止损位 (1.5×ATR)' : '止损位 (1.5×ATR)', v: fmtPrice(risk.stop) + ` (${fmtPct100(-risk.stopPct, 2, false)})`, cls: 'bad' });
    cells.push({ k: '目标一 (R:R 1:1)', v: fmtPrice(risk.t1) + ` (${fmtPct100(risk.t1Pct, 2, false)})`, cls: 'good' });
    cells.push({ k: '目标二 (R:R 1:2)', v: fmtPrice(risk.t2) + ` (${fmtPct100(risk.t2Pct, 2, false)})`, cls: 'good' });
  }
  $('riskMetrics').innerHTML = cells.map(c => `<div class="metric ${c.cls || ''}"><div class="k">${c.k}</div><div class="v">${c.v}</div></div>`).join('');
}

// ---------------- 合约数据 ----------------
function renderFutures(extra) {
  const panel = $('futuresPanel');
  if (state.market !== 'futures') { panel.style.display = 'none'; return; }
  panel.style.display = '';
  const fr = extra.fundingRate;
  const mirror = getDataMode() === 'mirror';
  // 拥挤度 z-score：「极端」是相对该币自身近期分布而言，不是绝对阈值（约 30 天 ≈ 90 次 funding）
  let crowdCell = null, crowdWarn = '';
  const hist = extra.fundingHist;
  if (hist && hist.length >= 10 && fr != null) {
    const m = hist.reduce((a, b) => a + b, 0) / hist.length;
    const sd = Math.sqrt(hist.reduce((s, x) => s + (x - m) ** 2, 0) / hist.length);
    if (sd > 0) {
      const z = (fr - m) / sd;
      const oiRising = extra.oiChange != null && extra.oiChange > 0.03;
      const az = Math.abs(z);
      const label = az < 1 ? '平衡' : az < 2 ? (z > 0 ? '偏多拥挤' : '偏空拥挤') : (z > 0 ? '多头极端拥挤' : '空头极端拥挤');
      crowdCell = {
        k: '资金费率拥挤度 z',
        v: `${fmtNum(z, 2)} · ${label}`,
        cls: az >= 2 ? 'bad' : az >= 1 ? '' : 'good',
      };
      // 研究结论：极端拥挤 + 持仓量扩张 = 挤压危险区（过滤器：收紧风控，而非反向开仓信号）
      if (az >= 2 && oiRising) {
        crowdWarn = `<div style="grid-column:1/-1;font-size:11px;line-height:1.7;padding:8px 10px;border-radius:6px;background:rgba(246,70,93,.07);border:1px solid rgba(246,70,93,.25);">
          ${icon('alert')} <b>挤压危险区</b>：${z > 0 ? '多头' : '空头'}极端拥挤（z=${fmtNum(z, 1)}）且持仓量 30 期扩张 ${fmtPct(extra.oiChange, 1)}——清算连锁风险升高，建议收紧止损、减小仓位，而不是逆势重仓。</div>`;
      }
    }
  }
  const cells = [
    { k: '资金费率', v: fr != null ? fmtPct(fr, 4) : '—', cls: fr > 0.0005 ? 'bad' : fr < -0.0005 ? 'good' : '' },
    { k: '多空账户比', v: extra.lsRatio != null ? fmtNum(extra.lsRatio, 2) : '—' },
    { k: '持仓量30期变化', v: extra.oiChange != null ? fmtPct(extra.oiChange, 2) : '—', cls: clsBySign(extra.oiChange) },
    { k: '主动买卖比', v: extra.takerRatio != null ? fmtNum(extra.takerRatio, 2) : '—', cls: extra.takerRatio > 1.05 ? 'good' : extra.takerRatio < 0.95 ? 'bad' : '' },
  ];
  if (crowdCell) cells.push(crowdCell);
  $('futuresMetrics').innerHTML = cells.map(c => `<div class="metric ${c.cls || ''}"><div class="k">${c.k}</div><div class="v">${c.v}</div></div>`).join('')
    + crowdWarn
    + (mirror ? '<div style="grid-column:1/-1;font-size:10px;color:var(--text-faint);margin-top:4px;">镜像数据模式下合约专属数据不可用（资金费率 / 多空比 / 持仓量需直连币安合约 API）</div>' : '');
}

// ---------------- 消息面（云端每小时自动抓取：RSS 五源 + Reddit + FGI，VADER 情绪打分） ----------------
function renderNews(nv) {
  const panel = $('newsPanel');
  if (!panel) return;
  if (!nv) { panel.style.display = 'none'; return; }
  panel.style.display = '';
  const fgi = nv.fgi;
  const fgiCls = fgi ? (fgi.value >= 75 ? 'bad' : fgi.value <= 25 ? 'good' : '') : '';
  const coinCls = nv.coinSent == null ? '' : nv.coinSent > 0.15 ? 'good' : nv.coinSent < -0.15 ? 'bad' : '';
  const cells = [
    fgi ? { k: '恐慌贪婪指数', v: `${fgi.value} <small style="color:var(--text-faint)">${fgi.label} · 24h ${fgi.delta24h > 0 ? '+' : ''}${fgi.delta24h}</small>`, cls: fgiCls } : null,
    fgi ? { k: 'FGI 拥挤度 z', v: `${fmtNum(fgi.z, 2)} <small style="color:var(--text-faint)">vs 30天均值 ${fgi.mean30}</small>`, cls: Math.abs(fgi.z) >= 2 ? 'bad' : '' } : null,
    { k: '全局新闻情绪', v: nv.globalSent != null ? fmtNum(nv.globalSent, 3) : '—', cls: nv.globalSent > 0.1 ? 'good' : nv.globalSent < -0.1 ? 'bad' : '' },
    { k: '本币报道热度', v: nv.coinBuzz > 0 ? `${nv.coinBuzz} 篇 <small style="color:var(--text-faint)">全市场分位 ×${fmtNum(nv.coinBuzzRel, 1)}</small>` : '近 48h 无报道' },
    { k: '本币新闻情绪', v: nv.coinSent != null ? fmtNum(nv.coinSent, 2) : '—', cls: coinCls },
  ].filter(Boolean);
  const headlines = nv.top.length
    ? `<div style="margin-top:8px;">${nv.top.map(h => `
        <div style="font-size:11px;line-height:1.6;padding:5px 0;border-top:1px solid var(--border,#eef0f4);">
          <span class="chip ${h.s > 0 ? 'long' : 'short'}" style="padding:0 6px;font-size:10px;">${h.s > 0 ? '利多' : '利空'} ${h.s}</span>
          <span style="color:var(--text-dim)">[${h.src}]</span> ${h.t}
        </div>`).join('')}</div>`
    : '';
  $('newsMetrics').innerHTML = cells.map(c => `<div class="metric ${c.cls || ''}"><div class="k">${c.k}</div><div class="v">${c.v}</div></div>`).join('')
    + `<div style="grid-column:1/-1;font-size:10px;color:var(--text-faint);line-height:1.6;">
        ${nv.totalItems} 条/48h · 更新于 ${nv.ageH != null ? (nv.ageH < 1 ? Math.round(nv.ageH * 60) + ' 分钟' : nv.ageH.toFixed(1) + ' 小时') : '—'}前（每小时自动抓取）·
        消息面当前为静态权重 0.05 参与综合评分，随实盘追踪样本积累后进入云端训练学习权重
      </div>` + headlines;
}

// ---------------- 预测 ----------------
function renderForecast(factors, fused) {
  const raw = factors.rawIndicators;
  const scoreForForecast = fused != null ? fused : factors.composite;
  const mc = monteCarloCone(state.candles, scoreForForecast, 24, 4000);
  const fcst = pointForecast(state.candles, 12);
  const reg = regChannel(state.candles, 60);
  const garch = garchVolForecast(state.candles, 24);

  if (mc) {
    $('probUpBig').innerHTML = `<span class="${mc.probUp >= 0.5 ? 'up' : 'down'}">${fmtPct(mc.probUp, 1, false)}</span>`;
    const last = mc.rows[mc.rows.length - 1];
    const ppy = Stats.periodsPerYear(state.interval);
    const cells = [
      { k: `MC中位数 (T+${mc.horizon}bar)`, v: fmtPrice(last.p50), cls: last.p50 >= mc.S0 ? 'good' : 'bad' },
      { k: '90%置信区间', v: `${fmtPrice(last.p5)} ~ ${fmtPrice(last.p95)}` },
      { k: 'Holt预测 (T+12bar)', v: fcst.length ? fmtPrice(fcst[fcst.length - 1]) : '—', cls: fcst.length && fcst[fcst.length - 1] >= mc.S0 ? 'good' : 'bad' },
      { k: '回归斜率 (每bar)', v: reg ? fmtPct100(reg.slopePctPerBar, 3) : '—', cls: reg ? (reg.slope > 0 ? 'good' : 'bad') : '' },
      { k: '回归R²', v: reg ? fmtNum(reg.r2, 2) : '—' },
      { k: '偏离通道 (z)', v: reg ? fmtNum(reg.zNow, 2) : '—', cls: reg && Math.abs(reg.zNow) > 2 ? 'bad' : '' },
      { k: 'GARCH波动 (当前)', v: garch ? fmtPct(garch.sigmaNow * Math.sqrt(ppy), 0, false) + '/年' : '—' },
      { k: `GARCH波动 (T+${mc.horizon}bar)`, v: garch ? fmtPct(garch.sigmaH * Math.sqrt(ppy), 0, false) + '/年' : '—', cls: garch && garch.sigmaH > garch.sigmaNow * 1.1 ? 'bad' : '' },
    ];
    $('forecastMetrics').innerHTML = cells.map(c => `<div class="metric ${c.cls || ''}"><div class="k">${c.k}</div><div class="v">${c.v}</div></div>`).join('')
      + '<div style="grid-column:1/-1;font-size:10px;color:var(--text-faint);">预测引擎：Block Bootstrap 重采样历史收益块（保留肥尾与波动聚集）+ 融合信号漂移倾斜，比高斯假设更贴近加密市场真实分布。</div>';

    $('coneBody').innerHTML = mc.rows.map(r => `
      <tr style="cursor:default">
        <td>T+${r.horizon} bar</td>
        <td class="down">${fmtPrice(r.p5)}</td>
        <td class="down">${fmtPrice(r.p25)}</td>
        <td style="font-weight:700">${fmtPrice(r.p50)}</td>
        <td class="up">${fmtPrice(r.p75)}</td>
        <td class="up">${fmtPrice(r.p95)}</td>
      </tr>`).join('');

    renderConeChart(mc, fcst);
  } else {
    $('forecastMetrics').innerHTML = '<div class="placeholder">数据不足，无法预测</div>';
  }
}

function renderConeChart(mc, fcst) {
  const el = $('coneChart');
  el.innerHTML = '';
  if (state.coneChart) { try { state.coneChart.remove(); } catch (e) {} }
  const chart = LightweightCharts.createChart(el, {
    height: 200,
    layout: { background: { color: 'transparent' }, textColor: '#5b6472' },
    grid: { vertLines: { color: '#eef0f4' }, horzLines: { color: '#eef0f4' } },
    timeScale: { borderColor: '#d8dee7' },
    rightPriceScale: { borderColor: '#d8dee7' },
  });
  state.coneChart = chart;
  const n = state.candles.length;
  const stepMs = state.candles[1].time - state.candles[0].time;
  const t0 = state.candles[n - 1].time / 1000;

  const mk = (data, color, width, style) => {
    const s = chart.addLineSeries({ color, lineWidth: width, lineStyle: style || 0, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    s.setData(data);
    return s;
  };
  // 历史价格（最近80根）
  const hist = state.candles.slice(-80).map(k => ({ time: k.time / 1000, value: k.close }));
  mk(hist, '#3d4450', 1);
  // MC 分位带
  const pts = mc.rows.map((r, i) => ({ time: t0 + r.horizon * stepMs / 1000, p5: r.p5, p50: r.p50, p95: r.p95 }));
  const anchor = { time: t0, p5: mc.S0, p50: mc.S0, p95: mc.S0 };
  const all = [anchor, ...pts];
  mk(all.map(p => ({ time: p.time, value: p.p95 })), 'rgba(22,163,74,0.65)', 1, 2);
  mk(all.map(p => ({ time: p.time, value: p.p50 })), '#2563eb', 2, 2);
  mk(all.map(p => ({ time: p.time, value: p.p5 })), 'rgba(220,38,38,0.65)', 1, 2);
  if (fcst.length) {
    const fd = [{ time: t0, value: mc.S0 }, ...fcst.map((v, i) => ({ time: t0 + (i + 1) * stepMs / 1000, value: v }))];
    mk(fd, '#7c3aed', 1, 2);
  }
  chart.timeScale().fitContent();
}

// ---------------- 条件胜率 ----------------
function renderCondStats(factors) {
  const cs = conditionalStats(state.candles, factors.composite, 12);
  if (!cs) { $('condMetrics').innerHTML = '<div class="placeholder">样本内同类信号不足 15 次，无法统计</div>'; return; }
  const cells = [
    { k: '同类信号次数', v: cs.matches },
    { k: `胜率 (T+${cs.forwardBars}bar)`, v: fmtPct(cs.winRate, 1, false), cls: cs.winRate > 0.52 ? 'good' : cs.winRate < 0.48 ? 'bad' : '' },
    { k: '平均收益', v: fmtPct(cs.avgRet, 2), cls: clsBySign(cs.avgRet) },
    { k: '中位收益', v: fmtPct(cs.medianRet, 2), cls: clsBySign(cs.medianRet) },
  ];
  $('condMetrics').innerHTML = cells.map(c => `<div class="metric ${c.cls || ''}"><div class="k">${c.k}</div><div class="v">${c.v}</div></div>`).join('')
    + `<div style="grid-column:1/-1;font-size:10px;color:var(--text-dim);margin-top:4px;">口径：历史中出现与当前同方向/同级别信号后，${cs.forwardBars} 根K线内的方向收益。${cs.expectancyNote}。</div>`;
}

// ---------------- 多周期共振 ----------------
async function computeMTF() {
  return Promise.all(INTERVALS.map(async iv => {
    try {
      const candles = await fetchKlines(state.symbol, iv, 200, state.market);
      const f = computeFactors(candles, null, state.symbol);
      if (!f) return { iv, score: null };
      return { iv, score: f.composite, raw: f.rawIndicators };
    } catch (e) { return { iv, score: null }; }
  }));
}

function renderMTFTable(rows, fused) {
  $('mtfBody').innerHTML = rows.map(r => {
    if (r.score == null) return `<tr style="cursor:default"><td>${r.iv}</td><td colspan="5" style="color:var(--text-dim)">数据不足</td></tr>`;
    const sig = signalOf(r.score);
    const regime = detectRegime(r.raw);
    return `<tr style="cursor:default">
      <td><b>${r.iv}</b></td>
      <td class="${clsBySign(r.score)}" style="font-weight:600">${fmtNum(r.score, 3)}</td>
      <td><span class="chip ${sig.dir > 0 ? 'long' : sig.dir < 0 ? 'short' : 'flat'}">${sig.label}</span></td>
      <td><span class="chip ${regime.cls}">${regime.label}</span></td>
      <td>${fmtNum(r.raw.rsi, 1)}</td>
      <td>${fmtNum(r.raw.adx, 1)}</td>
    </tr>`;
  }).join('');

  const valid = rows.filter(r => r.score != null);
  if (valid.length >= 2) {
    const dirs = valid.map(r => Math.sign(r.score));
    const sameDir = dirs.every(d => d === dirs[0] && d !== 0);
    const fusedTxt = fused != null ? ` · 融合评分 <b class="${clsBySign(fused)}">${fmtNum(fused, 3)}</b>（15m 20% / 1h 35% / 4h 30% / 1d 15%）` : '';
    $('mtfVerdict').innerHTML = (sameDir
      ? `<span class="${dirs[0] > 0 ? 'up' : 'down'}" style="font-weight:600">${icon('check')} ${valid.length} 个周期方向一致（${dirs[0] > 0 ? '偏多' : '偏空'}） 共振强度高</span>`
      : `<span style="color:var(--accent)">${icon('alert')} 各周期方向分歧 建议降低仓位等待方向明确</span>`) + `<div style="margin-top:6px;color:var(--text-dim);font-size:11px;">${fusedTxt}</div>`;
  }
}

// ---------------- 图表 ----------------
function initChart() {
  const el = $('chart');
  state.chart = LightweightCharts.createChart(el, {
    height: 380,
    layout: { background: { color: 'transparent' }, textColor: '#5b6472' },
    grid: { vertLines: { color: '#eef0f4' }, horzLines: { color: '#eef0f4' } },
    timeScale: { borderColor: '#d8dee7', timeVisible: true },
    rightPriceScale: { borderColor: '#d8dee7' },
    crosshair: { mode: 0 },
  });
  state.candleSeries = state.chart.addCandlestickSeries({
    upColor: '#16a34a', downColor: '#dc2626', borderVisible: false,
    wickUpColor: '#16a34a', wickDownColor: '#dc2626',
  });
  state.ema9S = state.chart.addLineSeries({ color: '#d97706', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
  state.ema21S = state.chart.addLineSeries({ color: '#2563eb', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
  state.volS = state.chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
  state.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  window.addEventListener('resize', () => state.chart.applyOptions({ width: el.clientWidth }));
}

function renderChart() {
  const candles = state.candles;
  const toSec = candles.map(k => ({ time: k.time / 1000, open: k.open, high: k.high, low: k.low, close: k.close }));
  state.candleSeries.setData(toSec);
  const closes = candles.map(k => k.close);
  const e9 = EMA(closes, 9), e21 = EMA(closes, 21);
  state.ema9S.setData(candles.map((k, i) => e9[i] != null ? { time: k.time / 1000, value: e9[i] } : null).filter(Boolean));
  state.ema21S.setData(candles.map((k, i) => e21[i] != null ? { time: k.time / 1000, value: e21[i] } : null).filter(Boolean));
  state.volS.setData(candles.map(k => ({ time: k.time / 1000, value: k.volume, color: k.close >= k.open ? 'rgba(22,163,74,0.35)' : 'rgba(220,38,38,0.35)' })));
  state.chart.timeScale().fitContent();
}

// ---------------- 实时（WS 优先，失败自动转 REST 轮询） ----------------
function onLiveCandle(k, lastPriceRef) {
  const priceEl = $('priceNow');
  if (lastPriceRef.v != null && k.close !== lastPriceRef.v) {
    priceEl.classList.remove('flash-up', 'flash-down');
    void priceEl.offsetWidth;
    priceEl.classList.add(k.close > lastPriceRef.v ? 'flash-up' : 'flash-down');
  }
  lastPriceRef.v = k.close;
  priceEl.textContent = fmtPrice(k.close);
  state.candleSeries.update({ time: k.time / 1000, open: k.open, high: k.high, low: k.low, close: k.close });
  if (k.closed || k.isPoll) {
    const last = state.candles[state.candles.length - 1];
    if (last && last.time === k.time) Object.assign(last, k);
    else if (last && k.time > last.time) { state.candles.push({ ...k }); if (state.candles.length > 400) state.candles.shift(); }
    if (k.closed) reloadQuiet();
  }
}

function connectLive() {
  const lastPriceRef = { v: null };
  state.ws = connectKlineWS(state.symbol, state.interval, state.market,
    k => onLiveCandle(k, lastPriceRef),
    s => {
      if (s === 'connected') setNet('已连接 · 实时更新中', 'connected');
      else if (s === 'connecting') setNet('实时连接中…', 'connecting');
      else if (s === 'disconnected') setNet('连接断开，重连中…', 'connecting');
      else if (s === 'failed') {
        // WS 彻底不可用（网络屏蔽）→ REST 轮询兜底
        setNet('实时推送不可用 · 已切换 5 秒轮询', 'connecting');
        state.poller = pollKlines(state.symbol, state.interval, state.market, k => {
          const last = state.candles[state.candles.length - 1];
          const isNew = last && k.time > last.time;
          onLiveCandle({ ...k, isPoll: true, closed: isNew }, lastPriceRef);
        }, 5000);
      }
    });
}

let quietTimer = null;
function reloadQuiet() {
  clearTimeout(quietTimer);
  quietTimer = setTimeout(async () => {
    const factors = computeFactors(state.candles, null, state.symbol);
    if (!factors) return;
    const pos = computePosition(factors.composite, state.candles, state.interval);
    renderOverview(factors, pos, {});
    renderFactors(factors);
    renderTradePlan(factors, pos);
    renderRisk(factors, pos);
    $('updateTime').textContent = '更新于 ' + new Date().toLocaleTimeString();
  }, 500);
}

init();
