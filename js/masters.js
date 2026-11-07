import { loadArenaState, MIN_RANK_N } from './lib/arena.js';
import { GROUP_NAMES } from './lib/quant.js';
import { fmtPct, fmtNum, icon } from './lib/ui.js';

const GROUP_ORDER = ['trend', 'momentum', 'meanRev', 'volume', 'volatility', 'position', 'htf', 'futures'];
const IV_NAMES = { '15m': '15 分钟', '1h': '1 小时', '4h': '4 小时', '1d': '日线' };
const state = { masters: [], arena: null, query: '', category: 'all', evidence: 'all', pool: 'all' };
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));

function emptyAgg() { return { n: 0, wins: 0, sum: 0, sumSq: 0, mfeSum: 0, maeSum: 0 }; }
function addAgg(total, agg) {
  if (!agg) return total;
  for (const key of Object.keys(total)) total[key] += Number(agg[key]) || 0;
  return total;
}
function statsFrom(agg) {
  if (!agg.n) return null;
  const meanRet = agg.sum / agg.n;
  const sd = Math.sqrt(Math.max(0, agg.sumSq / agg.n - meanRet * meanRet));
  return { n: agg.n, totalRet: agg.sum, meanRet, winRate: agg.wins / agg.n, tStat: sd ? meanRet / (sd / Math.sqrt(agg.n)) : 0 };
}
function masterPlayers(id) {
  return (state.arena?.players || []).filter(p => p.masterId === id);
}
function careerFor(id) {
  return statsFrom(masterPlayers(id).reduce((agg, p) => addAgg(agg, p.career), emptyAgg()));
}
function evidenceClass(m) { return `evidence-${m.evidenceLevel.charAt(0).toLowerCase()}`; }
function liveStatus(m) {
  if (!m.eligibleForArena) return '<span class="archive-status">仅档案 · 数据不兼容</span>';
  const players = masterPlayers(m.id);
  if (!players.length) return '<span class="waiting-status">等待云端首轮</span>';
  const active = players.filter(p => p.status !== 'retired').length;
  const st = careerFor(m.id);
  if (!st || st.n < MIN_RANK_N) return `<span class="waiting-status">${active} 周期在役 · 样本积累中</span>`;
  if (st.n >= 100 && st.tStat >= 2 && st.meanRet > 0) return '<span class="candidate-status">模拟候选 · 仍需前向验证</span>';
  return `<span class="archive-status">${active} 周期在役 · 未过研究晋级线</span>`;
}
function careerHTML(m) {
  const st = careerFor(m.id);
  if (!st) return '<span class="no-sample">尚无结算样本</span>';
  return `<span class="${st.totalRet >= 0 ? 'up' : 'down'} master-return">${fmtPct(st.totalRet, 2)}</span><span class="master-n">n=${st.n} · t=${fmtNum(st.tStat, 2)}</span>`;
}

function weightsHTML(weights) {
  if (!weights) return '<p class="detail-muted">无可执行权重：该档案因数据维度不兼容而未入池。</p>';
  const max = Math.max(...GROUP_ORDER.map(g => Math.abs(weights[g] || 0)), 0.01);
  return `<div class="master-weights">${GROUP_ORDER.map(g => {
    const value = weights[g] || 0;
    const width = Math.abs(value) / max * 50;
    const style = value >= 0 ? `left:50%;width:${width}%` : `left:${50 - width}%;width:${width}%`;
    return `<div class="master-weight-row"><span>${esc(GROUP_NAMES[g] || g)}</span><div class="master-weight-track"><i class="master-weight-mid"></i><i class="master-weight-fill ${value < 0 ? 'negative' : ''}" style="${style}"></i></div><b>${value >= 0 ? '+' : ''}${value.toFixed(2)}</b></div>`;
  }).join('')}</div>`;
}
function intervalStatsHTML(m) {
  if (!m.eligibleForArena) return '';
  return `<div class="master-intervals">${Object.entries(IV_NAMES).map(([iv, label]) => {
    const players = masterPlayers(m.id).filter(p => p.interval === iv);
    const st = statsFrom(players.reduce((agg, p) => addAgg(agg, p.career), emptyAgg()));
    const active = players.some(p => p.status !== 'retired');
    return `<div><span>${label}</span><b>${st ? fmtPct(st.totalRet, 2) : '—'}</b><small>${st ? `n=${st.n} · t=${fmtNum(st.tStat, 2)}` : active ? '等待结算' : '等待首轮'}</small></div>`;
  }).join('')}</div>`;
}
function detailHTML(m) {
  return `<div class="master-detail-grid">
    <section class="master-detail-main">
      <div class="detail-block"><h4>公开方法与原策略边界</h4><ol>${m.publicRules.map(rule => `<li>${esc(rule)}</li>`).join('')}</ol></div>
      <div class="detail-block translation-block"><h4>本项目的可执行转译</h4><p>${esc(m.translation)}</p></div>
      <div class="detail-block"><h4>为什么可能有效</h4><p>${esc(m.whyItWorks)}</p></div>
      <div class="detail-block failure-block"><h4>失效条件与不可复制部分</h4><ul>${m.failureModes.map(x => `<li>${esc(x)}</li>`).join('')}</ul><p><b>数据需求：</b>${esc(m.dataNeeds)}</p></div>
      <div class="detail-block sources-block"><h4>证据来源</h4>${m.sources.map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}<span>${esc(s.kind)} ↗</span></a>`).join('')}</div>
    </section>
    <aside class="master-detail-side"><h4>八因子研究转译</h4>${weightsHTML(m.weights)}<p class="weight-note">方向评分 = Σ 权重 × 因子；权重绝对值归一化。此处是研究假设，不是交易员本人公式。</p><h4>四周期成本后模拟</h4>${intervalStatsHTML(m)}</aside>
  </div>`;
}

function filteredMasters() {
  const q = state.query.trim().toLowerCase();
  return state.masters.filter(m => {
    const haystack = `${m.name} ${m.alias} ${m.category} ${m.summary} ${m.timeframe}`.toLowerCase();
    return (!q || haystack.includes(q)) &&
      (state.category === 'all' || m.category === state.category) &&
      (state.evidence === 'all' || m.evidenceLevel.startsWith(state.evidence)) &&
      (state.pool === 'all' || (state.pool === 'arena') === m.eligibleForArena);
  });
}
function renderList() {
  const list = filteredMasters();
  $('masterResultCount').textContent = `${list.length} / ${state.masters.length} 位`;
  if (!list.length) {
    $('masterList').innerHTML = '<div class="master-empty">没有符合当前条件的档案。请调整搜索或筛选。</div>';
    return;
  }
  $('masterList').innerHTML = `<div class="master-table" role="table" aria-label="交易员策略档案">
    <div class="master-table-head" role="row"><span>交易员 / 方法</span><span>证据</span><span>云端状态</span><span>累计模拟净收益（非复利）</span></div>
    ${list.map((m, index) => `<div class="master-entry" style="--row-i:${Math.min(index, 12)}">
      <div class="master-row" role="row">
        <button class="master-name" data-master="${esc(m.id)}" aria-expanded="false" aria-controls="detail-${esc(m.id)}"><span class="master-index">${String(state.masters.indexOf(m) + 1).padStart(2, '0')}</span><span><b>${esc(m.name)}</b><small>${esc(m.alias)} · ${esc(m.category)} · ${esc(m.timeframe)}</small><em>${esc(m.summary)}</em></span><i class="row-chevron">⌄</i></button>
        <span class="evidence-badge ${evidenceClass(m)}">${esc(m.evidenceLevel)}</span>
        <span>${liveStatus(m)}</span>
        <span class="master-career">${careerHTML(m)}</span>
      </div>
      <div class="master-detail" id="detail-${esc(m.id)}" hidden></div>
    </div>`).join('')}
  </div>`;
}
function renderMetrics() {
  const eligible = state.masters.filter(m => m.eligibleForArena).length;
  const active = (state.arena?.players || []).filter(p => p.family === 'master' && p.status !== 'retired').length;
  const cells = [
    ['公开证据档案', `${state.masters.length} 位`, '非收益排名'],
    ['数据兼容转译', `${eligible} 位`, '四周期模拟'],
    ['云端周期选手', active ? `${active} 个` : '等待首轮', active ? '真实状态已接入' : `${eligible * 4} 个待生成`],
    ['仅研究档案', `${state.masters.length - eligible} 位`, '数据不足，不伪造执行'],
  ];
  $('masterMetrics').innerHTML = cells.map(([k, v, s]) => `<div class="master-metric"><span>${k}</span><b>${v}</b><small>${s}</small></div>`).join('');
  const updated = state.arena?.updatedAt ? new Date(state.arena.updatedAt).toLocaleString('zh-CN') : '状态暂不可用';
  $('masterCloudNote').textContent = `GitHub Actions 每 15 分钟一个触发槽（调度可能延迟）· 状态更新时间：${updated} · 仅模拟，不下真单`;
}
function render() { renderMetrics(); renderList(); }

function bindControls() {
  $('masterSearch').addEventListener('input', e => { state.query = e.target.value; renderList(); });
  $('masterCategory').addEventListener('change', e => { state.category = e.target.value; renderList(); });
  $('masterEvidence').addEventListener('change', e => { state.evidence = e.target.value; renderList(); });
  $('masterPool').addEventListener('change', e => { state.pool = e.target.value; renderList(); });
  $('masterList').addEventListener('click', e => {
    const button = e.target.closest('[data-master]');
    if (!button) return;
    const detail = $(button.getAttribute('aria-controls'));
    const m = state.masters.find(x => x.id === button.dataset.master);
    const opening = detail.hidden;
    document.querySelectorAll('.master-detail:not([hidden])').forEach(el => { el.hidden = true; });
    document.querySelectorAll('.master-name[aria-expanded="true"]').forEach(el => { el.setAttribute('aria-expanded', 'false'); });
    if (opening) {
      detail.innerHTML = detailHTML(m);
      detail.hidden = false;
      button.setAttribute('aria-expanded', 'true');
    }
  });
}

export async function initMasterArchive() {
  bindControls();
  try {
    const response = await fetch('data/masters.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`masters.json HTTP ${response.status}`);
    state.masters = await response.json();
    if (state.masters.length !== 50) throw new Error('档案数量不是 50');
    const categories = [...new Set(state.masters.map(m => m.category))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    $('masterCategory').innerHTML = '<option value="all">全部策略族</option>' + categories.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    render();
  } catch (error) {
    $('masterList').innerHTML = `<div class="master-empty">策略档案读取失败：${esc(error.message)}</div>`;
    return;
  }
  try {
    state.arena = await loadArenaState();
    render();
  } catch (error) {
    $('masterCloudNote').textContent = '云端状态暂不可用；公开档案仍可浏览，模拟数据未填造。';
  }
}
