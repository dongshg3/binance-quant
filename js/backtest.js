// ============================================================
// backtest.js · 回测中心
// ============================================================
import { Stats } from './lib/stats.js';
import { loadAllSymbols, fetchKlines } from './lib/api.js';
import { runBacktest } from './lib/quant.js';
import { renderNav, setNet, fmtPrice, fmtPct, fmtNum, fmtTime, clsBySign, getParams, buildSymbolPicker, disclaimerHTML, icon } from './lib/ui.js';

renderNav('backtest');
document.getElementById('disclaimerSlot').innerHTML = disclaimerHTML();

const params = getParams();
const state = {
  market: params.market || 'futures',
  symbol: (params.symbol || 'BTCUSDT').toUpperCase(),
  interval: params.interval || '1h',
  chart: null,
};
const $ = id => document.getElementById(id);

async function init() {
  $('marketSelect').value = state.market;
  $('intervalSelect').value = state.interval;

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
}

async function run() {
  $('runBtn').disabled = true;
  $('runBtn').innerHTML = icon('loader', 'spin') + '回测中…';
  $('btStatus').textContent = '拉取K线数据…';

  const limit = Math.min(parseInt($('limitInput').value) || 1000, 1500);
  const fee = (parseFloat($('feeInput').value) || 0.05) / 100;
  const slip = (parseFloat($('slipInput').value) || 0.02) / 100;

  try {
    const candles = await fetchKlines(state.symbol, state.interval, limit, state.market);
    $('btStatus').textContent = `计算因子 (${candles.length} 根K线)…`;
    await new Promise(r => setTimeout(r, 30)); // 让 UI 刷新

    const t0 = performance.now();
    const res = runBacktest(candles, state.interval, { feeRate: fee, slippage: slip });
    if (res.error) { $('btStatus').textContent = res.error; return; }
    const dt = ((performance.now() - t0) / 1000).toFixed(1);

    renderMetrics(res, candles);
    renderChart(res, candles);
    renderCompare(res);
    renderTrades(res);
    renderOOS(candles, fee, slip);
    $('btSub').textContent = `${state.symbol} · ${state.interval} · ${res.metrics.numBars} 根K线 · 耗时 ${dt}s`;
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
  ];
  $('btMetrics').innerHTML = cells.map(c => `<div class="metric ${c.cls || ''}"><div class="k">${c.k}</div><div class="v">${c.v}</div></div>`).join('');
}

function renderChart(res, candles) {
  const el = document.getElementById('eqChart');
  el.innerHTML = '';
  if (state.chart) { try { state.chart.remove(); } catch (e) {} }
  const chart = LightweightCharts.createChart(el, {
    height: 340,
    layout: { background: { color: 'transparent' }, textColor: '#5b6472' },
    grid: { vertLines: { color: '#eef0f4' }, horzLines: { color: '#eef0f4' } },
    timeScale: { borderColor: '#d8dee7', timeVisible: true },
    rightPriceScale: { borderColor: '#d8dee7' },
    leftPriceScale: { visible: true, borderColor: '#d8dee7' },
  });
  state.chart = chart;

  const start = candles.length - res.returns.length;
  const eqLine = chart.addLineSeries({ color: '#2563eb', lineWidth: 2, priceLineVisible: false });
  const bhLine = chart.addLineSeries({ color: '#94a3b8', lineWidth: 1, priceLineVisible: false });
  const ddLine = chart.addAreaSeries({ color: 'rgba(220,38,38,0.35)', lineColor: '#dc2626', lineWidth: 1, priceScaleId: 'left', priceLineVisible: false, lastValueVisible: false });
  chart.priceScale('left').applyOptions({ scaleMargins: { top: 0.05, bottom: 0.75 } });

  const eqData = [], bhData = [], ddData = [];
  let peak = 1;
  for (let i = 0; i < res.equity.length; i++) {
    const t = candles[start + i] ? candles[start + i].time / 1000 : (candles[candles.length - 1].time / 1000);
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

// ---------------- 样本外验证（70/30 切分） ----------------
function renderOOS(candles, fee, slip) {
  const n = candles.length;
  const split = Math.floor(n * 0.7);
  if (n < 500) {
    $('oosBody').innerHTML = '<tr><td colspan="3" class="placeholder">K线数不足 500，无法进行样本外验证（建议 ≥1000）</td></tr>';
    $('oosVerdict').innerHTML = '';
    return;
  }
  const resIS = runBacktest(candles.slice(0, split), state.interval, { feeRate: fee, slippage: slip });
  const resOOS = runBacktest(candles.slice(Math.max(0, split - 210)), state.interval, { feeRate: fee, slippage: slip });
  if (resIS.error || resOOS.error) {
    $('oosBody').innerHTML = `<tr><td colspan="3" class="placeholder">${resIS.error || resOOS.error}</td></tr>`;
    return;
  }
  const rows = [
    ['总收益率', fmtPct(resIS.metrics.totalReturn, 1), fmtPct(resOOS.metrics.totalReturn, 1)],
    ['夏普比率', fmtNum(resIS.metrics.sharpe), fmtNum(resOOS.metrics.sharpe)],
    ['最大回撤', fmtPct(-resIS.metrics.mdd, 1, false), fmtPct(-resOOS.metrics.mdd, 1, false)],
    ['bar胜率', fmtPct(resIS.metrics.winRate, 1, false), fmtPct(resOOS.metrics.winRate, 1, false)],
    ['信号命中率', resIS.metrics.sigAccuracy != null ? fmtPct(resIS.metrics.sigAccuracy, 1, false) : '—',
     resOOS.metrics.sigAccuracy != null ? fmtPct(resOOS.metrics.sigAccuracy, 1, false) : '—'],
  ];
  $('oosBody').innerHTML = rows.map(([k, a, b]) => `
    <tr style="cursor:default">
      <td style="color:var(--text-dim)">${k}</td>
      <td style="text-align:right">${a}</td>
      <td style="text-align:right;font-weight:700">${b}</td>
    </tr>`).join('');

  // 过拟合判定
  const isSharpe = resIS.metrics.sharpe, oosSharpe = resOOS.metrics.sharpe;
  let verdict, cls;
  if (oosSharpe > 0.5 && oosSharpe >= isSharpe * 0.5) {
    verdict = `${icon('check')} 样本外夏普 ${fmtNum(oosSharpe)} 保持样本内水平（${fmtNum(isSharpe)}） 策略衰减可控 过拟合风险较低`;
    cls = 'up';
  } else if (oosSharpe > 0) {
    verdict = `${icon('alert')} 样本外夏普 ${fmtNum(oosSharpe)} 明显低于样本内 ${fmtNum(isSharpe)} 存在一定过拟合 实盘需降仓验证`;
    cls = '';
    $('oosVerdict').style.color = 'var(--accent)';
    $('oosVerdict').innerHTML = verdict;
    return;
  } else {
    verdict = `${icon('x')} 样本外夏普 ${fmtNum(oosSharpe)} 为负（样本内 ${fmtNum(isSharpe)}） 策略很可能过拟合 不建议据此信号实盘`;
    cls = 'down';
  }
  $('oosVerdict').innerHTML = `<span class="${cls}">${verdict}</span>`;
}

init();
