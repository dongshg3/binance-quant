// ============================================================
// evolution.js · 模型进化页：学习轨迹可视化 + 信号追踪面板
// ============================================================
import { GROUP_NAMES } from './lib/quant.js';
import { getStats, exportCSV } from './lib/tracker.js';
import { renderNav, setNet, fmtPct, fmtNum, disclaimerHTML, icon, swapHTML } from './lib/ui.js';

renderNav('evolution');
document.getElementById('disclaimerSlot').innerHTML = disclaimerHTML();
const $ = id => document.getElementById(id);

const GROUP_COLORS = {
  trend: '#2563eb', momentum: '#7c3aed', meanRev: '#16a34a',
  volume: '#0891b2', volatility: '#dc2626', position: '#d97706', htf: '#db2777', futures: '#64748b',
};
const GROUP_ORDER = ['trend', 'momentum', 'meanRev', 'volume', 'volatility', 'position', 'htf', 'futures'];

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
  renderDiagnostics(model);
  renderInfoTests(model);
  renderSegments(model);
  renderEtExperiments(model);
  renderCoinModels(model);
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
    { k: '横截面 IC（选币能力）', v: model.oos?.icXS != null ? fmtNum(model.oos.icXS, 4) : '—', cls: model.oos?.icXS > 0.02 ? 'good' : model.oos?.icXS < 0 ? 'bad' : '' },
    { k: '单币种 IC（择时能力）', v: model.oos?.icPerSymbolMean != null ? `${fmtNum(model.oos.icPerSymbolMean, 4)} <small style="color:var(--text-faint)">中位 ${fmtNum(model.oos.icPerSymbolMedian, 4)}</small>` : '—', cls: model.oos?.icPerSymbolMean > 0.05 ? 'good' : '' },
    { k: '混合 IC（仅参考）', v: model.oos?.ic != null ? fmtNum(model.oos.ic, 4) : '—' },
    { k: '样本内外差距', v: model.oos?.gapInOut != null ? fmtNum(model.oos.gapInOut, 4) : '—', cls: model.oos?.gapInOut > 0.05 ? 'bad' : model.oos?.gapInOut < 0.02 ? 'good' : '' },
    { k: 'XS IC 显著性 (NW t)', v: model.oos?.nwT != null ? fmtNum(model.oos.nwT, 2) : '—', cls: model.oos?.nwT >= 2 ? 'good' : model.oos?.nwT != null ? 'bad' : '' },
    { k: '预测视野', v: model.fwdSet ? `T+${model.fwdSet.join('/')} bar` : `T+${model.fwdBars ?? 12} bar` },
  ];
  // 逐币模型计数（v9+ 引擎）
  if (model.coinModels && typeof model.coinModels === 'object') {
    const cn = Object.keys(model.coinModels).length;
    if (cn > 0) {
      const ics = Object.values(model.coinModels).map(v => v.ic).filter(v => v != null);
      const meanIc = ics.length ? ics.reduce((a, b) => a + b, 0) / ics.length : null;
      cells.push({
        k: '逐币独立模型',
        v: `${cn} 个已启用 <small style="color:var(--text-faint)">IC 均 ${meanIc != null ? fmtNum(meanIc, 4) : '—'}</small>`,
        cls: 'good',
      });
    }
  }
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
      v: model.accepted !== false ? `${icon('check')} 本次已接受` : `${icon('x')} 已拒绝`,
      cls: model.accepted !== false ? 'good' : 'bad',
    });
    if (model.accepted === false && model.rejectReason) {
      cells.push({ k: '拒绝原因', v: `<small>${model.rejectReason}</small>`, cls: 'bad' });
    }
  }
  $('modelSub').textContent = `GitHub Actions 每 6 小时自动重训并发布 · 前端打开即用最新权重`;
  $('modelMetrics').innerHTML = cells.map(c => `<div class="metric ${c.cls || ''}"><div class="k">${c.k}</div><div class="v">${c.v}</div></div>`).join('')
    + `<div style="grid-column:1/-1;font-size:10px;color:var(--text-faint);line-height:1.6;">口径说明：横截面 IC = 同一时间戳内对币种排序的相关性（选币能力，诚实天花板约 0.05）；单币种 IC = 各币种内部时间序列相关的均值（择时能力）；混合 IC 把所有币种混在一起，会被同涨同跌严重虚增，仅作参考。样本内外差距 &gt; 0.05 提示过拟合。</div>`;
}

// ---------------- 过拟合诊断面板 ----------------
function renderDiagnostics(model) {
  const el = $('diagContent');
  const dg = model && model.diagnostics;
  if (!dg) { el.innerHTML = '<div class="placeholder">等待 v5+ 模型产出诊断数据（下次云端训练后自动出现）</div>'; return; }
  // IC 衰减表
  const decay = dg.icDecay || {};
  const hs = Object.keys(decay).map(Number).sort((a, b) => a - b);
  const decayCells = hs.map(h => {
    const v = decay[h];
    const prev = hs.indexOf(h) > 0 ? decay[hs[hs.indexOf(h) - 1]] : null;
    const collapsing = prev != null && v < prev * 0.5;
    return `<td class="${v > 0.02 ? 'up' : v < 0 ? 'down' : ''}" ${collapsing ? 'style="background:rgba(246,70,93,.08)"' : ''}>${fmtNum(v, 3)}</td>`;
  }).join('');
  const decayVerdict = (() => {
    const first = decay[hs[0]], last = decay[hs[hs.length - 1]];
    if (first == null || last == null) return '';
    if (last <= 0) return '<span class="chip short">信号寿命短：长视野归零，仅适合短线择时</span>';
    if (last >= first * 0.5) return '<span class="chip long">衰减缓慢：存在较持久的预测能力</span>';
    return '<span class="chip range">中等衰减：信号集中在短视野</span>';
  })();
  const ps = dg.perSymbol || {};
  const rc = dg.randomIC || {};
  const randCls = rc.percentile >= 0.9 ? 'long' : rc.percentile >= 0.5 ? 'range' : 'short';
  el.innerHTML = `
    <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">① IC 衰减曲线（同一模型对不同预测视野的样本外相关）</div>
    <table class="table">
      <thead><tr>${hs.map(h => `<th>T+${h} bar</th>`).join('')}<th>判定</th></tr></thead>
      <tbody><tr style="cursor:default">${decayCells}<td>${decayVerdict}</td></tr></tbody>
    </table>
    <div style="font-size:12px;color:var(--text-dim);margin:14px 0 6px;">② 单币种 IC 分布（各币种独立计算，揭露个别币种是否拉抬整体）</div>
    <div class="grid-metrics">
      <div class="metric ${ps.mean > 0.05 ? 'good' : ''}"><div class="k">均值</div><div class="v">${fmtNum(ps.mean, 4)}</div></div>
      <div class="metric"><div class="k">中位数</div><div class="v">${fmtNum(ps.median, 4)}</div></div>
      <div class="metric ${ps.worst < 0 ? 'bad' : ''}"><div class="k">最差币种</div><div class="v">${fmtNum(ps.worst, 4)}</div></div>
      <div class="metric"><div class="k">最好币种</div><div class="v">${fmtNum(ps.best, 4)}</div></div>
    </div>
    <div style="font-size:12px;color:var(--text-dim);margin:14px 0 6px;">③ 随机基准对照（200 组随机权重，真模型必须显著超越才算学到东西）</div>
    <div class="grid-metrics">
      <div class="metric"><div class="k">随机 IC 均值 ± σ</div><div class="v">${fmtNum(rc.mean, 4)} ± ${fmtNum(rc.std, 4)}</div></div>
      <div class="metric ${randCls === 'long' ? 'good' : randCls === 'short' ? 'bad' : ''}"><div class="k">真模型分位</div><div class="v">${rc.percentile != null ? fmtPct(rc.percentile, 1, false) : '—'}</div></div>
      <div class="metric"><div class="k">横截面时间桶</div><div class="v">${dg.xsBuckets ?? '—'}</div></div>
      <div class="metric"><div class="k">Purged 缓冲 (embargo)</div><div class="v">${dg.embargo ?? '—'} bar</div></div>
    </div>
    <div style="font-size:10px;color:var(--text-faint);margin-top:10px;line-height:1.6;">
      判定标准：真模型分位 &lt; 90% 意味着与随机权重无显著差异（学习无效）；单币种最差值为负属正常，但均值必须显著为正；IC 在 T+1 高而 T+4 暴跌 = 捕捉的是微观噪声而非信号。
    </div>`;
}

// ---------------- 信息存在性检验 ----------------
function renderInfoTests(model) {
  const el = $('infoContent');
  const dg = model && model.diagnostics;
  if (!dg || !dg.dcor) { el.innerHTML = '<div class="placeholder">等待 v8+ 模型产出检验数据（下次云端训练后自动出现）</div>'; return; }

  // ① dCor 表
  const dcorRows = Object.entries(dg.dcor).map(([g, r]) => {
    const name = g === '_composite' ? '综合评分' : (GROUP_NAMES[g] || g);
    const sig = r.p <= 0.05;
    return `<tr style="cursor:default">
      <td>${name}</td>
      <td style="font-weight:600" class="${r.dcor > 0.1 ? 'up' : ''}">${fmtNum(r.dcor, 4)}</td>
      <td class="${sig ? 'up' : 'down'}">${fmtNum(r.p, 3)}</td>
      <td>${sig ? '<span class="chip long">存在依赖</span>' : '<span class="chip short">未发现依赖</span>'}</td>
    </tr>`;
  }).join('');

  // ② 条件 IC 表
  const COND_NAMES = { byAdx: '按 ADX 分桶', byVol: '按波动率分桶', byFunding: '按资金费率分桶' };
  const condRows = Object.entries(dg.conditionalIC || {}).map(([k, buckets]) => {
    const cells = ['低', '中', '高'].map(lab => {
      const v = buckets[lab];
      return `<td class="${v > 0.02 ? 'up' : v < -0.02 ? 'down' : ''}">${v != null ? fmtNum(v, 4) : '—'}</td>`;
    }).join('');
    // 齐性直觉：桶间差异大 = 信息是条件存在的
    const vals = ['低', '中', '高'].map(l => buckets[l]).filter(v => v != null);
    const spreadV = vals.length >= 2 ? Math.max(...vals) - Math.min(...vals) : null;
    const verdict = spreadV == null ? '<span class="chip flat">样本不足</span>'
      : spreadV > 0.05 ? '<span class="chip long">条件差异显著</span>' : '<span class="chip flat">各状态差异小</span>';
    return `<tr style="cursor:default"><td>${COND_NAMES[k] || k}</td>${cells}<td>${verdict}</td></tr>`;
  }).join('');

  const nwT = model.oos?.nwT;
  el.innerHTML = `
    <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">① 距离相关 dCor（Székely 2007）：dCor=0 当且仅当统计独立 —— 线性 IC≈0 时回答"信息是否藏在线性够不到的地方"</div>
    <table class="table">
      <thead><tr><th>因子组</th><th>dCor</th><th>置换检验 p 值</th><th>判定</th></tr></thead>
      <tbody>${dcorRows}</tbody>
    </table>
    <div style="font-size:12px;color:var(--text-dim);margin:14px 0 6px;">② 条件 IC（按市场状态 tercile 切桶）：无条件 IC≈0 但某桶显著 ≠0 ⇒ 信息只在特定状态存在</div>
    <table class="table">
      <thead><tr><th>状态变量</th><th>低桶</th><th>中桶</th><th>高桶</th><th>齐性判定</th></tr></thead>
      <tbody>${condRows}</tbody>
    </table>
    <div style="font-size:10px;color:var(--text-faint);margin-top:10px;line-height:1.7;">
      判读：dCor 全表 p &gt; 0.05 ⇒ 这套因子在当前市场没有可提取的信息（换信息源，不是换模型）；某状态桶 IC 显著 ⇒ 该状态下信号才可信，应配合状态过滤使用。当前 XS IC 的 Newey-West t = <b>${nwT != null ? fmtNum(nwT, 2) : '—'}</b>（|t| ≥ 2 才算统计显著）。
    </div>`;
}

// ---------------- 分段专业化模型 ----------------
function renderSegments(model) {
  const el = $('segContent');
  const segs = model && model.segments;
  if (!segs || !Object.keys(segs).length) { el.innerHTML = '<div class="placeholder">等待 v8+ 模型产出分段数据（下次云端训练后自动出现）</div>'; return; }
  const SEG_LABEL = { size: '规模', cat: '板块' };
  const CAT_CN = { major: '主流大盘', l1: '一层公链', l2: '二层网络', defi: 'DeFi', meme: '模因币', ai: 'AI', gaming: '游戏', infra: '基础设施', other: '其他' };
  const SIZE_CN = { large: '大盘', mid: '中盘', small: '小盘' };
  const rows = Object.entries(segs).map(([k, s]) => {
    const [kind, val] = k.split(':');
    const name = kind === 'size' ? SIZE_CN[val] || val : CAT_CN[val] || val;
    const good = s.good;
    const flipped = s.flipped;
    const usage = good && flipped ? '<span class="chip trend">反向启用</span>'
      : good ? '<span class="chip long">已启用</span>'
      : '<span class="chip flat">观察中·用全局</span>';
    const mt = s.modelType === 'et-distilled' ? ' <small class="chip range" title="非线性 ExtraTrees 对照实验胜出，知识蒸馏回线性权重">ET蒸馏</small>' : '';
    return `<tr style="cursor:default" class="${good ? '' : ''}">
      <td><b>${name}</b> <span style="color:var(--text-faint);font-size:10px;">${SEG_LABEL[kind]}</span>${mt}</td>
      <td>${s.symbols}</td>
      <td>${(s.n / 1000).toFixed(0)}k</td>
      <td class="${s.icXS >= 0.015 ? 'up' : s.icXS < 0 ? 'down' : ''}" style="font-weight:600">${s.icXS != null ? fmtNum(s.icXS, 4) : '—'}</td>
      <td class="${Math.abs(s.nwT ?? 0) >= 1.5 ? 'up' : ''}">${s.nwT != null ? fmtNum(s.nwT, 2) : '—'}</td>
      <td>${usage}</td>
    </tr>`;
  }).join('');
  el.innerHTML = `
    <table class="table">
      <thead><tr><th>分段</th><th>币种数</th><th>训练样本</th><th>横截面 IC</th><th>NW t</th><th>前端使用</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="font-size:10px;color:var(--text-faint);margin-top:8px;line-height:1.7;">
      启用标准：|段内横截面 IC| ≥ 0.015 且 |NW t| ≥ 1.5。IC 显著为正 → 正向启用；IC 显著为负 → <b>反向启用</b>（权重取负使用，反向信号与正向信号等价有效，如 L1 公链板块）；
      不显著 → 回退全局权重，宁缺毋滥。
      前端评分页每个币种按「逐币模型 &gt; 板块分段 &gt; 规模分段 &gt; 全局」的优先级选用权重，模型徽标会显示当前生效的分段。
    </div>`;
}

// ---------------- 非线性对照实验（ExtraTrees + 知识蒸馏） ----------------
function renderEtExperiments(model) {
  const el = $('etContent');
  const exps = model && model.etExperiments;
  if (!exps || !Object.keys(exps).length) { el.innerHTML = '<div class="placeholder">等待 v9+ 模型产出对照实验数据（下次云端训练后自动出现）</div>'; return; }
  const NAME_CN = { global: '全局', 'size:large': '大盘', 'size:mid': '中盘', 'size:small': '小盘', 'cat:l1': 'L1 公链', 'cat:l2': 'L2 网络', 'cat:defi': 'DeFi', 'cat:meme': '模因币', 'cat:ai': 'AI', 'cat:gaming': '游戏', 'cat:infra': '基础设施', 'cat:other': '其他板块', 'cat:major': '主流大盘' };
  const rows = Object.entries(exps).map(([k, r]) => {
    const verdict = r.adopted ? '<span class="chip long">采纳·蒸馏上线</span>' : '<span class="chip flat">保留 Ridge</span>';
    return `<tr style="cursor:default">
      <td><b>${NAME_CN[k] || k}</b></td>
      <td>${r.folds} 折</td>
      <td class="${r.ridge > 0.015 ? 'up' : ''}">${fmtNum(r.ridge, 4)}</td>
      <td class="${r.et > r.ridge + 0.005 ? 'up' : r.et < r.ridge - 0.005 ? 'down' : ''}" style="font-weight:600">${fmtNum(r.et, 4)}</td>
      <td class="${r.distilled > r.ridge + 0.005 ? 'up' : ''}">${fmtNum(r.distilled, 4)}</td>
      <td class="${r.improvement > 0.005 ? 'up' : r.improvement < -0.005 ? 'down' : ''}">${r.improvement > 0 ? '+' : ''}${fmtNum(r.improvement, 4)}</td>
      <td>${verdict}</td>
    </tr>`;
  }).join('');
  el.innerHTML = `
    <table class="table">
      <thead><tr><th>目标</th><th>Purged 折</th><th>Ridge IC</th><th>ExtraTrees IC</th><th>蒸馏后 IC</th><th>Δ (ET−Ridge)</th><th>判定</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="font-size:10px;color:var(--text-faint);margin-top:8px;line-height:1.7;">
      采纳标准（实验说了算，非理论预设）：Δ &gt; 0.01 <b>且</b> 蒸馏后 IC 仍比 Ridge 高 0.005 以上。
      采纳时不直接把树模型搬上前端，而是做<b>知识蒸馏</b>：用 ExtraTrees 在训练集上的预测再拟合一个 Ridge，把非线性行为压缩成等效线性权重——前端零改动即可使用。
      大部分目标保留 Ridge 是正常且诚实的结果：样本量不足以支撑非线性模型的方差代价时，强行上树只会过拟合。
    </div>`;
}

// ---------------- 逐币独立模型 ----------------
function renderCoinModels(model) {
  const el = $('coinContent');
  const coins = model && model.coinModels;
  if (!coins || !Object.keys(coins).length) { el.innerHTML = '<div class="placeholder">等待 v9+ 模型产出逐币模型数据（下次云端训练后自动出现）</div>'; return; }
  const list = Object.entries(coins).sort((a, b) => (b[1].ic ?? 0) - (a[1].ic ?? 0));
  const meanIc = list.reduce((s, [, v]) => s + (v.ic ?? 0), 0) / list.length;
  const posN = list.filter(([, v]) => (v.ic ?? 0) > 0).length;
  const rows = list.map(([sym, v]) => {
    const base = sym.replace(/USDT$/, '');
    return `<tr style="cursor:default">
      <td><b>${base}</b></td>
      <td class="${v.ic >= 0.04 ? 'up' : ''}" style="font-weight:600">${fmtNum(v.ic, 4)}</td>
      <td class="${Math.abs(v.t ?? 0) >= 2 ? 'up' : ''}">${v.t != null ? fmtNum(v.t, 2) : '—'}</td>
      <td>${v.n ?? '—'}</td>
    </tr>`;
  }).join('');
  el.innerHTML = `
    <div class="grid-metrics" style="margin-bottom:10px;">
      <div class="metric good"><div class="k">已启用逐币模型</div><div class="v">${list.length} 个</div></div>
      <div class="metric ${meanIc > 0.04 ? 'good' : ''}"><div class="k">样本外 IC 均值</div><div class="v">${fmtNum(meanIc, 4)}</div></div>
      <div class="metric"><div class="k">IC 为正占比</div><div class="v">${fmtPct(posN / list.length, 1, false)}</div></div>
    </div>
    <div style="max-height:320px;overflow:auto;">
      <table class="table">
        <thead><tr><th>币种</th><th>样本外 IC</th><th>t 值</th><th>测试样本</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div style="font-size:10px;color:var(--text-faint);margin-top:8px;line-height:1.7;">
      采纳标准：训练样本 ≥ 1500、测试样本 ≥ 400、IC ≥ 0.04 且 t ≥ 2。
      逐币权重与父分段（板块/规模）做 50/50 收缩融合，避免单币小样本过拟合；未通过门槛的币种自动使用分段或全局权重。
    </div>`;
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
        <span class="val">${fmtNum(lw, 3)} <small style="color:var(--text-faint)">vs ${fmtNum(sw, 2)}</small> <small class="${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}">${icon(delta >= 0 ? 'trendUp' : 'trendDown')}${Math.abs(delta).toFixed(2)}</small></span>
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
    layout: { background: { color: 'transparent' }, textColor: '#5b6472' },
    grid: { vertLines: { color: '#eef0f4' }, horzLines: { color: '#eef0f4' } },
    rightPriceScale: { borderColor: '#d8dee7' },
    timeScale: { borderColor: '#d8dee7', timeVisible: true },
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
    layout: { background: { color: 'transparent' }, textColor: '#5b6472' },
    grid: { vertLines: { color: '#eef0f4' }, horzLines: { color: '#eef0f4' } },
    rightPriceScale: { borderColor: '#d8dee7' },
    timeScale: { borderColor: '#d8dee7', timeVisible: true },
  });
  const times = evo.map(e => Math.floor(new Date(e.trainedAt).getTime() / 1000));
  const useIndex = new Set(times).size !== times.length;
  const oos = chart.addLineSeries({ color: '#2563eb', lineWidth: 2, title: '横截面 IC', priceLineVisible: false });
  const ps = chart.addLineSeries({ color: '#16a34a', lineWidth: 2, title: '单币种 IC', priceLineVisible: false });
  const ins = chart.addLineSeries({ color: '#94a3b8', lineWidth: 1, lineStyle: 2, title: '混合 IC(参考)', priceLineVisible: false });
  evo.forEach((e, i) => {
    const t = useIndex ? 1600000000 + i * 86400 : times[i];
    const xs = e.icXS ?? null;
    if (xs != null) oos.update({ time: t, value: xs });
    if (e.icPerSym != null) ps.update({ time: t, value: e.icPerSym });
    if (e.icOOS != null) ins.update({ time: t, value: e.icOOS });
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
      <td class="${(e.icXS ?? 0) > 0.02 ? 'up' : (e.icXS ?? 0) < 0 ? 'down' : ''}" style="font-weight:600">${e.icXS != null ? fmtNum(e.icXS, 4) : '—'}</td>
      <td class="${(e.icPerSym ?? 0) > 0.05 ? 'up' : ''}">${e.icPerSym != null ? fmtNum(e.icPerSym, 4) : '—'}</td>
      <td style="color:var(--text-dim)">${e.icOOS != null ? fmtNum(e.icOOS, 4) : '—'}</td>
      <td>${e.tracker?.icNew != null ? fmtNum(e.tracker.icNew, 4) : '—'}</td>
      <td>${e.accepted == null ? '—' : e.accepted ? '<span class="chip long">接受</span>' : '<span class="chip short">拒绝</span>'}</td>
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
