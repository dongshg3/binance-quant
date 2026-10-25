/* 币安量化系统 · 纯视觉动效层（v4 视觉升级新增）
   只做表现：主数字滚动（MutationObserver + rAF，600ms easeOutExpo）。
   不读取、不修改任何业务状态与变量；prefers-reduced-motion 下直接呈现最终值。 */
(function () {
  'use strict';
  var reduce = false;
  try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
  if (reduce || !('MutationObserver' in window)) return;

  /* 滚动目标：价格主数字、指标值、交易计划数值、评分徽章。
     仅处理“纯文本”节点（含 small 等子元素的 .v 不触碰，避免破坏结构）。 */
  var SEL = ['#priceNow', '#change24h', '.metric .v', '.plan-grid .v', '.plan-footer .v', '.score-chip', '.cone-table td'];
  var RE = /^([^0-9a-zA-Z+\-]*)([+\-]?[0-9][0-9,]*(?:\.[0-9]+)?)(.*)$/;
  var MIN_RATIO = 0.005; /* 变化小于 0.5% 不滚动（避免高频行情抖动重播） */

  function easeOutExpo(t) { return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t); }

  function roll(el) {
    if (el.__animFx) return;                 /* 动画进行中，防重入 */
    if (el.children && el.children.length) return;
    var text = el.textContent || '';
    var m = RE.exec(text);
    if (!m) return;
    var prefix = m[1], core = m[2], suffix = m[3];
    var target = parseFloat(core.replace(/,/g, ''));
    if (!isFinite(target)) return;
    var last = el.__numFx;
    el.__numFx = target;
    if (target === 0) return;
    if (last != null && Math.abs(target - last) <= Math.max(Math.abs(last) * MIN_RATIO, 1e-9)) return;

    var r = el.getBoundingClientRect();
    if (r.top > (window.innerHeight || 800) * 1.15 || r.bottom < 0) return;  /* 视口外直接落终值 */

    var decimals = (core.split('.')[1] || '').length;
    var t0 = null;
    el.__animFx = true;
    function frame(ts) {
      if (t0 === null) t0 = ts;
      var p = Math.min((ts - t0) / 600, 1);
      var v = target * easeOutExpo(p);
      var coreNow;
      try { coreNow = v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }); }
      catch (e) { coreNow = v.toFixed(decimals); }
      el.textContent = prefix + coreNow + suffix;
      if (p < 1) requestAnimationFrame(frame);
      else el.__animFx = false;
    }
    requestAnimationFrame(frame);
  }

  function handle(node) {
    if (!node) return;
    if (node.nodeType === 3) node = node.parentElement;
    if (!node || node.nodeType !== 1 || !node.matches) return;
    if (node.matches(SEL)) roll(node);
    if (node.querySelectorAll) {
      var hits = node.querySelectorAll(SEL);
      for (var k = 0; k < hits.length; k++) roll(hits[k]);
    }
  }

  var mo = new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (r.type === 'characterData') { handle(r.target); continue; }
      var added = r.addedNodes;
      for (var j = 0; j < added.length; j++) handle(added[j]);
    }
  });
  mo.observe(document.body, { childList: true, subtree: true, characterData: true });

  /* 已在 DOM 中的首屏数值 */
  var initial = document.querySelectorAll(SEL);
  for (var i = 0; i < initial.length; i++) roll(initial[i]);
})();
