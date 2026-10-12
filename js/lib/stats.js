// ============================================================
// stats.js · 数学统计 + 技术指标库（纯函数，无外部依赖）
// ============================================================

export const Stats = {
  mean: a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0,
  std: a => { if (a.length < 2) return 0; const m = Stats.mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length); },
  clamp: (x, lo, hi) => Math.max(lo, Math.min(hi, x)),
  percentile: (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const i = Stats.clamp((p / 100) * (s.length - 1), 0, s.length - 1); const lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); },
  periodsPerYear: interval => ({ '1m': 525600, '3m': 175200, '5m': 105120, '15m': 35040, '30m': 17520, '1h': 8760, '2h': 4380, '4h': 2190, '6h': 1460, '8h': 1095, '12h': 730, '1d': 365 }[interval] || 8760),
  intervalMs: interval => ({ '1m': 6e4, '3m': 18e4, '5m': 3e5, '15m': 9e5, '30m': 18e5, '1h': 36e5, '2h': 72e5, '4h': 144e5, '6h': 216e5, '8h': 288e5, '12h': 432e5, '1d': 864e5 }[interval] || 36e5),
  logReturns: c => { const r = []; for (let i = 1; i < c.length; i++) r.push(Math.log(c[i] / c[i - 1])); return r; },
  ewmaVol: (returns, lambda = 0.94) => {
    if (returns.length < 2) return 0;
    let v = Stats.std(returns.slice(0, Math.min(30, returns.length))) ** 2;
    for (let i = 1; i < returns.length; i++) v = lambda * v + (1 - lambda) * returns[i] ** 2;
    return Math.sqrt(v);
  },
  maxDrawdown: equity => { let peak = equity[0] || 1, mdd = 0; for (const e of equity) { if (e > peak) peak = e; const dd = (peak - e) / peak; if (dd > mdd) mdd = dd; } return mdd; },
  sharpe: (returns, ppy, rf = 0) => { const s = Stats.std(returns); if (s === 0) return 0; return ((Stats.mean(returns) - rf / ppy) / s) * Math.sqrt(ppy); },
  sortino: (returns, ppy, rf = 0) => {
    const down = returns.filter(r => r < 0);
    if (!down.length) return returns.length ? Infinity : 0;
    const ds = Math.sqrt(down.reduce((s, r) => s + r * r, 0) / down.length);
    if (ds === 0) return 0;
    return ((Stats.mean(returns) - rf / ppy) / ds) * Math.sqrt(ppy);
  },
  calmar: (returns, equity, ppy) => {
    const mdd = Stats.maxDrawdown(equity); if (mdd === 0) return 0;
    const n = returns.length; if (!n) return 0;
    const totalRet = equity[equity.length - 1] / equity[0] - 1;
    const years = n / ppy;
    const ann = years > 0 ? Math.pow(1 + totalRet, 1 / years) - 1 : 0;
    return ann / mdd;
  },
  // 历史 VaR / 期望损失（参数为每根 K 线对数收益）
  varEs: (returns, level = 95) => {
    if (returns.length < 30) return { var: 0, es: 0 };
    const sorted = [...returns].sort((a, b) => a - b);
    const idx = Math.floor((1 - level / 100) * sorted.length);
    const varr = -sorted[idx];
    const tail = sorted.slice(0, Math.max(1, idx));
    const es = -Stats.mean(tail);
    return { var: varr, es };
  },
  skew: a => { if (a.length < 3) return 0; const m = Stats.mean(a), s = Stats.std(a); if (!s) return 0; return Stats.mean(a.map(x => ((x - m) / s) ** 3)); },
  kurtosis: a => { if (a.length < 4) return 0; const m = Stats.mean(a), s = Stats.std(a); if (!s) return 0; return Stats.mean(a.map(x => ((x - m) / s) ** 4)) - 3; },
};

// ---------------- 经典技术指标 ----------------
export function SMA(a, p) { const r = new Array(a.length).fill(null); for (let i = p - 1; i < a.length; i++) { let s = 0; for (let j = i - p + 1; j <= i; j++) s += a[j]; r[i] = s / p; } return r; }

export function EMA(a, p) { const r = new Array(a.length).fill(null); if (a.length < p) return r; const k = 2 / (p + 1); let e = 0; for (let i = 0; i < p; i++) e += a[i]; e /= p; r[p - 1] = e; for (let i = p; i < a.length; i++) { e = a[i] * k + e * (1 - k); r[i] = e; } return r; }

export function RSI(c, p = 14) { const r = new Array(c.length).fill(null); if (c.length < p + 1) return r; let ag = 0, al = 0; for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d >= 0) ag += d; else al -= d; } ag /= p; al /= p; r[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); for (let i = p + 1; i < c.length; i++) { const d = c[i] - c[i - 1], g = d > 0 ? d : 0, l = d < 0 ? -d : 0; ag = (ag * (p - 1) + g) / p; al = (al * (p - 1) + l) / p; r[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); } return r; }

export function MACD(c, f = 12, s = 26, sig = 9) { const ef = EMA(c, f), es = EMA(c, s); const ml = c.map((_, i) => (ef[i] != null && es[i] != null) ? ef[i] - es[i] : null); const vm = ml.filter(v => v != null); const sl = EMA(vm, sig); const off = ml.findIndex(v => v != null); const as = new Array(c.length).fill(null); for (let i = 0; i < sl.length; i++) if (sl[i] != null) as[off + i] = sl[i]; const h = ml.map((v, i) => (v != null && as[i] != null) ? v - as[i] : null); return { macdLine: ml, signalLine: as, histogram: h }; }

export function Boll(c, p = 20, m = 2) { const mid = SMA(c, p); const up = new Array(c.length).fill(null), lo = new Array(c.length).fill(null); for (let i = p - 1; i < c.length; i++) { let s = 0; for (let j = i - p + 1; j <= i; j++) s += (c[j] - mid[i]) ** 2; const sd = Math.sqrt(s / p); up[i] = mid[i] + m * sd; lo[i] = mid[i] - m * sd; } return { upper: up, middle: mid, lower: lo }; }

export function ATR(h, l, c, p = 14) { const n = c.length, r = new Array(n).fill(null); if (n < p + 1) return r; const tr = [null]; for (let i = 1; i < n; i++) tr.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))); let s = 0; for (let i = 1; i <= p; i++) s += tr[i]; r[p] = s / p; for (let i = p + 1; i < n; i++) r[i] = (r[i - 1] * (p - 1) + tr[i]) / p; return r; }

export function StochRSI(c, rsiP = 14, stochP = 14, kP = 3) { const rsi = RSI(c, rsiP); const st = new Array(c.length).fill(null); for (let i = rsiP + stochP; i < c.length; i++) { let mn = Infinity, mx = -Infinity; for (let j = i - stochP + 1; j <= i; j++) { if (rsi[j] != null) { mn = Math.min(mn, rsi[j]); mx = Math.max(mx, rsi[j]); } } st[i] = mx === mn ? 50 : (rsi[i] - mn) / (mx - mn) * 100; } const k = SMA(st.filter(v => v != null), kP); const out = new Array(c.length).fill(null); const off = st.findIndex(v => v != null); for (let i = 0; i < k.length; i++) if (k[i] != null) out[off + i] = k[i]; return out; }

export function ADX(h, l, c, p = 14) { const n = c.length; const tr = new Array(n).fill(0), pdm = new Array(n).fill(0), mdm = new Array(n).fill(0); for (let i = 1; i < n; i++) { tr[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])); const up = h[i] - h[i - 1], dn = l[i - 1] - l[i]; pdm[i] = (up > dn && up > 0) ? up : 0; mdm[i] = (dn > up && dn > 0) ? dn : 0; } const sm = a => { const s = new Array(n).fill(0); let sum = 0; for (let i = 1; i <= p; i++) sum += a[i]; s[p] = sum; for (let i = p + 1; i < n; i++) s[i] = s[i - 1] - s[i - 1] / p + a[i]; return s; }; const str = sm(tr), sp = sm(pdm), sn = sm(mdm); const pdi = new Array(n).fill(null), mdi = new Array(n).fill(null); for (let i = p; i < n; i++) { if (str[i] !== 0) { pdi[i] = sp[i] / str[i] * 100; mdi[i] = sn[i] / str[i] * 100; } } const dx = new Array(n).fill(null); for (let i = p; i < n; i++) { if (pdi[i] != null && mdi[i] != null) { const s = pdi[i] + mdi[i]; dx[i] = s === 0 ? 0 : Math.abs(pdi[i] - mdi[i]) / s * 100; } } const adx = new Array(n).fill(null); let sum = 0, cnt = 0; for (let i = p; i < n; i++) { if (dx[i] != null) { sum += dx[i]; cnt++; if (cnt === p) { adx[i] = sum / p; break; } } } const start = adx.findIndex(v => v != null); for (let i = start + 1; i < n; i++) if (dx[i] != null) adx[i] = (adx[i - 1] * (p - 1) + dx[i]) / p; return { adx, pdi, mdi }; }

export function VWAP(h, l, c, v, p = 50) { const n = c.length, out = new Array(n).fill(null); for (let i = p - 1; i < n; i++) { let spv = 0, sv = 0; for (let j = i - p + 1; j <= i; j++) { const tp = (h[j] + l[j] + c[j]) / 3; spv += tp * v[j]; sv += v[j]; } out[i] = sv === 0 ? c[i] : spv / sv; } return out; }

export function OBV(c, v) { const o = new Array(c.length).fill(0); o[0] = v[0]; for (let i = 1; i < c.length; i++) { if (c[i] > c[i - 1]) o[i] = o[i - 1] + v[i]; else if (c[i] < c[i - 1]) o[i] = o[i - 1] - v[i]; else o[i] = o[i - 1]; } return o; }

export function Keltner(c, h, l, p = 20, m = 2) { const mid = EMA(c, p), atr = ATR(h, l, c, p); const u = new Array(c.length).fill(null), lo = new Array(c.length).fill(null); for (let i = 0; i < c.length; i++) { if (mid[i] != null && atr[i] != null) { u[i] = mid[i] + m * atr[i]; lo[i] = mid[i] - m * atr[i]; } } return { upper: u, middle: mid, lower: lo }; }

export function Fib(h, l, lb = 50) { const n = h.length, s = Math.max(0, n - lb); let sh = -Infinity, sl = Infinity; for (let i = s; i < n; i++) { sh = Math.max(sh, h[i]); sl = Math.min(sl, l[i]); } const range = sh - sl; return { l382: sh - range * 0.382, l618: sh - range * 0.618, sh, sl, range }; }

// ---------------- 高级量化指标 ----------------

// Kaufman 效率系数：趋势纯度 ∈ [0,1]，越高越单边
export function efficiencyRatio(c, p = 20) {
  const n = c.length; if (n < p + 1) return null;
  const change = Math.abs(c[n - 1] - c[n - 1 - p]);
  let vol = 0;
  for (let i = n - p; i < n; i++) vol += Math.abs(c[i] - c[i - 1]);
  return vol === 0 ? 0 : change / vol;
}

// 对数价格线性回归：返回斜率(每根bar)、截距、R²、当前残差z-score、外推值函数
export function logLinReg(c, p = 60) {
  const n = c.length; if (n < p) return null;
  const y = []; for (let i = n - p; i < n; i++) y.push(Math.log(c[i]));
  const m = p; let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < m; i++) { sx += i; sy += y[i]; sxy += i * y[i]; sxx += i * i; }
  const slope = (m * sxy - sx * sy) / (m * sxx - sx * sx);
  const intercept = (sy - slope * sx) / m;
  const residuals = []; let ssRes = 0, ssTot = 0; const ym = Stats.mean(y);
  for (let i = 0; i < m; i++) { const fit = intercept + slope * i; const r = y[i] - fit; residuals.push(r); ssRes += r * r; ssTot += (y[i] - ym) ** 2; }
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  const resStd = Stats.std(residuals);
  const zNow = resStd === 0 ? 0 : residuals[m - 1] / resStd;
  return { slope, intercept, r2, resStd, zNow, forecast: h => Math.exp(intercept + slope * (m - 1 + h)) };
}

// Holt 阻尼双指数平滑预测：返回未来 h 步点预测数组
export function holtForecast(c, h = 12, alpha = 0.4, beta = 0.08, phi = 0.9) {
  const n = c.length; if (n < 20) return [];
  let level = c[0], trend = c[1] - c[0];
  for (let i = 1; i < n; i++) {
    const prevLevel = level;
    level = alpha * c[i] + (1 - alpha) * (level + phi * trend);
    trend = beta * (level - prevLevel) + (1 - beta) * phi * trend;
  }
  const out = [];
  for (let i = 1; i <= h; i++) {
    let phiSum = 0; for (let j = 0; j < i; j++) phiSum += Math.pow(phi, j);
    out.push(level + phiSum * trend);
  }
  return out;
}

// Hurst 指数（简化 R/S 法）：>0.5 趋势延续，<0.5 均值回归
export function hurst(c, maxLag = 100) {
  const n = c.length; if (n < maxLag * 2) return null;
  const lags = [10, 20, 40, 80].filter(x => x <= maxLag);
  const xs = [], ys = [];
  for (const lag of lags) {
    const rsList = [];
    for (let start = 0; start + lag <= n; start += lag) {
      const seg = c.slice(start, start + lag);
      const rets = []; for (let i = 1; i < seg.length; i++) rets.push(Math.log(seg[i] / seg[i - 1]));
      if (rets.length < 5) continue;
      const m = Stats.mean(rets);
      let cum = 0, mn = 0, mx = 0;
      for (const r of rets) { cum += r - m; mn = Math.min(mn, cum); mx = Math.max(mx, cum); }
      const R = mx - mn, S = Stats.std(rets);
      if (S > 0) rsList.push(R / S);
    }
    if (rsList.length >= 2) { xs.push(Math.log(lag)); ys.push(Math.log(Stats.mean(rsList))); }
  }
  if (xs.length < 2) return null;
  const mx = Stats.mean(xs), my = Stats.mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den === 0 ? null : Stats.clamp(num / den, 0, 1);
}
