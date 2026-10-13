// ============================================================
// arena.js（页面）· 策略竞技场：选手池排行 / 冠军信号 / 赛季日志
// ============================================================
import { ARENA_INTERVALS, FAMILIES, getArenaState, getChampionSignals, arenaAutoTick, resetArena } from './lib/arena.js';
import { renderNav, setNet, fmtPct, fmtNum, fmtTime, disclaimerHTML, icon, swapHTML, goDashboard, clsBySign } from './lib/ui.js';

renderNav('arena');
document.getElementById('disclaimerSlot').innerHTML = disclaimerHTML();
const $ = id => document.getElementById(id);

const IV_NAMES = { '15m': '15 分钟', '1h': '1 小时', '4h': '4 小时', '1d': '日线' };
const CTRL_TAGS = { random: '对照', staticRef: '对照', learned: '云端', coin: '逐币' };
const CONTROL = new Set(Object.keys(CTRL_TAGS));

function statLine(st) {
  if (!st || !st.n) return '<span style="color:var(--text-faint)">样本积累中</span>';
  const cls = st.meanRet > 0 ? 'up' : st.meanRet < 0 ? 'down' : '';
  return `<span class="${cls}" style="font-weight:600;">${fmtPct(st.totalRet, 2)}</span>
    <span style="color:var(--text-dim)"> · 胜率 ${fmtPct(st.winRate, 0, false)} · t=${fmtNum(st.tStat, 2)} · n=${st.n}</span>`;
}

async function render() {
  const state = await getArenaState();
  // 总览
  const totalPlayers = Object.values(state.intervals).reduce((a, x) => a + x.players.length, 0);
  const cells = [
    { k: '在役选手', v: totalPlayers },
    { k: '累计模拟信号', v: state.totalSignals },
    { k: '已完成赛季', v: state.seasons.length },
    { k: '周期数', v: '4（15m / 1h / 4h / 1d）' },
  ];
  $('arenaMetrics').innerHTML = cells.map(c => `<div class="metric"><div class="k">${c.k}</div><div class="v">${c.v}</div></div>`).join('');

  // 四周期选手池
  $('poolPanels').innerHTML = Object.keys(ARENA_INTERVALS).map(iv => {
    const blk = state.intervals[iv];
    const cfg = ARENA_INTERVALS[iv];
    const seasonPct = Math.min(100, (Date.now() - blk.seasonStart) / cfg.seasonMs * 100);
    const pctTxt = seasonPct < 10 ? seasonPct.toFixed(1) : seasonPct.toFixed(0);
    const elapsedD = (Date.now() - blk.seasonStart) / 864e5;
    const seasonD = cfg.seasonMs / 864e5;
    const remainD = Math.max(0, (cfg.seasonMs - (Date.now() - blk.seasonStart)) / 864e5);
    const rows = blk.players.map((p, i) => {
      const isCtrl = CONTROL.has(p.family);
      const champ = p.isChampion ? `<span class="chip trend" style="padding:1px 7px;">${icon('crown')}冠军</span>` : '';
      const ctrlTag = isCtrl ? `<span class="chip ${p.family === 'learned' || p.family === 'coin' ? 'trend' : 'flat'}" style="padding:1px 7px;">${CTRL_TAGS[p.family]}</span>` : '';
      return `<tr class="${isCtrl ? 'row-control' : ''}">
        <td style="color:var(--text-faint)">${i + 1}</td>
        <td><b>${p.familyName}</b> <span style="color:var(--text-faint);font-size:10px;">g${p.generation}</span> ${champ}${ctrlTag}</td>
        <td>${statLine(p.stats)}</td>
        <td style="color:var(--text-dim);font-size:11px;">视野 ${p.params.horizon}bar · 阈值 ${p.params.entryThreshold.toFixed(2)}</td>
      </tr>`;
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
        <thead><tr><th>#</th><th>选手</th><th>生涯战绩（净收益）</th><th>参数</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }).join('');

  // 冠军信号
  const champs = await getChampionSignals(12);
  if (!champs.length) {
    $('champSignals').innerHTML = '<div class="placeholder">暂无冠军信号——选手评分未过入场阈值，或首轮信号生成尚未运行。点下方「立即运行一轮」。</div>';
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
          <span style="font-size:10px;color:var(--text-faint);">${s.family} g${s.generation}</span>
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
  // 自动运行状态（不覆盖控制台正在显示的本轮结果）
  const lastTick = Number(localStorage.getItem('bq_arena_lasttick') || 0);
  const cs = $('ctrlStatus');
  if (cs && !cs.dataset.done) {
    cs.textContent = `自动模式：任意页面保持打开时每 10 分钟自动运行一轮 · 上次运行 ${lastTick ? new Date(lastTick).toLocaleString() : '—'}`;
  }
  setNet('竞技场运行中', 'connected');
}

async function init() {
  setNet('打开竞技场…', 'connecting');
  await render();
  $('tickBtn').addEventListener('click', async () => {
    $('ctrlStatus').textContent = '正在运行一轮（拉取 K 线生成信号 + 回填结算）…';
    const r = await arenaAutoTick(true);
    $('ctrlStatus').textContent = r ? `完成：新生成 ${r.created} 条信号 · 新结算 ${r.filled} 条` : '本轮无新增（节流或数据未更新）';
    $('ctrlStatus').dataset.done = '1';
    await render();
  });
  $('resetBtn').addEventListener('click', async () => {
    if (!confirm('确定重置竞技场？全部选手、信号与赛季记录将清零重建。')) return;
    await resetArena();
    $('ctrlStatus').textContent = '已重置，选手池已重建';
    $('ctrlStatus').dataset.done = '1';
    await render();
  });
  // 页面打开时强制跑一轮（首访立即建池 + 生成信号）
  arenaAutoTick(true).then(() => render());
}

init();
