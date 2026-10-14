// ============================================================
// arena.js（页面）· 策略竞技场：云端状态展示 + 选手详情
// 引擎在云端（GitHub Actions 每 30 分钟），本页只读 data/arena/state.json
// ============================================================
import { ARENA_INTERVALS, FAMILIES, FEE_RT, getArenaState, getChampionSignals, getPlayerDetail } from './lib/arena.js';
import { loadTickers } from './lib/api.js';
import { GROUP_NAMES } from './lib/quant.js';
import { renderNav, setNet, fmtPct, fmtNum, fmtTime, disclaimerHTML, icon, goDashboard, clsBySign } from './lib/ui.js';

renderNav('arena');
document.getElementById('disclaimerSlot').innerHTML = disclaimerHTML();
const $ = id => document.getElementById(id);

const IV_NAMES = { '15m': '15 分钟', '1h': '1 小时', '4h': '4 小时', '1d': '日线' };
const CTRL_TAGS = { random: '对照', staticRef: '对照', learned: '云端', coin: '逐币' };
const CONTROL = new Set(Object.keys(CTRL_TAGS));
const GROUP_ORDER = ['trend', 'momentum', 'meanRev', 'volume', 'volatility', 'position', 'htf', 'futures'];

function statLine(st) {
  if (!st || !st.n) return '<span style="color:var(--text-faint)">样本积累中</span>';
  const cls = st.meanRet > 0 ? 'up' : st.meanRet < 0 ? 'down' : '';
  return `<span class="${cls}" style="font-weight:600;">${fmtPct(st.totalRet, 2)}</span>
    <span style="color:var(--text-dim)"> · 胜率 ${fmtPct(st.winRate, 0, false)} · t=${fmtNum(st.tStat, 2)} · n=${st.n}</span>`;
}

// 现价缓存（60 秒）：用于持仓浮动盈亏
let tkCache = { time: 0, map: null };
async function getTickers() {
  if (tkCache.map && Date.now() - tkCache.time < 60000) return tkCache.map;
  try {
    tkCache = { time: Date.now(), map: await loadTickers('futures') };
  } catch (e) { /* 保留旧缓存 */ }
  return tkCache.map || {};
}

// ---------------- 选手详情 ----------------
function weightsHTML(w) {
  const maxAbs = Math.max(0.05, ...GROUP_ORDER.map(g => Math.abs(w[g] || 0)));
  const rows = GROUP_ORDER.map(g => {
    const v = w[g] || 0;
    const pct = Math.abs(v) / maxAbs * 50;
    const pos = v >= 0;
    const style = pos ? `left:50%;width:${pct}%;background:var(--accent);`
                      : `left:${50 - pct}%;width:${pct}%;background:var(--down,#dc2626);`;
    return `<div class="wbar-row">
      <span class="wbar-name">${GROUP_NAMES[g] || g}</span>
      <span class="wbar-track"><span class="wbar-center"></span><span class="wbar-fill" style="${style}"></span></span>
      <span class="wbar-val">${v >= 0 ? '+' : ''}${v.toFixed(3)}</span>
    </div>`;
  }).join('');
  return rows;
}

function positionRows(list, tickers, showEntry) {
  if (!list.length) return '<div style="font-size:11px;color:var(--text-faint);padding:4px 0;">空仓</div>';
  return list.slice(0, 10).map(s => {
    const base = s.symbol.replace('USDT', '');
    const dir = s.direction === 'long' ? 1 : -1;
    const px = tickers[s.symbol] && tickers[s.symbol].price;
    let pnl = '';
    if (showEntry && s.entryPrice && px) {
      const gross = dir * (px - s.entryPrice) / s.entryPrice;
      pnl = `<span class="${clsBySign(gross)}" style="font-weight:600;">${fmtPct(gross, 2)}</span>`;
    }
    return `<div class="pos-row">
      <span><b>${base}</b> <span class="${s.direction === 'long' ? 'up' : 'down'}">${s.direction === 'long' ? '多' : '空'}</span></span>
      <span style="color:var(--text-dim)">${s.entryPrice ? `入场 ${fmtNum(s.entryPrice, 4)}` : '待入场'}</span>
      ${pnl}
      <span style="color:var(--text-faint);font-size:10px;">${fmtTime(s.signalBarTime)}</span>
    </div>`;
  }).join('') + (list.length > 10 ? `<div style="font-size:10px;color:var(--text-faint);padding-top:4px;">…另有 ${list.length - 10} 条</div>` : '');
}

function recentRows(list) {
  if (!list.length) return '<div style="font-size:11px;color:var(--text-faint);padding:4px 0;">尚无已结算操作</div>';
  return list.map(s => {
    const base = s.symbol.replace('USDT', '');
    const result = s.status === 'invalid'
      ? '<span style="color:var(--text-faint)">失效</span>'
      : `<span class="${clsBySign(s.netReturn)}" style="font-weight:600;">${fmtPct(s.netReturn, 2)}</span>`;
    return `<div class="pos-row">
      <span><b>${base}</b> <span class="${s.direction === 'long' ? 'up' : 'down'}">${s.direction === 'long' ? '多' : '空'}</span></span>
      ${result}
      <span style="color:var(--text-faint);font-size:10px;">${fmtTime(s.signalBarTime)}</span>
    </div>`;
  }).join('');
}

function lineageHTML(lineage, children) {
  const nodes = lineage.map(p => {
    const cls = ['lg-node', p.id === lineage[lineage.length - 1].id ? 'me' : '', p.status === 'retired' ? 'dead' : ''].join(' ');
    return `<span class="${cls}" title="${p.retiredReason || ''}">${p.familyName} g${p.generation}</span>`;
  }).join('<span class="lg-arrow">→</span>');
  const childTxt = children.length
    ? `<span class="lg-arrow">→</span>` + children.map(c =>
        `<span class="lg-node ${c.status === 'retired' ? 'dead' : ''}">${c.familyName} g${c.generation}${c.status === 'retired' ? '' : '（在役）'}</span>`).join('')
    : '';
  return `<div class="lineage">${nodes}${childTxt}</div>`;
}

async function detailHTML(playerId) {
  const [d, tickers] = await Promise.all([getPlayerDetail(playerId), getTickers()]);
  if (!d) return '<div style="padding:8px;font-size:11px;color:var(--text-faint);">选手数据缺失</div>';
  const p = d.player;
  const cs = p.stats || {};
  const ss = p.seasonStats || {};
  const modelTag = p.modelTrainedAt ? `<div style="font-size:10px;color:var(--text-faint);margin-top:6px;">跟随模型版本 ${String(p.modelTrainedAt).slice(0, 16).replace('T', ' ')}</div>` : '';
  return `<div class="pd-grid">
    <div class="pd-box">
      <h5>${icon('sliders')} 策略权重 · 视野 ${p.params.horizon}bar · 入场阈值 ${p.params.entryThreshold.toFixed(2)}</h5>
      ${weightsHTML(p.weights)}${modelTag}
    </div>
    <div class="pd-box">
      <h5>${icon('chartLine')} 战绩</h5>
      <div style="font-size:11px;line-height:2;">
        生涯：${statLine(cs)}<br>
        本赛季：${statLine(ss)}<br>
        <span style="color:var(--text-dim)">平均最大浮盈 ${fmtPct(cs.mfeAvg, 2)} · 平均最大浮亏 ${fmtPct(cs.maeAvg, 2)} · 手续费滑点 ${fmtPct(FEE_RT, 2)}/笔</span>
      </div>
      <h5 style="margin-top:10px;">${icon('refresh')} 迭代谱系</h5>
      ${lineageHTML(d.lineage, d.children)}
    </div>
    <div class="pd-box">
      <h5>${icon('activity')} 当前持仓（${d.openPositions.length}）· 浮动盈亏按现价估算</h5>
      ${positionRows(d.openPositions, tickers, true)}
      ${d.pendingEntry.length ? `<h5 style="margin-top:10px;">${icon('history')} 待入场（${d.pendingEntry.length}）</h5>${positionRows(d.pendingEntry, tickers, false)}` : ''}
    </div>
    <div class="pd-box">
      <h5>${icon('clipboard')} 最近操作</h5>
      ${recentRows(d.recent)}
    </div>
  </div>`;
}

// 展开 / 收起选手详情（单展开，平滑形变过渡）
function bindPlayerRows() {
  document.querySelectorAll('tr.player-row').forEach(row => {
    row.addEventListener('click', async () => {
      const pid = row.dataset.pid;
      const detailRow = row.nextElementSibling;
      const wrap = detailRow && detailRow.classList.contains('pd-row') ? detailRow.querySelector('.pd-wrap') : null;
      if (!wrap) return;
      const isOpen = wrap.classList.contains('open');
      // 收起其他
      document.querySelectorAll('.pd-wrap.open').forEach(w => {
        w.classList.remove('open');
        w.closest('tr').previousElementSibling && w.closest('tr').previousElementSibling.classList.remove('expanded');
      });
      if (isOpen) { row.classList.remove('expanded'); return; }
      row.classList.add('expanded');
      wrap.classList.add('open');
      const content = wrap.querySelector('.pd-content');
      if (!content.dataset.loaded) {
        content.innerHTML = '<div style="padding:10px;font-size:11px;color:var(--text-faint);">读取选手详情…</div>';
        content.innerHTML = await detailHTML(pid);
        content.dataset.loaded = '1';
      }
    });
  });
}

// ---------------- 渲染 ----------------
async function render() {
  const state = await getArenaState();
  const totalPlayers = Object.values(state.intervals).reduce((a, x) => a + x.players.length, 0);
  const cells = [
    { k: '在役选手', v: totalPlayers },
    { k: '累计模拟信号', v: state.totalSignals },
    { k: '已完成赛季', v: state.seasons.length },
    { k: '扫描币种池', v: `${state.symbols.length} 个 · 4 周期` },
  ];
  $('arenaMetrics').innerHTML = cells.map(c => `<div class="metric"><div class="k">${c.k}</div><div class="v">${c.v}</div></div>`).join('');

  // 云端运行状态
  const cs = $('cloudStatus');
  if (state.updatedAt) {
    const agoMin = Math.max(0, Math.round((Date.now() - new Date(state.updatedAt).getTime()) / 60000));
    cs.textContent = `云端引擎每 30 分钟自动运行 · 上次更新 ${agoMin} 分钟前 · 不开网站也持续运行`;
  } else {
    cs.textContent = '云端引擎尚未产出状态（等待首轮运行）';
  }

  // 四周期选手池
  $('poolPanels').innerHTML = Object.keys(ARENA_INTERVALS).map(iv => {
    const blk = state.intervals[iv];
    const cfg = ARENA_INTERVALS[iv];
    const seasonPct = Math.min(100, (Date.now() - blk.seasonStart) / cfg.seasonMs * 100);
    const pctTxt = seasonPct < 10 ? seasonPct.toFixed(1) : seasonPct.toFixed(0);
    const elapsedD = (Date.now() - blk.seasonStart) / 864e5;
    const seasonD = cfg.seasonMs / 864e5;
    const rows = blk.players.map((p, i) => {
      const isCtrl = CONTROL.has(p.family);
      const champ = p.isChampion ? `<span class="chip trend" style="padding:1px 7px;">${icon('crown')}冠军</span>` : '';
      const ctrlTag = isCtrl ? `<span class="chip ${p.family === 'learned' || p.family === 'coin' ? 'trend' : 'flat'}" style="padding:1px 7px;">${CTRL_TAGS[p.family]}</span>` : '';
      return `<tr class="player-row ${isCtrl ? 'row-control' : ''}" data-pid="${p.id}">
        <td style="color:var(--text-faint)">${i + 1}</td>
        <td><b>${p.familyName}</b> <span style="color:var(--text-faint);font-size:10px;">g${p.generation}</span> ${champ}${ctrlTag}</td>
        <td>${statLine(p.stats)}</td>
        <td style="color:var(--text-dim);font-size:11px;">视野 ${p.params.horizon}bar · 阈值 ${p.params.entryThreshold.toFixed(2)}</td>
      </tr>
      <tr class="pd-row"><td colspan="4" style="padding:0;border:none;"><div class="pd-wrap"><div class="pd-inner"><div class="pd-content"></div></div></div></td></tr>`;
    }).join('');
    const randomRank = blk.players.findIndex(p => p.family === 'random') + 1;
    const verdict = blk.players.length && blk.players[0].stats.n >= 8
      ? (randomRank > 0 && randomRank <= 3
        ? `<span class="chip short">${icon('alert')} 随机组第 ${randomRank} 名 · 当前周期 alpha 存疑</span>`
        : `<span class="chip long">${icon('check')} 随机组第 ${randomRank || '—'} 名 · 最优策略暂时超越噪声</span>`)
      : `<span class="chip flat">样本不足 8 笔，排名暂无统计意义</span>`;
    return `
    <div class="panel" style="margin-bottom:14px;">
      <h3>${icon('layers')} ${IV_NAMES[iv]}周期 <span class="sub">赛季进度 ${pctTxt}% · 已进行 ${elapsedD.toFixed(1)} / ${seasonD.toFixed(0)} 天 · 待结算 ${blk.pending} · 已结算 ${blk.filled}</span></h3>
      <div style="height:5px;background:var(--bg-soft,#eef1f6);border-radius:3px;margin:6px 0 10px;overflow:hidden;">
        <div style="height:100%;width:${seasonPct}%;background:var(--accent);border-radius:3px;transition:width .6s ease;"></div>
      </div>
      <div style="margin-bottom:8px;">${verdict}</div>
      <table class="table">
        <thead><tr><th>#</th><th>选手（点击展开持仓 / 操作 / 策略 / 谱系）</th><th>生涯战绩（净收益）</th><th>参数</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }).join('');
  bindPlayerRows();

  // 冠军信号
  const champs = await getChampionSignals(12);
  if (!champs.length) {
    $('champSignals').innerHTML = '<div class="placeholder">暂无冠军信号——选手评分未过入场阈值，云端下一轮运行后可能出现</div>';
  } else {
    $('champSignals').innerHTML = `<div class="opp-grid">` + champs.map(s => {
      const dirCls = s.direction === 'long' ? 'buy' : 'sell';
      const stateTxt = s.status === 'filled' ? `已结算 <b class="${clsBySign(s.netReturn)}">${fmtPct(s.netReturn, 2)}</b>`
        : s.status === 'pending_exit' ? `持仓中 · 入场 ${s.entryPrice ?? '—'}`
        : '等待入场';
      return `<div class="opp-card ${dirCls === 'sell' ? 'sell' : ''}" data-sym="${s.symbol}" data-iv="${s.interval}">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span class="sym">${s.symbol.replace('USDT', '')}<span style="color:var(--text-dim);font-size:10px;">/USDT · ${s.interval}</span></span>
          <span class="tier-badge ${dirCls === 'buy' ? 'tA-buy' : 'tA-sell'}">${s.direction === 'long' ? '做多' : '做空'}</span>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;">
          <span style="font-weight:700;font-size:15px;">${fmtNum(s.score, 3)}</span>
          <span style="font-size:10px;color:var(--text-faint);">${(FAMILIES[s.family] || {}).name || s.family} g${s.generation}</span>
        </div>
        <div class="meta">${fmtTime(s.signalBarTime)} · ${stateTxt}</div>
      </div>`;
    }).join('') + `</div>`;
    setTimeout(() => {
      $('champSignals').querySelectorAll('.opp-card').forEach(card => {
        card.addEventListener('click', () => goDashboard(card.dataset.sym, 'futures', card.dataset.iv));
      });
    }, 160);
  }

  // 赛季日志
  if (state.seasons.length) {
    $('seasonLog').innerHTML = state.seasons.map(s => {
      const c = s.champion;
      const modelRanks = `${s.learnedRank ? ` · 云端第 ${s.learnedRank}` : ''}${s.coinRank ? ` · 逐币第 ${s.coinRank}` : ''}`;
      return `<div class="panel flat" style="margin-bottom:8px;padding:10px 14px;">
        <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;align-items:center;">
          <div><b>${IV_NAMES[s.interval]}周期 · 赛季结算</b>
            <span style="color:var(--text-dim);font-size:11px;margin-left:8px;">${new Date(s.finishedAt).toLocaleString()}</span></div>
          <div style="font-size:12px;">
            ${icon('trophy')} 第一：<b>${c.name} g${c.gen}</b>
            <span class="${clsBySign(c.stats.meanRet)}" style="margin-left:6px;">${fmtPct(c.stats.totalRet, 2)}</span>
            <span style="color:var(--text-dim);margin-left:8px;">随机组第 ${s.randomRank}/${s.players} · 静态组第 ${s.staticRank}/${s.players}${modelRanks}</span>
          </div>
        </div>
      </div>`;
    }).join('');
  }
  setNet('竞技场（云端）', 'connected');
}

async function init() {
  setNet('读取云端竞技场…', 'connecting');
  try {
    await render();
  } catch (e) {
    $('arenaMetrics').innerHTML = `<div class="placeholder" style="grid-column:1/-1;">云端状态暂未就绪（${e.message}）· 引擎每 30 分钟产出一次，稍后刷新</div>`;
    setNet('等待云端首轮运行', 'connecting');
  }
  // 每 5 分钟自动刷新（云端每 30 分钟产出新状态）
  setInterval(() => { render().catch(() => {}); }, 5 * 60 * 1000);
}

init();
