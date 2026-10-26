// 资金费率事件衍生：与 train/futures_data.py 同构。
// 窗口单位是真实 funding 事件，不是 K 线；只使用当前及过去事件。
export function fundingDynamics(history, currentRate = null, minEvents = 10, windowEvents = 90) {
  const rates = (Array.isArray(history) ? history : [])
    .map(Number).filter(Number.isFinite);
  if (Number.isFinite(currentRate) && rates[rates.length - 1] !== currentRate) rates.push(currentRate);
  const n = rates.length;
  if (!n) return { rate: null, z: null, delta: null, accel: null, events: 0 };
  const i = n - 1, rate = rates[i];
  let z = null;
  if (n >= minEvents) {
    const hist = rates.slice(Math.max(0, n - windowEvents));
    const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
    const variance = hist.reduce((s, x) => s + (x - mean) ** 2, 0) / hist.length;
    if (variance > 0) z = (rate - mean) / Math.sqrt(variance);
  }
  return {
    rate, z,
    delta: n >= 2 ? rate - rates[i - 1] : null,
    accel: n >= 3 ? rate - 2 * rates[i - 1] + rates[i - 2] : null,
    events: n,
  };
}

export function fundingDynamicScores(dynamics) {
  const d = dynamics || {};
  const clamp = x => Math.max(-1, Math.min(1, x));
  return [
    Number.isFinite(d.z) ? clamp(-d.z / 2) : 0,
    Number.isFinite(d.delta) ? clamp(-d.delta / 0.0005) : 0,
    Number.isFinite(d.accel) ? clamp(-d.accel / 0.0005) : 0,
  ];
}
