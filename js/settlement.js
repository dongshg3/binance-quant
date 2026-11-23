// settlement.js —— 结算窗口预测模型页面
import { renderNav, setNet, disclaimerHTML, icon } from './lib/ui.js';

renderNav('settlement');
const slot = document.getElementById('disclaimerSlot');
if (slot) slot.innerHTML = disclaimerHTML();

const $ = (id) => document.getElementById(id);
const num = (v, d = 1) => (v === null || v === undefined || Number.isNaN(+v) ? '—' : (+v).toFixed(d));
const pct = (v, d = 1) => (v === null || v === undefined ? '—' : (v * 100).toFixed(d) + '%');
const signCls = (v) => (v === null || v === undefined ? '' : v >= 0 ? 'good' : 'bad');

function metric(k, v, sub = '', cls = '') {
  return `<div class="metric ${cls}"><div class="k">${k}</div><div class="v">${v}${sub ? `<small> ${sub}</small>` : ''}</div></div>`;
}

function row(cells, cls = '') {
  return `<tr${cls ? ` class="${cls}"` : ''}>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
}

function chip(txt, kind) {
  const m = { take: 'long', skip: 'flat', warm: 'trend' };
  return `<span class="chip ${m[kind] || 'flat'}">${txt}</span>`;
}

async function load() {
  const res = await fetch('data/settlement.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('settlement.json ' + res.status);
  return res.json();
}

function main(d) {
  // 标题副标
  const w = d.window || {};
  $('winSub').textContent = `${w.from || ''} → ${w.to || ''} · ${(w.events || 0).toLocaleString()} 场结算 · ${w.symbols || 0} 币`;

  // 核心结论
  const h = d.headline || {};
  const best = h.bestRule || {};
  const live = h.liveRule || {};
  $('headMetrics').innerHTML = [
    metric('真实价格腿均值', `${num(h.costMean)}<small>bp</small>`, '', 'bad'),
    metric('真实净收益中位', `${num(h.netMedian)}<small>bp</small>`, `胜率 ${pct(h.win)}`, 'good'),
    metric('最优规则单场', `${num(best.mean)}<small>bp</small>`, `${best.trades || 0} 笔`, 'good'),
    metric('现行口径单场', `${num(live.mean)}<small>bp</small>`, `${live.trades || 0} 笔`, ''),
    metric('模型 IC（成本）', num(h.ic, 3), '样本外秩相关'),
    metric('分类 AUC', num(h.auc, 3), '净收益是否为正'),
  ].join('');

  // 数据覆盖
  const c = d.coverage || {};
  const b = c.buckets || {};
  $('covMetrics').innerHTML = [
    metric('总结算场次', (c.eventsTotal || 0).toLocaleString(), `${c.days || ''} 天 · ${c.symbolsTotal || 0} 币`),
    metric('|费率|≥0.3% 样本池', (b.ge_003 || 0).toLocaleString(), '可研究对象'),
    metric('已逐笔定价', (c.tagged || 0).toLocaleString(), `覆盖 ${pct(c.taggedShare)}`, 'good'),
    metric('已定价净收益', `${num(d.label && d.label.netMean)}<small>bp</small>`, `中位 ${num(d.label && d.label.netMedian)}bp`, 'good'),
  ].join('');

  $('covBody').innerHTML = (c.years || [])
    .map((y) =>
      row([
        y.year,
        (y.events || 0).toLocaleString(),
        y.symbols,
        y.ge03 ?? '—',
        y.ge05 ?? '—',
        y.ge09 ?? '—',
        (y.tagged || 0).toLocaleString(),
        num(y.netMean),
        y.win === null || y.win === undefined ? '—' : pct(y.win),
      ])
    )
    .join('');

  // 规则对比
  $('ruleBody').innerHTML = (d.rules || [])
    .map((r) => {
      const hl = r.rule === best.name ? 'style="background:rgba(37,99,235,0.06)"' : '';
      return `<tr ${hl}><td>${r.rule}</td><td>${r.trades}</td><td class="${signCls(r.mean)}">${num(r.mean)}</td>
        <td>${num(r.median)}</td><td>${pct(r.win)}</td><td class="bad">${num(r.p05)}</td>
        <td>${num(r.total, 0)}</td><td>${pct(r.capture)}</td></tr>`;
    })
    .join('');

  // 季度
  $('qBody').innerHTML = (d.quarterly || [])
    .map((q) =>
      row([
        q.q,
        q.n,
        q.baseN ?? '—',
        `<span class="${signCls(q.baseMean)}">${num(q.baseMean)}</span>`,
        q.baseWin === null || q.baseWin === undefined ? '—' : pct(q.baseWin),
        num(q.hindMean),
        num(q.allMean),
        q.allWin === null || q.allWin === undefined ? '—' : pct(q.allWin),
      ])
    )
    .join('');

  // EVT
  const e = d.evt || {};
  const v = e.var || {};
  const hit = e.hit20x || {};
  $('evtMetrics').innerHTML = [
    metric('形状参数 ξ', num(e.xi, 3), 'ξ>0 厚尾'),
    metric('VaR 99%', `${num(v.q99 ?? v.q99_bp)}<small>bp</small>`, '平均 100 场一次', 'bad'),
    metric('20x 满仓冲击', `${num(hit.q99)}%`, '一次就能致命', 'bad'),
    metric('真实成本均值', `${num(e.costMean)}<small>bp</small>`, `最大 ${num(e.costMax)}bp`),
  ].join('');

  // 仓位
  $('sizBody').innerHTML = (d.sizing || [])
    .map((s) =>
      row([
        s.name,
        s.avgNotional === null ? '—' : s.avgNotional.toFixed(2) + '×',
        `<span class="bad">${num(s.dd)}%</span>`,
        `<span class="bad">${num(s.worst)}%</span>`,
      ])
    )
    .join('');

  // 影子
  const sh = d.shadow || {};
  const oos = sh.oos || {};
  const sw = oos.shadow || {};
  const lr = oos.liveRule || {};
  $('shadowSub').textContent = `只读 · 样本外 ${(oos.events || 0).toLocaleString()} 场`;
  $('shadowMetrics').innerHTML = [
    metric('出手', `${oos.trades || 0} / ${oos.events || 0}`, `命中信号 ${pct(oos.hitRate)}`),
    metric('影子单场均值', `${num(sw.mean_net_bp)}<small>bp</small>`, `胜率 ${pct(sw.win)}`, 'good'),
    metric('影子 p05', `${num(sw.p05_bp)}<small>bp</small>`, '', 'bad'),
    metric('影子终值 / 回撤', `${num(sw.terminal_x, 2)}×`, `${num(sw.max_dd * 100)}% 回撤`, 'good'),
    metric('现行口径终值 / 回撤', `${num(lr.terminal_x, 2)}×`, `${num(lr.max_dd * 100)}% 回撤`),
    metric('模型训练日', (sh.params && sh.params.trained_on) || '—', `IC ${num(sh.params && sh.params.train_ic, 3)}`),
  ].join('');

  $('shadowBody').innerHTML = (sh.decisions || [])
    .map((x) => {
      const take = x.decision === '做';
      return row([
        x.ts,
        x.sym,
        `<span class="${x.rate_bp >= 0 ? 'good' : 'bad'}">${num(x.rate_bp)}</span>`,
        num(x.pred_cost_bp),
        `<span class="${signCls(x.mu_bp)}">${num(x.mu_bp)}</span>`,
        take ? chip('做', 'take') : chip('跳过', 'skip'),
        take ? num(x.size_x, 2) + '×' : '—',
        `<span class="${signCls(x.real_net_bp)}">${num(x.real_net_bp)}</span>`,
        take ? num(x.pnl_pct, 2) + '%' : '0.00%',
      ]);
    })
    .join('');

  $('monthBody').innerHTML = (sh.months || [])
    .map((m) =>
      row([m.month, m.events, m.trades, num(m.mean_net_bp), pct(m.win), num(m.sum_bp_x_size, 0)])
    )
    .join('');

  // 分币种
  $('symBody').innerHTML = (d.persymbol || [])
    .map((s) =>
      row([
        s.sym,
        s.n,
        num(s.costMean),
        `<span class="${signCls(s.netMean)}">${num(s.netMean)}</span>`,
        num(s.netMed),
        pct(s.win),
        num(s.ic, 3),
      ])
    )
    .join('');

  // 时效
  $('recBody').innerHTML = (d.recency || [])
    .map((r) =>
      row([
        r.hl ? `${r.hl} 天` : '等权',
        r.n,
        num(r.ic, 3),
        num(r.mae),
        r.trades,
        num(r.mean),
        pct(r.win),
        num(r.p05),
      ])
    )
    .join('');

  setNet(`结算数据 ${(c.tagged || 0).toLocaleString()} 场已定价`, 'ok');
}

load()
  .then(main)
  .catch((err) => {
    console.error(err);
    const el = document.getElementById('headMetrics');
    if (el) el.innerHTML = `<div class="placeholder">数据加载失败：${err.message}</div>`;
    setNet('结算数据加载失败', 'bad');
  });
