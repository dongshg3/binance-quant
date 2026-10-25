// ============================================================
// backtest.js · 回测中心
// ============================================================
import { Stats } from './lib/stats.js';
import { loadAllSymbols, fetchKlines } from './lib/api.js';
import { runBacktest } from './lib/quant.js';
import { loadModel } from './lib/model.js';
import { renderNav, setNet, fmtPrice, fmtPct, fmtNum, fmtTime, clsBySign, getParams, buildSymbolPicker, disclaimerHTML, icon } from './lib/ui.js';

renderNav('backtest');
document.getElementById('disclaimerSlot').innerHTML = disclaimerHTML();

const params = getParams();
const state = {
  market: params.market || 'futures',
  symbol: (params.symbol || 'BTCUSDT').toUpperCase(),
  interval: params.interval || '1h',
  chart: null, lastResult: null,
};
const $ = id => document.getElementById(id);

async function init() {
  $('marketSelect').value = state.market;
  $('intervalSelect').value = state.interval;
  await loadModel();

  let symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
  try { symbols = await loadAllSymbols(state.market); setNet('就绪', 'connected'); }
  catch (e) { setNet('币种列表加载失败（可手动输入主流币种）', ''); }
  if (!symbols.includes(state.symbol)) state.symbol = 'BTCUSDT';

  buildSymbolPicker($('symbolPickerWrap'), symbols, state.symbol, s => { state.symbol = s; });
  $('marketSelect').addEventListener('change', async e => {
    state.market = e.target.value;
    try {
      const syms = await loadAllSymbols(state.market);
      if (!syms.includes(state.symbol)) state.symbol = 'BTCUSDT';
      buildSymbolPicker($('symbolPickerWrap'), syms, state.symbol, s => { state.symbol = s; });
    } catch (e2) {}
  });
  $('intervalSelect').addEventListener('change', e => { state.interval = e.target.value; });
  $('runBtn').addEventListener('click', run);
  $('exportBtBtn').addEventListener('click', () => {
    const res = state.lastResult;
    if (!res) { $('btStatus').textContent = '请先运行回测'; return; }
    const rows = [['signalTime', 'executionTime', 'from', 'to', 'executionPrice', 'score', 'cost'], ...res.trades.map(t => [new Date(t.signalTime).toISOString(), new Date(t.time).toISOString(), t.from, t.to, t.price, t.score, t.cost])];
    const csv = rows.map(r => r.join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = `backtest-${state.symbol}-${Date.now()}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}

async function run() {
  $('runBtn').disabled = true;
  $('runBtn').innerHTML = icon('loader', 'spin') + '回测中…';
  $('btStatus').textContent = '拉取K线数据…';

  const limit = Math.min(parseInt($('limitInput').value) || 1000, 1500);
  const fee = (parseFloat($('feeInput').value) || 0.05) / 100;
  const slip = (parseFloat($('slipInput').value) || 0.02) / 100;
  const fundingPct = parseFloat($('fundingInput').value);
  const opts = {
    feeRate: fee, slippage: slip, symbol: state.symbol,
    fundingRatePer8h: (Number.isFinite(fundingPct) ? fundingPct : 0.01) / 100,
    threshold: parseFloat($('thresholdInput').value) || 0.15,
    minTradeDelta: parseFloat($('rebalanceInput').value) || 0.1,
  };

  try {
    const candles = await fetchKlines(state.symbol, state.interval, limit, state.market);
    $('btStatus').textContent = `计算因子 (${candles.length} 根K线)…`;
    await new Promise(r => setTimeout(r, 30));

    const t0 = performance.now();
    const res = runBacktest(candles, state.interval, opts);
    if (res.error) { $('btStatus').textContent = res.error; return; }
    const dt = ((performance.now() - t0) / 1000).toFixed(1);
    state.lastResult = res;

    renderMetrics(res);
    renderChart(res);
    renderCompare(res);
    renderTrades(res);
    renderRobustness(res);
    await renderOOS(candles, opts);
    $('btSub').textContent = `${state.symbol} · ${state.interval} · ${res.metrics.numBars} 根K线 · 主回测 ${dt}s · 下一根开盘成交`;
    $('btStatus').textContent = '完成 · ' + new Date().toLocaleTimeString();
  } catch (e) {
    $('btStatus').textContent = '失败: ' + e.message;
  } finally {
    $('runBtn').disabled = false;
    $('runBtn').innerHTML = icon('play') + '运行回测';
  }
}

function renderMetrics(res) {
  const m = res.metrics;
  const cells = [
    { k: '总收益率', v: fmtPct(m.totalReturn, 1), cls: m.totalReturn >= 0 ? 'good' : 'bad' },
    { k: '年化收益率', v: fmtPct(m.annualizedReturn, 1), cls: m.annualizedReturn >= 0 ? 'good' : 'bad' },
    { k: '年化波动率', v: fmtPct(m.annualizedVol, 1, false) },
    { k: '夏普比率', v: fmtNum(m.sharpe), cls: m.sharpe > 1 ? 'good' : m.sharpe < 0 ? 'bad' : '' },
    { k: '索提诺比率', v: fmtNum(m.sortino) },
    { k: '最大回撤', v: fmtPct(-m.mdd, 1, false), cls: 'bad' },
    { k: '卡玛比率', v: fmtNum(m.calmar) },
    { k: 'bar胜率', v: fmtPct(m.winRate, 1, false), cls: m.winRate > 0.52 ? 'good' : '' },
    { k: '盈亏比', v: fmtNum(m.profitFactor), cls: m.profitFactor > 1.3 ? 'good' : m.profitFactor < 1 ? 'bad' : '' },
    { k: '调仓次数', v: m.numTrades },
    { k: '信号命中率', v: m.sigAccuracy != null ? fmtPct(m.sigAccuracy, 1, false) : '—', cls: m.sigAccuracy > 0.52 ? 'good' : '' },
    { k: 'VaR 95% (bar)', v: fmtPct(-m.var95, 2, false), cls: 'bad' },
    { k: '成本前收益', v: fmtPct(m.grossTotalReturn, 1), cls: clsBySign(m.grossTotalReturn) },
    { k: '手续费 + 滑点', v: fmtPct(m.totalCosts, 2, false), cls: 'bad' },
    { k: '资金费净支出', v: fmtPct(m.fundingCashflow, 3), cls: m.fundingCashflow > 0 ? 'bad' : 'good' },
    { k: '平均仓位暴露', v: fmtPct(m.exposure, 1, false) },
    { k: '累计换手', v: fmtNum(m.turnover, 1) + '×' },
  ];
  $('btMetrics').innerHTML = cells.map(c => `<div class="metric ${c.cls || ''}"><div class="k">${c.k}</div><div class="v">${c.v}</div></div>`).join('');
}

function renderChart(res) {
  const el = document.getElementById('eqChart');
  el.innerHTML = '';
  if (state.chart) { try { state.chart.remove(); } catch (e) {} }
  const chart = LightweightCharts.createChart(el, {
    height: 340,
    layout: { background: { color: 'transparent' }, textColor: '#8c96a5' },
    grid: { vertLines: { color: 'rgba(148,163,184,0.08)' }, horzLines: { color: 'rgba(148,163,184,0.08)' } },
    timeScale: { borderColor: 'rgba(148,163,184,0.18)', timeVisible: true },
    rightPriceScale: { borderColor: 'rgba(148,163,184,0.18)' },
    leftPriceScale: { visible: true, borderColor: 'rgba(148,163,184,0.18)' },
  });
  state.chart = chart;

  const eqLine = chart.addLineSeries({ color: '#00E5A0', lineWidth: 2, priceLineVisible: false });
  const bhLine = chart.addLineSeries({ color: '#94a3b8', lineWidth: 1, priceLineVisible: false });
  const ddLine = chart.addAreaSeries({ color: 'rgba(220,38,38,0.35)', lineColor: '#dc2626', lineWidth: 1, priceScaleId: 'left', priceLineVisible: false, lastValueVisible: false });
  chart.priceScale('left').applyOptions({ scaleMargins: { top: 0.05, bottom: 0.75 } });

  const eqData = [], bhData = [], ddData = [];
  let peak = 1;
  for (let i = 0; i < res.equity.length; i++) {
    const t = res.times[Math.max(0, i - 1)] / 1000;
    eqData.push({ time: t, value: res.equity[i] });
    bhData.push({ time: t, value: res.bhEquity[i] });
    peak = Math.max(peak, res.equity[i]);
    ddData.push({ time: t, value: -(peak - res.equity[i]) / peak * 100 });
  }
  // 去重时间戳（防御）
  const dedupe = arr => arr.filter((p, i) => i === 0 || p.time > arr[i - 1].time);
  eqLine.setData(dedupe(eqData));
  bhLine.setData(dedupe(bhData));
  ddLine.setData(dedupe(ddData));
  chart.timeScale().fitContent();
}

function renderCompare(res) {
  const m = res.metrics, b = res.buyHold;
  const rows = [
    ['总收益率', fmtPct(m.totalReturn, 1), fmtPct(b.totalReturn, 1), m.totalReturn - b.totalReturn],
    ['年化收益率', fmtPct(m.annualizedReturn, 1), fmtPct(b.annualizedReturn, 1), m.annualizedReturn - b.annualizedReturn],
    ['最大回撤', fmtPct(-m.mdd, 1, false), fmtPct(-b.mdd, 1, false), b.mdd - m.mdd],
    ['夏普比率', fmtNum(m.sharpe), fmtNum(b.sharpe), m.sharpe - b.sharpe],
  ];
  $('compareBody').innerHTML = rows.map(([k, a, bb, diff]) => `
    <tr style="cursor:default">
      <td style="color:var(--text-dim)">${k}</td>
      <td style="text-align:right;font-weight:600">${a}</td>
      <td style="text-align:right">${bb}</td>
    </tr>`).join('') + `
    <tr style="cursor:default"><td colspan="3" style="font-size:11px;color:var(--text-dim);padding-top:10px;">
      ${m.totalReturn >= b.totalReturn
        ? `${icon('check')} 策略跑赢买入持有 ${fmtPct(m.totalReturn - b.totalReturn, 1, false)}，且回撤${m.mdd <= b.mdd ? '更小' : '更大'}`
        : `${icon('alert')} 策略跑输买入持有 ${fmtPct(b.totalReturn - m.totalReturn, 1, false)}，该品种该周期上策略可能不适用`}
    </td></tr>`;
}

function renderTrades(res) {
  $('tradeCount').textContent = `共 ${res.trades.length} 次`;
  const list = [...res.trades].reverse().slice(0, 200);
  $('tradesBody').innerHTML = list.map(t => `
    <tr style="cursor:default">
      <td>${fmtTime(t.time)}</td>
      <td><span class="chip ${t.to > 0 ? 'long' : t.to < 0 ? 'short' : 'flat'}">${t.to > 0 ? '做多' : t.to < 0 ? '做空' : '平仓'}</span></td>
      <td>${fmtPct(t.from, 0, false)} → ${fmtPct(t.to, 0, false)}</td>
      <td style="text-align:right">${fmtPrice(t.price)}</td>
      <td style="text-align:right" class="${clsBySign(t.score)}">${fmtNum(t.score, 3)}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="placeholder">无调仓记录</td></tr>';
}

// ---------------- 统计稳健性、时段切分与参数压力 ----------------
function renderRobustness(res) {
  const r = res.robustness;
  if (!r) { $('robustMetrics').innerHTML = '<div class="placeholder">有效样本不足</div>'; return; }
  const cells = [
    { k: '概率夏普 PSR(>0)', v: fmtPct(r.psr, 1, false), cls: r.psr >= 0.95 ? 'good' : r.psr < 0.6 ? 'bad' : '' },
    { k: 'Bootstrap 正夏普概率', v: fmtPct(r.positiveSharpeProb, 1, false), cls: r.positiveSharpeProb >= 0.8 ? 'good' : '' },
    { k: '总收益 95% 区间', v: `${fmtPct(r.returnCI95[0], 1)} ~ ${fmtPct(r.returnCI95[1], 1)}` },
    { k: '夏普 95% 区间', v: `${fmtNum(r.sharpeCI95[0])} ~ ${fmtNum(r.sharpeCI95[1])}` },
    { k: '净收益偏度', v: fmtNum(r.skew, 2), cls: r.skew < 0 ? 'bad' : 'good' },
    { k: '净收益峰度', v: fmtNum(r.kurtosis, 2), cls: r.kurtosis > 6 ? 'bad' : '' },
  ];
  $('robustMetrics').innerHTML = cells.map(c => `<div class="metric ${c.cls}"><div class="k">${c.k}</div><div class="v">${c.v}</div></div>`).join('');
}

async function renderOOS(candles, opts) {
  const n = candles.length, split = Math.floor(n * 0.7), purge = 200;
  const fast = { ...opts, bootstrap: false };
  const yieldUI = () => new Promise(r => setTimeout(r, 20));
  if (n < 900) {
    $('oosBody').innerHTML = '<tr><td colspan="3" class="placeholder">至少 900 根K线，才能在 70/30 切分后保留 200 bar 隔离带和足够验证样本</td></tr>';
    return;
  }
  $('btStatus').textContent = '执行时段稳健性与参数压力实验…';
  const resIS = runBacktest(candles, state.interval, { ...fast, endIndex: split });
  const resOOS = runBacktest(candles, state.interval, { ...fast, startIndex: split + purge });
  if (resIS.error || resOOS.error) {
    $('oosBody').innerHTML = `<tr><td colspan="3" class="placeholder">${resIS.error || resOOS.error}</td></tr>`;
    return;
  }
  const rows = [
    ['总收益率', fmtPct(resIS.metrics.totalReturn, 1), fmtPct(resOOS.metrics.totalReturn, 1)],
    ['夏普比率', fmtNum(resIS.metrics.sharpe), fmtNum(resOOS.metrics.sharpe)],
    ['最大回撤', fmtPct(-resIS.metrics.mdd, 1, false), fmtPct(-resOOS.metrics.mdd, 1, false)],
    ['bar胜率', fmtPct(resIS.metrics.winRate, 1, false), fmtPct(resOOS.metrics.winRate, 1, false)],
    ['成本占毛收益', resIS.metrics.grossTotalReturn !== 0 ? fmtPct(resIS.metrics.totalCosts / Math.abs(resIS.metrics.grossTotalReturn), 1, false) : '—', resOOS.metrics.grossTotalReturn !== 0 ? fmtPct(resOOS.metrics.totalCosts / Math.abs(resOOS.metrics.grossTotalReturn), 1, false) : '—'],
  ];
  $('oosBody').innerHTML = rows.map(([k, a, b]) => `<tr style="cursor:default"><td style="color:var(--text-dim)">${k}</td><td style="text-align:right">${a}</td><td style="text-align:right;font-weight:700">${b}</td></tr>`).join('');
  const isS = resIS.metrics.sharpe, oosS = resOOS.metrics.sharpe;
  const txt = oosS > 0 && isS > 0 ? `后段夏普 ${fmtNum(oosS)}，方向与前段一致；仍需结合下方 Bootstrap 区间判断稳定性。`
    : oosS <= 0 ? `隔离带后的后段夏普为 ${fmtNum(oosS)}，该参数组合在后段没有保持正向风险调整收益。`
    : `后段夏普 ${fmtNum(oosS)} 高于前段 ${fmtNum(isS)}，两段市场状态差异较大。`;
  $('oosVerdict').innerHTML = `<span class="${oosS > 0 ? 'up' : 'down'}">${txt}</span><div class="model-reason">隔离区间：索引 ${split}–${split + purge - 1}；后段实际使用 ${resOOS.metrics.numBars} bar。</div>`;

  const folds = [];
  for (const [lo, hi] of [[0.45, 0.62], [0.66, 0.83], [0.86, 1]]) {
    const r = runBacktest(candles, state.interval, { ...fast, startIndex: Math.floor(n * lo), endIndex: Math.floor(n * hi) });
    if (!r.error) folds.push({ lo, hi, ...r.metrics });
    await yieldUI();
  }
  $('foldTrack').innerHTML = `<div class="fold-title">滚动时段表现 <span>同一发布模型 · 非重新拟合</span></div><div class="fold-grid">${folds.map((f, i) => `<div class="fold-item"><div><span>时段 ${i + 1} · ${Math.round(f.lo * 100)}–${Math.round(f.hi * 100)}%</span><b class="${clsBySign(f.sharpe)}">SR ${fmtNum(f.sharpe)}</b></div><div class="fold-bar"><i class="${f.totalReturn >= 0 ? 'pos' : 'neg'}" style="width:${Math.min(100, Math.abs(f.totalReturn) * 300)}%"></i></div><small>${fmtPct(f.totalReturn, 1)} · ${f.numBars} bar</small></div>`).join('')}</div>`;

  const experiments = [0.15, 0.25, 0.35].map(t => ({ label: `信号阈值 ${t.toFixed(2)}`, options: { ...fast, threshold: t } }));
  experiments.push({ label: '成本 ×2', options: { ...fast, feeRate: opts.feeRate * 2, slippage: opts.slippage * 2 } });
  experiments.push({ label: '成本 ×3', options: { ...fast, feeRate: opts.feeRate * 3, slippage: opts.slippage * 3 } });
  const rows2 = [];
  for (const e of experiments) {
    const r = runBacktest(candles, state.interval, e.options);
    if (!r.error) rows2.push(`<tr style="cursor:default"><td>${e.label}</td><td style="text-align:right" class="${clsBySign(r.metrics.totalReturn)}">${fmtPct(r.metrics.totalReturn, 1)}</td><td style="text-align:right">${fmtNum(r.metrics.sharpe)}</td><td style="text-align:right" class="down">${fmtPct(-r.metrics.mdd, 1, false)}</td></tr>`);
    await yieldUI();
  }
  $('sensitivityBody').innerHTML = rows2.join('');
}

init();
