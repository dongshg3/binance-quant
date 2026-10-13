// 口径对齐验证 · 浏览器端片段
// 前提：本地 vite 已启动且 train/parity_klines.json 已生成
// 在站点页面（如 http://localhost:7101/screener.html）控制台执行，或通过 InAppBrowser evaluate 调用；
// 将返回的 JSON 字符串保存为 train/parity_js.json，然后运行 python train/parity_check.py
(async () => {
  const q = await import('/js/lib/quant.js');
  const mm = await import('/js/lib/model.js');
  await mm.loadModel();
  const data = await fetch('/train/parity_klines.json?t=' + Date.now(), { cache: 'no-store' }).then(r => r.json());
  const out = [];
  for (const sym in data) {
    const d = data[sym];
    const candles = d.ohlcv.map(r => ({ open: r[0], high: r[1], low: r[2], close: r[3], volume: r[4] }));
    const f = q.computeFactors(candles, { fundingRate: d.fr }, sym);
    out.push({ sym, groups: f.groupAverages, composite: f.composite, ws: q.weightSourceInfo(sym) });
  }
  return JSON.stringify(out);
})()
