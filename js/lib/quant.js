// ============================================================
// quant.js · 量化引擎：多因子信号 / 市场状态 / 预测 / 仓位 / 回测
// ============================================================
import {
  Stats, SMA, EMA, RSI, MACD, Boll, ATR, StochRSI, ADX,
  VWAP, OBV, Keltner, Fib, efficiencyRatio, logLinReg, holtForecast, hurst,
} from './stats.js';

export const FACTOR_WEIGHTS = { trend: 0.25, momentum: 0.20, meanRev: 0.15, volume: 0.15, volatility: 0.10, position: 0.05, futures: 0.10 };
export const GROUP_NAMES = { trend: '趋势', momentum: '动量', meanRev: '均值回归', volume: '量能', volatility: '波动率', position: '位置', futures: '合约数据' };

// ---------------- 信号分级 ----------------
export function signalOf(composite) {
  if (composite >= 0.35) return { label: '强烈做多', cls: 'sbuy', dir: 1 };
  if (composite >= 0.15) return { label: '做多', cls: 'buy', dir: 1 };
  if (composite <= -0.35) return { label: '强烈做空', cls: 'ssell', dir: -1 };
  if (composite <= -0.15) return { label: '做空', cls: 'sell', dir: -1 };
  return { label: '观望', cls: 'hold', dir: 0 };
}

// ---------------- 七因子引擎 ----------------
export function computeFactors(candles, extraData) {
  if (candles.length < 60) return null;
  const c = candles.map(x => x.close);
  const h = candles.map(x => x.high);
  const l = candles.map(x => x.low);
  const v = candles.map(x => x.volume);
  const n = c.length - 1;
  const C = Stats.clamp;

  const rsiArr = RSI(c, 14);
  const { histogram } = MACD(c);
  const ema9 = EMA(c, 9), ema21 = EMA(c, 21), ema50 = EMA(c, 50), ema200 = EMA(c, 200);
  const { upper: bbU, middle: bbM, lower: bbL } = Boll(c, 20, 2);
  const atrArr = ATR(h, l, c, 14);
  const stoch = StochRSI(c, 14, 14, 3);
  const { adx, pdi, mdi } = ADX(h, l, c, 14);
  const vwapArr = VWAP(h, l, c, v, 50);
  const obvArr = OBV(c, v);
  const kc = Keltner(c, h, l, 20, 2);
  const fib = Fib(h, l, 50);

  const price = c[n];
  const atr = atrArr[n];

  const emaScore = (() => {
    if (ema9[n] == null || ema21[n] == null || ema50[n] == null) return 0;
    if (ema9[n] > ema21[n] && ema21[n] > ema50[n]) return 1;
    if (ema9[n] < ema21[n] && ema21[n] < ema50[n]) return -1;
    return ema9[n] > ema21[n] ? 0.3 : -0.3;
  })();
  const ema200Score = ema200[n] != null ? (price > ema200[n] ? 1 : -1) : 0;
  const adxScore = (adx[n] != null && adx[n] > 25) ? Math.sign(pdi[n] - mdi[n]) * Math.min(adx[n] / 50, 1) : 0;
  const keltnerScore = (kc.upper[n] && kc.lower[n]) ? (price > kc.upper[n] ? 1 : price < kc.lower[n] ? -1 : 0) : 0;

  const rsiScore = rsiArr[n] != null ? C((50 - rsiArr[n]) / 20, -1, 1) : 0;
  const macdScore = (histogram[n] != null && atr != null && atr > 0) ? C(histogram[n] / (atr * 0.3), -1, 1) : 0;
  const stochScore = stoch[n] != null ? C((50 - stoch[n]) / 30, -1, 1) : 0;
  const divergenceScore = (() => {
    if (n < 25 || rsiArr[n] == null) return 0;
    const rsi5ago = rsiArr[n - 5];
    if (rsi5ago == null) return 0;
    if (c[n] < c[n - 5] && rsiArr[n] > rsi5ago + 3) return 0.8;
    if (c[n] > c[n - 5] && rsiArr[n] < rsi5ago - 3) return -0.8;
    return 0;
  })();

  const bollScore = (bbU[n] && bbL[n] && bbU[n] > bbL[n]) ? C((0.5 - (price - bbL[n]) / (bbU[n] - bbL[n])) * 2, -1, 1) : 0;
  const vwapScore = vwapArr[n] != null ? C(-(price - vwapArr[n]) / vwapArr[n] * 50, -1, 1) : 0;

  const volAvg = SMA(v, 20)[n];
  const volRatio = volAvg ? v[n] / volAvg : 1;
  const recentDir = n >= 5 ? Math.sign(c[n] - c[n - 5]) : 0;
  const volScore = volRatio > 1.3 ? recentDir * C((volRatio - 1) / 2, 0, 1) : 0;
  const obvScore = (() => {
    if (n < 10 || !obvArr[n - 5]) return 0;
    const slope = (obvArr[n] - obvArr[n - 5]) / Math.abs(obvArr[n - 5] || 1);
    const priceSlope = (c[n] - c[n - 5]) / c[n - 5];
    if (slope > 0.02 && priceSlope > 0) return C(slope * 20, 0, 1);
    if (slope < -0.02 && priceSlope < 0) return C(slope * 20, -1, 0);
    if (slope > 0.02 && priceSlope < 0) return 0.3;
    if (slope < -0.02 && priceSlope > 0) return -0.3;
    return 0;
  })();

  const bbwSeries = new Array(c.length).fill(null);
  for (let i = 0; i < c.length; i++) if (bbU[i] && bbL[i] && bbM[i]) bbwSeries[i] = (bbU[i] - bbL[i]) / bbM[i] * 100;
  const bbwNow = bbwSeries[n];
  const bbwClean = bbwSeries.filter(x => x != null);
  const bbwAvgNow = bbwClean.length >= 20 ? Stats.mean(bbwClean.slice(-20)) : null;
  const squeeze = bbwNow != null && bbwAvgNow ? bbwNow / bbwAvgNow : 1;
  const squeezeScore = squeeze < 0.6 ? (price > bbM[n] ? 0.8 : -0.8) : (squeeze > 1.5 ? (price > bbM[n] ? 0.4 : -0.4) : 0);

  const fibScore = (() => {
    if (fib.range <= 0 || ema50[n] == null) return 0;
    const pos = (fib.sh - price) / fib.range;
    if (pos > 0.5 && pos < 0.65 && price > ema50[n]) return 0.7;
    if (pos > 0.35 && pos < 0.45 && price > ema50[n]) return 0.4;
    if (pos < 0.1) return -0.3;
    return 0;
  })();

  let fundingScore = 0, lsRatioScore = 0, oiScore = 0;
  if (extraData) {
    if (extraData.fundingRate != null) {
      const fr = extraData.fundingRate;
      if (fr > 0.001) fundingScore = -1;
      else if (fr > 0.0005) fundingScore = -0.4;
      else if (fr < -0.001) fundingScore = 1;
      else if (fr < -0.0005) fundingScore = 0.4;
    }
    if (extraData.lsRatio != null) lsRatioScore = C((1.5 - extraData.lsRatio) / 1.5, -1, 1);
    if (extraData.oiChange != null) {
      const oi = extraData.oiChange;
      if (oi > 0.03) oiScore = recentDir * 0.8;
      else if (oi < -0.03) oiScore = -recentDir * 0.5;
    }
  }

  const groups = {
    trend: [emaScore, ema200Score, adxScore, keltnerScore],
    momentum: [rsiScore, macdScore, stochScore, divergenceScore],
    meanRev: [bollScore, vwapScore],
    volume: [volScore, obvScore],
    volatility: [squeezeScore],
    position: [fibScore],
    futures: [fundingScore, lsRatioScore, oiScore],
  };

  const groupAverages = {};
  let composite = 0;
  for (const g in groups) {
    const avg = Stats.mean(groups[g]);
    groupAverages[g] = avg;
    composite += FACTOR_WEIGHTS[g] * avg;
  }

  const er = efficiencyRatio(c, 20);
  const hurstV = hurst(c);
  const logRets = Stats.logReturns(c.slice(-100));

  return {
    composite, groupAverages, groups,
    rawIndicators: {
      price, atr, rsi: rsiArr[n], macdH: histogram[n], adx: adx[n], pdi: pdi[n], mdi: mdi[n],
      stochRsi: stoch[n], volRatio, squeeze,
      er, hurst: hurstV,
      ewmaVol: Stats.ewmaVol(logRets),
      ema9: ema9[n], ema21: ema21[n], ema50: ema50[n], ema200: ema200[n],
      bbUpper: bbU[n], bbLower: bbL[n], fib,
    },
  };
}

// ---------------- 市场状态识别 ----------------
export function detectRegime(raw) {
  const { adx, er, hurst: hs } = raw;
  if (adx == null || er == null) return { label: '数据不足', cls: 'flat', hint: '' };
  if (adx >= 25 && er >= 0.30) {
    const h = hs != null && hs > 0.55 ? '，Hurst 确认趋势延续' : '';
    return { label: '趋势市', cls: 'trend', hint: `趋势策略权重有效${h}` };
  }
  if (adx <= 20 && er <= 0.20) {
    const h = hs != null && hs < 0.45 ? '，Hurst 确认均值回归' : '';
    return { label: '震荡市', cls: 'range', hint: `均值回归策略更适用${h}` };
  }
  return { label: '过渡态', cls: 'flat', hint: '方向不明，降低仓位或观望' };
}

// ---------------- 仓位模型（Kelly + 目标波动率） ----------------
export function computePosition(composite, candles, interval) {
  const c = candles.map(x => x.close);
  const returns = Stats.logReturns(c);
  const sigma = Stats.ewmaVol(returns);
  const ppy = Stats.periodsPerYear(interval);
  const annualizedVol = sigma * Math.sqrt(ppy);

  const signalStrength = Math.abs(composite);
  if (signalStrength < 0.15) return { direction: 0, size: 0, annualizedVol, leverage: 0, signalStrength };

  const targetVol = 0.20;
  let volScale = annualizedVol > 0.01 ? targetVol / annualizedVol : 1;
  volScale = Math.min(volScale, 3);

  const mu = composite * 0.001;
  const kelly = sigma > 0 ? mu / (sigma * sigma) : 0;
  const halfKelly = kelly / 2;

  let position = Math.min(volScale, Math.abs(halfKelly) * 10);
  position = Math.min(position, 1.0) * signalStrength;

  let leverage = 1;
  if (annualizedVol < 0.30) leverage = 10;
  else if (annualizedVol < 0.60) leverage = 5;
  else if (annualizedVol < 1.00) leverage = 3;
  else leverage = 2;

  return { direction: Math.sign(composite), size: position, annualizedVol, leverage, signalStrength, kelly };
}

// ---------------- 风险水平（ATR 止损/目标） ----------------
export function riskLevels(price, atr, direction) {
  if (!atr || direction === 0) return null;
  const d = Math.sign(direction);
  const stop = price - d * 1.5 * atr;
  const t1 = price + d * 1.5 * atr;
  const t2 = price + d * 3.0 * atr;
  return {
    stop, t1, t2,
    stopPct: Math.abs(stop - price) / price * 100,
    t1Pct: Math.abs(t1 - price) / price * 100,
    t2Pct: Math.abs(t2 - price) / price * 100,
    rr1: 1.0, rr2: 2.0,
  };
}

// ---------------- 蒙特卡洛价格锥（GBM + 信号漂移倾斜） ----------------
export function monteCarloCone(candles, composite, horizon = 24, paths = 4000) {
  const c = candles.map(x => x.close);
  const S0 = c[c.length - 1];
  const rets = Stats.logReturns(c.slice(-120));
  if (rets.length < 30) return null;
  const sigma = Stats.ewmaVol(rets);
  // 漂移：近期均值大幅收缩至 0 + 信号倾斜（信号满分 ≈ 每bar ±0.15σ）
  const muBase = Stats.mean(rets) * 0.3;
  const mu = muBase + composite * 0.15 * sigma;

  const horizons = [Math.floor(horizon / 4), Math.floor(horizon / 2), horizon];
  const terminalByH = horizons.map(() => []);
  let upCount = 0;

  for (let p = 0; p < paths; p++) {
    let logS = Math.log(S0);
    let hi = 0;
    for (let t = 1; t <= horizon; t++) {
      // Box-Muller
      const u1 = Math.random() || 1e-9, u2 = Math.random();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      logS += mu - sigma * sigma / 2 + sigma * z;
      if (t === horizons[hi]) { terminalByH[hi].push(Math.exp(logS)); hi++; if (hi >= horizons.length) break; }
    }
    if (logS > Math.log(S0)) upCount++;
  }

  const pct = [5, 25, 50, 75, 95];
  const rows = horizons.map((h, i) => {
    const r = { horizon: h };
    pct.forEach(p => { r['p' + p] = Stats.percentile(terminalByH[i], p); });
    return r;
  });

  return {
    S0, horizon, paths, mu, sigma,
    probUp: upCount / paths,
    rows,
    // 供画带状图用
    band: pct.map(p => ({ pct: p, values: rows.map(r => r['p' + p]) })),
  };
}

// ---------------- 历史条件胜率（样本内统计，供参考） ----------------
export function conditionalStats(candles, currentComposite, forwardBars = 12, tolerance = 0.08) {
  const n = candles.length;
  const minHist = 80;
  if (n < minHist + forwardBars + 10) return null;
  const curBucket = Math.abs(currentComposite) < 0.15 ? 0 : Math.sign(currentComposite);
  let matches = 0, wins = 0, sumRet = 0;
  const fwd = [];
  for (let i = minHist; i < n - forwardBars; i++) {
    const slice = candles.slice(0, i + 1);
    const f = computeFactors(slice, null);
    if (!f) continue;
    const bucket = Math.abs(f.composite) < 0.15 ? 0 : Math.sign(f.composite);
    if (bucket !== curBucket || curBucket === 0 && bucket !== 0) continue;
    if (curBucket === 0 && Math.abs(f.composite) >= 0.15) continue;
    const r = candles[i + forwardBars].close / candles[i].close - 1;
    const signed = curBucket === 0 ? r : r * curBucket;
    fwd.push(signed);
    matches++;
    sumRet += signed;
    if (signed > 0) wins++;
  }
  if (matches < 15) return null;
  return {
    matches, forwardBars,
    winRate: wins / matches,
    avgRet: sumRet / matches,
    medianRet: Stats.percentile(fwd, 50),
    expectancyNote: '样本内统计，不代表未来',
  };
}

// ---------------- Holt 点预测 ----------------
export function pointForecast(candles, h = 12) {
  const c = candles.map(x => x.close);
  return holtForecast(c, h);
}

// ---------------- 回归通道 ----------------
export function regChannel(candles, p = 60) {
  const c = candles.map(x => x.close);
  const reg = logLinReg(c, p);
  if (!reg) return null;
  const price = c[c.length - 1];
  return {
    ...reg,
    slopePctPerBar: (Math.exp(reg.slope) - 1) * 100,
    upper: price * 0 + Math.exp(reg.intercept + reg.slope * (p - 1) + 2 * reg.resStd),
    lower: Math.exp(reg.intercept + reg.slope * (p - 1) - 2 * reg.resStd),
    mid: Math.exp(reg.intercept + reg.slope * (p - 1)),
  };
}

// ---------------- 回测引擎（含手续费 + 滑点 + 基准对比） ----------------
export function runBacktest(candles, interval, options = {}) {
  const { feeRate = 0.0005, slippage = 0.0002, fundingRatePer8h = 0.0001, warmup = 200 } = options;
  const n = candles.length;
  if (n < warmup + 50) return { error: '数据不足，至少需要 ' + (warmup + 50) + ' 根K线' };

  const ppy = Stats.periodsPerYear(interval);
  const barsPer8h = Math.max(1, Math.round(288e5 / Stats.intervalMs(interval)));
  const equity = [1.0];
  const bhEquity = [1.0]; // 买入持有基准
  const returns = [];
  const trades = [];
  let position = 0;
  const sigLog = []; // 信号准确率统计

  for (let i = warmup; i < n - 1; i++) {
    const slice = candles.slice(0, i + 1);
    const factors = computeFactors(slice, null);
    if (!factors) continue;
    const posInfo = computePosition(factors.composite, slice, interval);
    const desiredPos = posInfo.direction * posInfo.size;

    const prevClose = candles[i - 1] ? candles[i - 1].close : candles[i].close;
    const currClose = candles[i].close;

    let barReturn = 0;
    if (position !== 0) {
      const barChange = (currClose - prevClose) / prevClose;
      barReturn = position * barChange;
      if (i % barsPer8h === 0 && position > 0) barReturn -= fundingRatePer8h * Math.abs(position);
    }
    returns.push(barReturn);
    equity.push(equity[equity.length - 1] * Math.exp(barReturn));
    bhEquity.push(bhEquity[bhEquity.length - 1] * (currClose / prevClose));

    // 记录信号 → 未来 1 bar 实际方向（用于信号命中率）
    if (Math.abs(factors.composite) >= 0.15) {
      const fwdRet = candles[i + 1].close / currClose - 1;
      sigLog.push({ dir: Math.sign(factors.composite), correct: Math.sign(fwdRet) === Math.sign(factors.composite) });
    }

    const posChange = desiredPos - position;
    if (Math.abs(posChange) > 0.1) {
      const cost = Math.abs(posChange) * (feeRate + slippage);
      equity[equity.length - 1] *= (1 - cost);
      if (Math.sign(desiredPos) !== Math.sign(position) || Math.abs(posChange) > 0.3) {
        trades.push({ time: candles[i + 1].time, from: position, to: desiredPos, price: candles[i + 1].open, score: factors.composite });
      }
      position = desiredPos;
    }
  }

  const totalReturn = equity[equity.length - 1] - 1;
  const years = returns.length / ppy;
  const annualizedReturn = years > 0 ? Math.pow(1 + totalReturn, 1 / years) - 1 : 0;
  const annualizedVol = Stats.std(returns) * Math.sqrt(ppy);
  const sharpe = Stats.sharpe(returns, ppy);
  const sortino = Stats.sortino(returns, ppy);
  const mdd = Stats.maxDrawdown(equity);
  const calmar = Stats.calmar(returns, equity, ppy);

  const winTrades = returns.filter(r => r > 0.0001);
  const lossTrades = returns.filter(r => r < -0.0001);
  const winRate = (winTrades.length + lossTrades.length) > 0 ? winTrades.length / (winTrades.length + lossTrades.length) : 0;
  const avgWin = winTrades.length > 0 ? Stats.mean(winTrades) : 0;
  const avgLoss = lossTrades.length > 0 ? Math.abs(Stats.mean(lossTrades)) : 0;
  const profitFactor = avgLoss > 0 ? (winRate * avgWin) / ((1 - winRate) * avgLoss) : 0;

  const bhTotal = bhEquity[bhEquity.length - 1] - 1;
  const bhAnn = years > 0 ? Math.pow(1 + bhTotal, 1 / years) - 1 : 0;
  const bhMdd = Stats.maxDrawdown(bhEquity);
  const bhRets = Stats.logReturns(bhEquity);
  const bhSharpe = Stats.sharpe(bhRets, ppy);

  const sigAccuracy = sigLog.length ? sigLog.filter(s => s.correct).length / sigLog.length : null;

  const { var: var95, es: es95 } = Stats.varEs(returns, 95);

  return {
    equity, bhEquity, returns, trades,
    metrics: {
      totalReturn, annualizedReturn, annualizedVol, sharpe, sortino, mdd, calmar,
      winRate, avgWin, avgLoss, profitFactor, numTrades: trades.length, numBars: returns.length,
      var95, es95, sigAccuracy, sigCount: sigLog.length,
    },
    buyHold: { totalReturn: bhTotal, annualizedReturn: bhAnn, mdd: bhMdd, sharpe: bhSharpe },
  };
}

// ---------------- 交易计划生成器 ----------------
// 输入价格/ATR/年化波动/评分，输出完整可执行计划：
// 入场、止损（2.5×ATR）、两档止盈（1.5R / 2.5R）、杠杆、保证金占比（单笔风险 1% 账户）
export function buildTradePlan(price, atr, annualizedVol, score) {
  if (price == null || atr == null || atr <= 0 || score == null || Math.abs(score) < 0.08) return null;

  const isLong = score > 0;
  const entry = price;

  const stopLoss = isLong ? entry - atr * 2.5 : entry + atr * 2.5;
  const stopDistance = Math.abs(entry - stopLoss);
  const stopPct = stopDistance / entry * 100;

  const tp1 = isLong ? entry + stopDistance * 1.5 : entry - stopDistance * 1.5;
  const tp2 = isLong ? entry + stopDistance * 2.5 : entry - stopDistance * 2.5;
  const tp1Pct = Math.abs(tp1 - entry) / entry * 100;
  const tp2Pct = Math.abs(tp2 - entry) / entry * 100;

  // 杠杆：目标年化波动 20%，再按信号强度 ±20% 微调
  let baseLev = 10 * 0.20 / Math.max(0.10, annualizedVol || 1);
  baseLev = Math.max(1, Math.min(10, baseLev));
  const signalAdj = Stats.clamp(0.6 + Math.abs(score) * 2.0, 0.6, 1.2);
  const leverage = Math.max(1, Math.round(baseLev * signalAdj));

  // 保证金占比：单笔亏损 = 保证金% × 杠杆 × 止损% = 账户 1%
  const marginPct = Stats.clamp((1.0 / (leverage * stopPct)) * 100, 1, 50);

  return {
    direction: isLong ? '做多' : '做空', isLong,
    entry, stopLoss, tp1, tp2,
    stopPct, tp1Pct, tp2Pct,
    rr1: '1:1.5', rr2: '1:2.5',
    leverage, marginPct,
    riskPerTrade: 1.0, // 单笔风险预算（账户%）
  };
}

// ---------------- 最强/最弱因子组 ----------------
export function extremeGroups(groupAverages) {
  let strongest = null, weakest = null;
  for (const g in groupAverages) {
    const v = groupAverages[g];
    if (!strongest || v > strongest.value) strongest = { key: g, value: v };
    if (!weakest || v < weakest.value) weakest = { key: g, value: v };
  }
  return { strongest, weakest };
}
