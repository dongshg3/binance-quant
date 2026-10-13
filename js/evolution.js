// ============================================================
// evolution.js · 模型进化页：学习轨迹可视化 + 信号追踪面板
// ============================================================
import { GROUP_NAMES } from './lib/quant.js';
import { getStats, exportCSV } from './lib/tracker.js';
import { renderNav, setNet, fmtPct, fmtNum, disclaimerHTML } from './lib/ui.js';

renderNav('evolution');
document.getElementById('disclaimerSlot').innerHTML = disclaimerHTML();
const $ = id => document.getElementById(id);

const GROUP_COLORS = {
  trend: '#f0b90b', momentum: '#2196f3', meanRev: '#0ecb81',
  volume: '#b37feb', volatility: '#f6465d', position: '#2ebd85', futures: '#848e9c',
};
const GROUP_ORDER = ['trend', 'momentum', 'meanRev', 'volume', 'volatility', 'position', 'futures'];

async function fetchJSON(path) {
  const res = await fetch(path + '?t=' + Date.now(), { cache: 'no-store' });
  if (!res.ok) throw new Error(path + ' HTTP ' + res.status);
  return res.json();
}

async function init() {
  setNet('加载模型数据…', 'connecting');
  let model = null, evo = [];
  try { model = await fetchJSON('data/model.json'); } catch (e) {}
  try { evo = await fetchJSON('data/evolution.json'); } catch (e) {}
  if (!Array.isArray(evo)) evo = [];

  renderModel(model);
  renderWeightCompare(model);
  renderICTable(model);
  renderWeightChart(evo);
  renderICChart(evo);
  renderHistory(evo);
  await renderTracker();

  $('exportBtn').addEventListener('click', async () => {
    try {
      const n = await exportCSV();
      $('exportStatus').textContent = `已导出 ${n} 条记录`;
    } catch (e) {
      $('exportStatus').textContent = '导出失败：' + e.message;
    }
  });

  setNet(model ? `已连接 · 模型 v${model.version}` : '模型文件不可用 · 使用静态权重', model ? 'connected' : 'connecting');
}

// ---------------- 当前模型 ----------------
function renderModel(model) {
  if (!model) {
    $('modelSub').textContent = '尚未产出学习模型';
    $('modelMetrics').innerHTML = '<div class="placeholder" style="grid-column:1/-1;">云端首次训练尚未完成（GitHub Actions 每 6 小时运行一次）。当前前端使用静态权重。</div>';
    return;
  }
  const d = new Date(model.trainedAt);
  const ageH = (Date.now() - d.getTime()) / 36e5;
  const cells = [
    { k: '模型版本', v: 'v' + model.version },
    { k: '训练时间', v: d.toLocaleString() + `（${ageH < 1 ? Math.round(ageH * 60) + ' 分钟' : ageH.toFixed(1) + ' 小时'}前）` },
    { k: '训练引擎', v: model.engine || 'ridge-v1' },
    { k: '训练币种 / 样本', v: `${model.meta?.symbols ?? '—'} / ${model.meta?.samples ?? '—'}` },
    { k: '样本内 IC', v: model.oos?.icInSample != null ? fmtNum(model.oos.icInSample, 4) : '—' },
    { k: '样本外 IC', v: model.oos?.ic != null ? fmtNum(model.oos.ic, 4) : '—', cls: model.oos?.ic > 0.05 ? 'good' : model.oos?.ic < 0.02 ? 'bad' : '' },
    { k: '多空组合夏普 (OOS)', v: model.oos?.lsSharpe != null ? fmtNum(model.oos.lsSharpe, 2) : '—', cls: model.oos?.lsSharpe > 1 ? 'good' : '' },
    { k: '预测视野', v: `T+${model.fwdBars ?? 12} bar` },
  ];
  // 实盘闸门信息（v2 引擎起）
  if (model.tracker) {
    const t = model.tracker;
    cells.push({
      k: '实盘追踪 IC',
      v: t.icNew != null ? `${fmtNum(t.icNew, 4)} <small style="color:var(--text-faint)">n=${t.n} · 旧 ${fmtNum(t.icPrev, 4)}</small>` : `样本积累中 <small style="color:var(--text-faint)">n=${t.n}/30</small>`,
      cls: t.icNew != null && t.icNew > 0.05 ? 'good' : '',
    });
    cells.push({
      k: '更新闸门',
      v: model.accepted !== false ? '✓ 本次已接受' : `✗ 已拒绝`,
      cls: model.accepted !== false ? 'good' : 'bad',
    });
    if (model.accepted === false && model.rejectReason) {
      cells.push({ k: '拒绝原因', v: `<small>${model.rejectReason}</small>`, cls: 'bad' });
    }
  }
  $('modelSub').textContent = `GitHub Actions 每 6 小时自动重训并发布 · 前端打开即用最新权重`;
  $('modelMetrics').innerHTML = cells.map(c => `<div class="metric ${c.cls || ''}"><div class="k">${c.k}</div><div class="v">${c.v}</div></div>`).join('')
    + `<div style="grid-column:1/-1;font-size:10px;color:var(--text-faint);line-height:1.6;">说明：IC 为池化截面（多币种混合）下的 Spearman 秩相关，样本早期数值偏高属正常现象，请重点关注其随训练次数增加的稳定性，而非绝对值。</div>`;
}

// ---------------- 权重对比 ----------------
function renderWeightCompare(model) {
  const el = $('weightCompare');
  if (!model || !model.weights) { el.innerHTML = '<div class="placeholder">暂无学习权重</div>'; return; }
  const maxAbs = Math.max(0.15, ...GROUP_ORDER.map(g => Math.abs(model.weights[g] ?? 0)), ...GROUP_ORDER.map(g => Math.abs(model.staticWeights?.[g] ?? 0)));
  el.innerHTML = GROUP_ORDER.map(g => {
    const lw = model.weights[g] ?? 0;
    const sw = model.staticWeights?.[g] ?? 0;
    const wL = Math.abs(lw) / maxAbs * 50;
    const wS = Math.abs(sw) / maxAbs * 50;
    const delta = lw - sw;
    return `
      <div class="factor-row" style="grid-template-columns:90px 1fr 150px;">
        <span class="name">${GROUP_NAMES[g] || g}</span>
        <div>
          <div class="fbar" style="margin-bottom:3px;" title="学习权重 ${lw.toFixed(4)}"><div class="mid"></div><div class="fill ${lw >= 0 ? 'pos' : 'neg'}" style="width:${wL}%"></div></div>
          <div class="fbar" style="opacity:0.35;" title="静态权重 ${sw.toFixed(4)}"><div class="mid"></div><div class="fill ${sw >= 0 ? 'pos' : 'neg'}" style="width:${wS}%"></div></div>
        </div>
        <span class="val">${fmtNum(lw, 3)} <small style="color:var(--text-faint)">vs ${fmtNum(sw, 2)}</small> <small class="${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}">${delta >= 0 ? '▲' : '▼'}${Math.abs(delta).toFixed(2)}</small></span>
      </div>`;
  }).join('') + '<div style="font-size:10px;color:var(--text-faint);margin-top:8px;">上条（实色）= 学习权重，下条（半透明）= 静态权重。负权重 = 该因子反向使用（数值越高越看空）。</div>';
}

// ---------------- 因子 IC 表 ----------------
function renderICTable(model) {
  if (!model || !model.factorIC) { $('icBody').innerHTML = '<tr><td colspan="4" style="color:var(--text-dim)">暂无数据</td></tr>'; return; }
  $('icBody').innerHTML = Object.entries(model.factorIC).map(([g, ic]) => {
    const abs = Math.abs(ic);
    const verdict = abs < 0.02 ? '<span class="chip flat">疑噪声</span>'
      : abs < 0.05 ? `<span class="chip ${ic > 0 ? 'long' : 'short'}">弱有效${ic < 0 ? '（反向）' : ''}</span>`
      : `<span class="chip ${ic > 0 ? 'long' : 'short'}">有效${ic < 0 ? '（反向）' : ''}</span>`;
    return `<tr style="cursor:default">
      <td>${GROUP_NAMES[g] || g}</td>
      <td class="${ic > 0 ? 'up' : 'down'}" style="font-weight:600">${fmtNum(ic, 4)}</td>
      <td>${verdict}</td>
      <td>${model.weights?.[g] != null ? fmtNum(model.weights[g], 4) : '—'}</td>
    </tr>`;
  }).join('');
}

// ---------------- 权重变迁图 ----------------
function renderWeightChart(evo) {
  const el = $('weightChart');
  el.innerHTML = '';
  if (!evo.length) { el.innerHTML = '<div class="placeholder">首次训练后开始出现轨迹（每 6 小时一次）</div>'; return; }
  const chart = LightweightCharts.createChart(el, {
    height: 260,
    layout: { background: { color: 'transparent' }, textColor: '#848e9c' },
    grid: { vertLines: { color: '#1e2329' }, horzLines: { color: '#1e2329' } },
    rightPriceScale: { borderColor: '#2b3139' },
    timeScale: { borderColor: '#2b3139', timeVisible: true },
  });
  // x 轴用训练时间；若多条记录时间相同（本地测试）则退化为版本序号
  const times = evo.map(e => Math.floor(new Date(e.trainedAt).getTime() / 1000));
  const useIndex = new Set(times).size !== times.length;
  const seriesByGroup = {};
  for (const g of GROUP_ORDER) {
    seriesByGroup[g] = chart.addLineSeries({
      color: GROUP_COLORS[g], lineWidth: 2, priceLineVisible: false, lastValueVisible: true,
      title: GROUP_NAMES[g] || g,
    });
  }
  evo.forEach((e, i) => {
    const t = useIndex ? 1600000000 + i * 86400 : times[i];
    for (const g of GROUP_ORDER) {
      if (e.weights && e.weights[g] != null) seriesByGroup[g].update({ time: t, value: e.weights[g] });
    }
  });
  if (useIndex) {
    chart.applyOptions({ timeScale: { tickMarkFormatter: t => 'v' + (Math.round((t - 1600000000) / 86400) + 1) } });
  }
  chart.timeScale().fitContent();
  window.addEventListener('resize', () => chart.applyOptions({ width: el.clientWidth }));
}

// ---------------- 样本外 IC 轨迹 ----------------
function renderICChart(evo) {
  const el = $('icChart');
  el.innerHTML = '';
  if (!evo.length) { el.innerHTML = '<div class="placeholder">首次训练后开始出现轨迹</div>'; return; }
  const chart = LightweightCharts.createChart(el, {
    height: 220,
    layout: { background: { color: 'transparent' }, textColor: '#848e9c' },
    grid: { vertLines: { color: '#1e2329' }, horzLines: { color: '#1e2329' } },
    rightPriceScale: { borderColor: '#2b3139' },
    timeScale: { borderColor: '#2b3139', timeVisible: true },
  });
  const times = evo.map(e => Math.floor(new Date(e.trainedAt).getTime() / 1000));
  const useIndex = new Set(times).size !== times.length;
  const oos = chart.addLineSeries({ color: '#f0b90b', lineWidth: 2, title: '样本外 IC', priceLineVisible: false });
  const ins = chart.addLineSeries({ color: '#848e9c', lineWidth: 1, lineStyle: 2, title: '样本内 IC', priceLineVisible: false });
  evo.forEach((e, i) => {
    const t = useIndex ? 1600000000 + i * 86400 : times[i];
    if (e.icOOS != null) oos.update({ time: t, value: e.icOOS });
    if (e.icInSample != null) ins.update({ time: t, value: e.icInSample });
  });
  if (useIndex) {
    chart.applyOptions({ timeScale: { tickMarkFormatter: t => 'v' + (Math.round((t - 1600000000) / 86400) + 1) } });
  }
  chart.timeScale().fitContent();
  window.addEventListener('resize', () => chart.applyOptions({ width: el.clientWidth }));
}

// ---------------- 训练历史表 ----------------
function renderHistory(evo) {
  if (!evo.length) { $('histBody').innerHTML = '<tr><td colspan="9" style="color:var(--text-dim)">暂无训练记录</td></tr>'; return; }
  $('histBody').innerHTML = evo.slice().reverse().slice(0, 20).map(e => `
    <tr style="cursor:default">
      <td><b>v${e.version}</b></td>
      <td>${new Date(e.trainedAt).toLocaleString()}</td>
      <td>${e.symbols ?? '—'}</td>
      <td>${e.samples ?? '—'}</td>
      <td>${e.icInSample != null ? fmtNum(e.icInSample, 4) : '—'}</td>
      <td class="${e.icOOS > 0.05 ? 'up' : ''}" style="font-weight:600">${e.icOOS != null ? fmtNum(e.icOOS, 4) : '—'}</td>
      <td>${e.tracker?.icNew != null ? fmtNum(e.tracker.icNew, 4) : '—'}</td>
      <td>${e.accepted == null ? '—' : e.accepted ? '<span class="chip long">接受</span>' : '<span class="chip short">拒绝</span>'}</td>
      <td>${e.lsSharpeOOS != null ? fmtNum(e.lsSharpeOOS, 2) : '—'}</td>
    </tr>`).join('');
}

// ---------------- 浏览器信号追踪面板 ----------------
async function renderTracker() {
  const stats = await getStats();
  if (!stats) {
    $('trackerMetrics').innerHTML = '<div class="placeholder" style="grid-column:1/-1;">IndexedDB 不可用（隐私模式？）</div>';
    return;
  }
  if (!stats.total) {
    $('trackerMetrics').innerHTML = '<div class="placeholder" style="grid-column:1/-1;">暂无数据——访问「深度分析」页即开始自动记录信号，24 根 K 线后自动回填实际走势</div>';
    return;
  }
  const cells = [
    { k: '已记录信号', v: stats.total },
    { k: '已回填结果', v: stats.labeled },
    { k: '等待到期', v: stats.pending },
  ];
  for (const src in (stats.byWeightSource || {})) {
    cells.push({ k: `权重来源 ${src}`, v: stats.byWeightSource[src] });
  }
  const ORIGIN_NAMES = { dashboard: '深度分析页', screener: '全市场扫描' };
  for (const src in (stats.byOrigin || {})) {
    const o = stats.byOrigin[src];
    cells.push({
      k: `${ORIGIN_NAMES[src] || src} · T+24胜率`,
      v: `${fmtPct(o.winRate, 1, false)} <small style="color:var(--text-faint)">n=${o.n} · 均 ${fmtPct(o.avgRet, 2)}</small>`,
      cls: o.winRate > 0.52 && o.n >= 20 ? 'good' : o.winRate < 0.48 && o.n >= 20 ? 'bad' : '',
    });
  }
  $('trackerMetrics').innerHTML = cells.map(c => `<div class="metric ${c.cls || ''}"><div class="k">${c.k}</div><div class="v">${c.v}</div></div>`).join('');

  const horizons = [4, 12, 24];
  const dirNames = { long: '做多信号', short: '做空信号', all: '全部' };
  $('trackerTables').innerHTML = `
    <table class="table">
      <thead><tr><th>方向</th>${horizons.map(h => `<th>T+${h}bar 胜率</th><th>T+${h}bar 平均收益</th>`).join('')}</tr></thead>
      <tbody>
        ${['long', 'short', 'all'].map(bucket => {
          const row = stats.byDir[bucket];
          const first = row[horizons[0]];
          if (!first) return `<tr style="cursor:default"><td>${dirNames[bucket]}</td><td colspan="6" style="color:var(--text-dim)">样本不足</td></tr>`;
          return `<tr style="cursor:default"><td>${dirNames[bucket]} <small style="color:var(--text-faint)">n=${first.n}</small></td>`
            + horizons.map(h => {
              const s = row[h];
              if (!s) return '<td>—</td><td>—</td>';
              return `<td class="${s.winRate > 0.52 ? 'up' : s.winRate < 0.48 ? 'down' : ''}">${fmtPct(s.winRate, 1, false)}</td>
                      <td class="${s.avgRet > 0 ? 'up' : 'down'}">${fmtPct(s.avgRet, 2)}</td>`;
            }).join('') + '</tr>';
        }).join('')}
      </tbody>
    </table>
    <div style="font-size:10px;color:var(--text-faint);margin-top:6px;">收益为信号方向调整后的有向收益（做空信号下跌记为盈利）。样本 &lt; 20 时统计意义有限。</div>`;
}

init();
