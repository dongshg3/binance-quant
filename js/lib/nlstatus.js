// ============================================================
// nlstatus.js · 零 Token 自动迭代状态面板
// ------------------------------------------------------------
// 数据来源：data/nl_status.json —— 由本机常驻的自动迭代进程（train/auto_loop.py）
// 每一代结束后写出并推送到仓库，GitHub Pages 直接托管，本页只读不写。
//
// 口径纪律（与全站一致）：
//   · 所有收益类数字都是**模拟口径**：按历史 K 线逐期再平衡，扣除手续费/滑点/资金费；
//     不涉及真实资金、不涉及下单、不构成投资建议。
//   · 没有任何候选同时通过全部闸门时，本面板显示空态而不是"最优推荐"。
//     空态是诚实结论，不是故障。
//   · 本面板不读取、不展示任何密钥；文件里也没有密钥。
// ============================================================

const PATH = 'data/nl_status.json';

const fmt = (v, digits = 2, suffix = '') =>
  (v === null || v === undefined || Number.isNaN(v)) ? '—' : Number(v).toFixed(digits) + suffix;

const esc = (s) => String(s === null || s === undefined ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function metricCard(label, value, hint) {
  return `<div class="metric"><div class="metric-label">${esc(label)}</div>
    <div class="metric-value">${esc(value)}</div>
    ${hint ? `<div class="metric-hint">${esc(hint)}</div>` : ''}</div>`;
}

function gateTag(passed, reasons) {
  if (passed) return '<span class="up">已通过全部闸门</span>';
  const first = (reasons && reasons[0]) ? String(reasons[0]) : '未通过';
  return `<span class="down">未采纳</span> <small style="color:var(--text-faint)">${esc(first)}</small>`;
}

export async function renderNlStatus() {
  const host = document.getElementById('nlStatusContent');
  if (!host) return;
  let d = null;
  try {
    const res = await fetch(PATH + '?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    d = await res.json();
  } catch (e) {
    host.innerHTML = '<div class="placeholder">暂时读不到自动迭代产物（data/nl_status.json 未生成或不可达）。'
      + '这不影响本页其他区块。</div>';
    return;
  }
  if (!d || !d.loop) {
    host.innerHTML = '<div class="placeholder">产物格式无法识别，已跳过本区块。</div>';
    return;
  }

  const L = d.loop || {};
  const champ = d.champion || null;
  const ds = d.dataset || {};

  let html = `<div class="grid-metrics" style="margin-bottom:12px;">
    ${metricCard('迭代代数', L.generation ?? '—', '已完成的选择轮次')}
    ${metricCard('累计试错配置', L.nTrials ?? '—', '用于 Deflated Sharpe 的多重检验惩罚')}
    ${metricCard('通过全部闸门的候选', L.passedAllGates ?? '—', '通过才能被采纳为可用模型')}
    ${metricCard('账本条目', L.ledgerEntries ?? '—', '追加式记录，含配置哈希可复现')}
    ${metricCard('样本口径', ds.nRows ? `${ds.nSymbols} 币 / ${ds.nRows} 样本` : '—', '1 小时 K 线，剔除锚定资产与代币化股票')}
    ${metricCard('产物时间 (UTC)', (d.updatedAt || '—').replace('T', ' ').replace('+00:00', ''), '每次迭代后自动更新')}
  </div>`;

  html += `<div style="font-size:11px;color:var(--text-dim);margin-bottom:10px;line-height:1.7;">
    本面板由<b>本机常驻进程</b>驱动：每一代从非线性模型族里取样配置，用 Purged Walk-Forward
    做样本外验证，再用<b>净成本</b>口径（扣手续费 / 滑点 / 资金费 / 换手）评估，
    最后经多重检验修正后决定是否采纳。整个过程不调用任何外部模型接口。
  </div>`;

  if (champ && champ.metrics) {
    const m = champ.metrics;
    html += `<div style="margin-bottom:10px;font-size:11px;">
      <b>当前冠军</b>：第 ${esc(champ.generation)} 代 ·
      ${esc((champ.spec || {}).family)} / ${esc((champ.spec || {}).featureBatch)} ·
      横截面 IC ${fmt(m.icXS, 4)} · 净每期 ${fmt(m.netMeanBp, 2)} bp ·
      净 Sharpe ${fmt(m.netSharpe, 2)} · Deflated Sharpe ${fmt(m.dsr, 3)} ·
      PBO ${fmt(champ.pbo, 3)}
    </div>`;
  } else {
    html += `<div class="placeholder" style="margin-bottom:10px;">
      尚无任何候选同时通过全部闸门。<b>这是诚实的空态，不是故障</b>：
      本表数字全部来自追加式账本，不做推测、不做外推。
    </div>`;
  }

  const rows = d.leaderboard || [];
  if (rows.length) {
    html += `<table class="table" style="margin-top:6px;" data-bq-scroll data-bq-scroll-label="自动迭代候选榜单">
      <thead><tr>
        <th>代</th><th>模型族</th><th>特征批次</th><th>持有期 (bar)</th><th>交易分位</th><th>成本档</th>
        <th>横截面 IC</th><th>净每期 (bp)</th><th>毛每期 (bp)</th><th>净 Sharpe</th>
        <th>Deflated Sharpe</th><th>市场 β</th><th>闸门</th>
      </tr></thead>
      <tbody>${rows.map(r => `<tr style="cursor:default">
        <td>${esc(r.generation)}</td>
        <td>${esc(r.family)}</td>
        <td>${esc(r.featureBatch)}</td>
        <td>${esc(r.holding)}</td>
        <td>${esc(r.topFrac)}</td>
        <td>${esc(r.costTier)}</td>
        <td>${fmt(r.icXS, 4)}</td>
        <td class="${(r.netMeanBp || 0) > 0 ? 'up' : 'down'}">${fmt(r.netMeanBp, 2)}</td>
        <td>${fmt(r.grossMeanBp, 2)}</td>
        <td class="${(r.netSharpe || 0) > 0 ? 'up' : 'down'}">${fmt(r.netSharpe, 2)}</td>
        <td>${fmt(r.dsr, 3)}</td>
        <td>${fmt(r.mktBeta, 3)}</td>
        <td>${gateTag(r.passed, r.reasons)}</td>
      </tr>`).join('')}</tbody>
    </table>
    <div style="font-size:10px;color:var(--text-faint);margin-top:8px;line-height:1.7;">
      按净 Sharpe 排序的历史最佳若干条。<b>净每期</b>单位 bp = 万分之一，已扣除手续费、滑点与资金费；
      持有期越长每期跨度越大，横向比较时请看 Deflated Sharpe 与闸门列，而不是单看均值。
      <b>市场 β</b>是与市场等权收益回归的斜率：绝对值过大意味着这条曲线的收益主要来自市场方向暴露，
      而非选币能力，因此闸门对它设了上限。
    </div>`;
  } else {
    html += '<div class="placeholder">账本里还没有完成评估的候选。</div>';
  }

  const hist = (L.history || []);
  if (hist.length) {
    html += `<div style="margin-top:12px;font-size:11px;color:var(--text-dim);">
      <b>逐代摘要</b>（评估数 / 过闸数 / 该代最佳净 Sharpe / PBO / 是否加冕）：
      <div style="margin-top:6px;line-height:1.9;font-family:ui-monospace,monospace;">
      ${hist.map(h => `<div>g${esc(h.generation)} · 评估 ${esc(h.nEval)} · 过闸 ${esc(h.nPassed)} · `
        + `最佳 Sharpe ${fmt(h.topSharpe, 2)} · IC ${fmt(h.topIC, 4)} · `
        + `DSR ${fmt(h.topDSR, 3)} · PBO ${fmt(h.pbo, 3)} · `
        + `${h.promoted ? '<span class="up">加冕</span>' : '未加冕'} · `
        + `家族 ${esc((h.families || []).join('/'))}</div>`).join('')}
      </div>
    </div>`;
  }

  const th = d.gateThresholds || {};
  html += `<div style="margin-top:12px;font-size:10px;color:var(--text-faint);line-height:1.8;">
    <b>采纳闸门（全部满足才采纳）</b>：横截面 IC ≥ ${esc(th.minIC)} 且 Newey-West t ≥ ${esc(th.minICt)}；
    净每期 &gt; ${esc(th.minNetBp)} bp；净 Sharpe ≥ ${esc(th.minSharpe)}；净收益 NW t ≥ ${esc(th.minNetT)}；
    Deflated Sharpe ≥ ${esc(th.minDSR)}（按累计试错次数做多重检验惩罚）；
    |市场 β| ≤ ${esc(th.maxAbsBeta)}；回归 alpha &gt; ${esc(th.minAlphaBp)} bp；市场下跌期平均 &gt; ${esc(th.minDownBp)} bp；
    换手 ≤ ${esc(th.maxTurnover)}；盈亏平衡成本 ≥ ${esc(th.minCostMargin)} 倍真实成本。
  </div>`;

  html += `<div style="font-size:10px;color:var(--text-faint);margin-top:8px;line-height:1.7;">
    <b>口径声明</b>：以上全部收益类数字均为<b>模拟口径</b>——基于历史 K 线的逐期再平衡结果，
    已扣除手续费、滑点与资金费，未计入真实资金、未发生任何下单或成交，也不代表未来表现。
    本站不提供下单能力，不构成投资建议。
    ${d.honestNote ? esc(d.honestNote) : ''}
  </div>`;

  host.innerHTML = html;
}
