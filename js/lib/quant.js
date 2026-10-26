// ============================================================
// quant.js · 量化引擎：多因子信号 / 市场状态 / 预测 / 仓位 / 回测
// ============================================================
import {
  Stats, SMA, EMA, RSI, MACD, Boll, ATR, StochRSI, ADX,
  VWAP, OBV, Keltner, Fib, efficiencyRatio, logLinReg, holtForecast, hurst,
} from './stats.js';
import { fundingDynamics, fundingDynamicScores } from './funding.js';

export const FACTOR_WEIGHTS = { trend: 0.22, momentum: 0.18, meanRev: 0.13, volume: 0.13, volatility: 0.09, position: 0.05, htf: 0.10, futures: 0.10, news: 0.05 };
export const GROUP_NAMES = { trend: '趋势', momentum: '动量', meanRev: '均值回归', volume: '量能', volatility: '波动率', position: '位置', htf: '高周期', futures: '合约数据', news: '消息面' };

// ---------------- 高周期重采样（无未来函数） ----------------
// 把基础周期收盘价重采样到 f 倍周期（1h→4h/日线），只保留已完成的 bar
function resampleCloses(arr, f) {
  const m = Math.floor(arr.length / f), out = [];
  for (let j = 0; j < m; j++) out.push(arr[(j + 1) * f - 1]);
  return out;
}
// 大周期第 j 个完整 bar 覆盖基础 bar [j*f, (j+1)*f)，基础 bar i 只能看到 i//f - 1
function mapHtf(resampledValues, len, f) {
  const out = new Array(len).fill(null);
  for (let i = 0; i < len; i++) {
    const j = Math.floor(i / f) - 1;
    if (j >= 0 && j < resampledValues.length) out[i] = resampledValues[j];
  }
  return out;
}

// ---------------- 学习模型注入 ----------------
// 由 model.js 拉取 data/model.json 后调用 setModel() 注入云端训练出的权重。
// 未加载（首次访问/离线/训练未产出）时回退到上面的静态 FACTOR_WEIGHTS。
let MODEL = null;
export function setModel(m) { MODEL = m; }
export function getModelInfo() { return MODEL; }

// 浏览器执行云端导出的可移植模型。训练端已做 Python/AST 对拍，前端保持同一套预处理与树遍历。
export function evalModelAST(ast, rowRaw) {
  if (!ast || !Array.isArray(rowRaw)) return null;
  const evalSub = (sub, raw) => {
    const prep = sub.prep || {};
    let x = sub.cols.map(i => Number(rowRaw[i]));
    x = x.map((v, i) => Number.isFinite(v) ? v : (prep.med?.[i] ?? 0));
    if (prep.kind === 'zm') x = x.map((v, i) => (v - prep.mu[i]) / prep.sd[i]);
    if (sub.type === 'linear') return sub.coef.reduce((s, w, i) => s + w * x[i], sub.intercept || 0);
    if (sub.type === 'mlp') {
      let a = x;
      for (let l = 0; l < sub.coefs.length; l++) {
        const out = sub.intercepts[l].map((b, j) => b + sub.coefs[l].reduce((s, row, i) => s + row[j] * a[i], 0));
        a = l < sub.coefs.length - 1 ? out.map(v => Math.max(0, v)) : out;
      }
      return a[0];
    }
    if (sub.type === 'trees') {
      let total = sub.base || 0;
      for (const tree of sub.trees) {
        let i = 0;
        for (let guard = 0; guard < 10000; guard++) {
          const nd = tree.nodes[i];
          if (!nd) return null;
          if (nd.leaf) { total += (sub.scale ?? 1) * nd.v; break; }
          const v = x[nd.f];
          i = Number.isFinite(v) ? (v <= nd.t ? nd.l : nd.r) : (sub.missingLeft ? nd.l : nd.r);
        }
      }
      return total;
    }
    return null;
  };
  if (ast.type === 'gated') {
    const rv = rowRaw[ast.regimeIdx];
    let b = 0;
    if (Number.isFinite(rv)) { b = ast.edges.filter(e => rv >= e).length; b = Math.max(0, Math.min(b, ast.models.length - 1)); }
    return evalSub(ast.models[b] || ast.fallback, rowRaw);
  }
  return evalSub(ast, rowRaw);
}

export function coinModelInfo(symbol) {
  const coin = symbol && MODEL?.coinModels?.[symbol];
  if (!coin) return null;
  return { ...coin, active: coin.status ? coin.status === 'active' : !!coin.weights, version: MODEL.version, trainedAt: MODEL.trainedAt };
}

// ---------------- 信号分级 ----------------
export function signalOf(composite) {
  if (composite >= 0.35) return { label: '强烈做多', cls: 'sbuy', dir: 1 };
  if (composite >= 0.15) return { label: '做多', cls: 'buy', dir: 1 };
  if (composite <= -0.35) return { label: '强烈做空', cls: 'ssell', dir: -1 };
  if (composite <= -0.15) return { label: '做空', cls: 'sell', dir: -1 };
  return { label: '观望', cls: 'hold', dir: 0 };
}

// ---------------- 七因子引擎 ----------------
// 权重选择：分段专业化模型（板块 > 规模 > 全局），仅采用云端标记 good=true 的分段，
// 未命中或分段不达标时回退全局学习权重，再退静态权重
function pickWeights(symbol) {
  if (MODEL && MODEL.weights) {
    const coin = symbol && MODEL.coinModels && MODEL.coinModels[symbol];
    // 新版影子/预热模型只用于观察，不得接管评分；旧版无 status 的模型保持兼容。
    if (coin && coin.weights && (!coin.status || coin.status === 'active')) {
      return { weights: coin.weights, scale: coin.scoreScale, src: '逐币', coin };
    }
    const meta = symbol && MODEL.symbolMeta && MODEL.symbolMeta[symbol];
    if (meta && MODEL.segments) {
      const catSeg = MODEL.segments['cat:' + meta.cat];
      if (catSeg && catSeg.good && catSeg.weights) return { weights: catSeg.weights, scale: catSeg.scoreScale, src: `板块·${meta.cat}${catSeg.flipped ? '·反向' : ''}` };
      const sizeSeg = MODEL.segments['size:' + meta.size];
      if (sizeSeg && sizeSeg.good && sizeSeg.weights) return { weights: sizeSeg.weights, scale: sizeSeg.scoreScale, src: `规模·${meta.size}${sizeSeg.flipped ? '·反向' : ''}` };
    }
    return { weights: MODEL.weights, scale: MODEL.scoreScale, src: 'global' };
  }
  return { weights: FACTOR_WEIGHTS, scale: 0, src: 'static' };
}

// 当前实际生效的模型；影子模型的诊断由 coinModelInfo 单独提供。
export function weightSourceInfo(symbol) {
  const coin = coinModelInfo(symbol);
  const base = { coinStatus: coin?.status || null, coinT: coin?.t ?? null, deltaIC: coin?.deltaIC ?? null, foldICs: coin?.foldICs || [] };
  if (!MODEL || !MODEL.weights) return { ...base, kind: 'static', key: null, flipped: false, ic: null };
  if (coin?.active && coin.weights) return { ...base, kind: 'coin', key: symbol, flipped: false, ic: coin.ic != null ? Math.abs(coin.ic) : null, modelType: coin.modelType };
  const meta = symbol && MODEL.symbolMeta && MODEL.symbolMeta[symbol];
  if (meta && MODEL.segments) {
    const catSeg = MODEL.segments['cat:' + meta.cat];
    if (catSeg && catSeg.good && catSeg.weights) return { ...base, kind: 'cat', key: meta.cat, flipped: !!catSeg.flipped, ic: catSeg.icXS != null ? Math.abs(catSeg.icXS) : null };
    const sizeSeg = MODEL.segments['size:' + meta.size];
    if (sizeSeg && sizeSeg.good && sizeSeg.weights) return { ...base, kind: 'size', key: meta.size, flipped: !!sizeSeg.flipped, ic: sizeSeg.icXS != null ? Math.abs(sizeSeg.icXS) : null };
  }
  return { ...base, kind: 'global', key: null, flipped: false, ic: MODEL.oos?.icXS != null ? Math.abs(MODEL.oos.icXS) : null };
}

export function computeFactors(candles, extraData, symbol) {
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

  // 高周期共振（4× = 4h、24× = 日线；仅用已完成的大周期 bar）
  const c4 = resampleCloses(c, 4), c24 = resampleCloses(c, 24);
  const emaD = EMA(c24, 20);
  const dTrendMap = mapHtf(c24.map((x, j) => emaD[j] == null ? null : Math.sign(x - emaD[j])), c.length, 24);
  const dSlopeMap = mapHtf(emaD.map((x, j) => (x == null || j < 3 || emaD[j - 3] == null) ? null : Math.sign(x - emaD[j - 3]) * 0.5), c.length, 24);
  const rsi4Map = mapHtf(RSI(c4, 14).map(x => x == null ? null : C((50 - x) / 20, -1, 1)), c.length, 4);
  const macd4Map = mapHtf(MACD(c4).histogram.map(x => x == null ? null : Math.sign(x) * 0.5), c.length, 4);
  const htfParts = [dTrendMap[n], dSlopeMap[n], rsi4Map[n], macd4Map[n]].filter(x => x != null);
  const htfScore = htfParts.length ? Stats.mean(htfParts) : 0;

  let fundingScore = 0, lsRatioScore = 0, oiScore = 0;
  const funding = fundingDynamics(extraData?.fundingHist, extraData?.fundingRate);
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

  // 消息面（云端每小时快照：FGI 恐慌贪婪指数 + 该币新闻情绪/热度，VADER 打分）
  // 研究依据：极端情绪做逆向（FGI z-score），温和币面情绪顺势，过热报道降温
  let newsScore = 0;
  const nw = extraData && extraData.news;
  if (nw) {
    const parts = [];
    if (nw.fgiZ != null) parts.push(C(-nw.fgiZ / 2, -1, 1) * 0.6);        // 极端贪婪偏空 · 极端恐慌偏多
    if (nw.coinSent != null && (nw.coinBuzz ?? 0) >= 2) {
      let s = C(nw.coinSent, -1, 1) * 0.6;                                  // 温和情绪顺势
      if ((nw.coinBuzzRel ?? 0) > 3 && nw.coinSent > 0.5) s = -0.3;         // 报道过热 → 降温
      else if ((nw.coinBuzzRel ?? 0) > 3 && nw.coinSent < -0.5) s = 0.3;    // 恐慌过杀 → 反弹
      parts.push(s);
    }
    newsScore = parts.length ? Stats.mean(parts) : 0;
  }

  const futuresParts = [fundingScore, lsRatioScore, oiScore];
  // 新特征只由带显式契约的新模型启用，避免前端升级后旧 AST / 旧权重漂移。
  if (MODEL?.featureSet?.fundingDynamics) futuresParts.push(...fundingDynamicScores(funding));
  const groups = {
    trend: [emaScore, ema200Score, adxScore, keltnerScore],
    momentum: [rsiScore, macdScore, stochScore, divergenceScore],
    meanRev: [bollScore, vwapScore],
    volume: [volScore, obvScore],
    volatility: [squeezeScore],
    position: [fibScore],
    htf: [htfScore],
    futures: futuresParts,
  };
  // 消息面有数据才入组：学习权重尚无 news 键时自动回退静态权重 0.05（实盘追踪积累后再进云端训练）
  if (nw) groups.news = [newsScore];

  const picked = pickWeights(symbol);
  const weights = picked.weights;
  const groupAverages = {}, contributions = {};
  let composite = 0;
  for (const g in groups) {
    const avg = Stats.mean(groups[g]);
    groupAverages[g] = avg;
    contributions[g] = (weights[g] != null ? weights[g] : FACTOR_WEIGHTS[g]) * avg;
    composite += contributions[g];
  }
  const linearRaw = composite;
  let nonlinear = null;
  const coin = picked.coin;
  if (coin?.ast && coin.hgbBlend > 0) {
    const featureOrder = ['trend', 'momentum', 'meanRev', 'volume', 'volatility', 'position', 'htf', 'futures'];
    nonlinear = evalModelAST(coin.ast, featureOrder.map(g => groupAverages[g] || 0));
    if (Number.isFinite(nonlinear)) {
      const linearZ = linearRaw / Math.max(coin.linearScale || coin.scoreScale || 1e-8, 1e-8);
      const hgbZ = nonlinear / Math.max(coin.hgbScale || 1e-8, 1e-8);
      composite = (1 - coin.hgbBlend) * linearZ + coin.hgbBlend * hgbZ;
    }
  }
  // 不同模型的输出先各自标准化，再混合和标定，避免把不同量纲直接相加。
  if (picked.scale > 0) composite = composite / picked.scale * 0.13;

  const er = efficiencyRatio(c, 20);
  const hurstV = hurst(c);
  const logRets = Stats.logReturns(c.slice(-100));

  return {
    composite, groupAverages, groups, contributions, nonlinear,
    modelRoute: { source: picked.src, coinStatus: coinModelInfo(symbol)?.status || null, hgbApplied: Number.isFinite(nonlinear) },
    weightSource: MODEL ? `learned-v${MODEL.version || '?'}·${picked.src}` : 'static',
    rawIndicators: {
      price, atr, rsi: rsiArr[n], macdH: histogram[n], adx: adx[n], pdi: pdi[n], mdi: mdi[n],
      stochRsi: stoch[n], volRatio, squeeze,
      er, hurst: hurstV,
      ewmaVol: Stats.ewmaVol(logRets),
      ema9: ema9[n], ema21: ema21[n], ema50: ema50[n], ema200: ema200[n],
      bbUpper: bbU[n], bbLower: bbL[n], fib,
      fundingZ: funding.z, fundingDelta: funding.delta, fundingAccel: funding.accel,
      fundingEvents: funding.events,
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

// ---------------- 蒙特卡洛价格锥 v2 ----------------
// 区块自助法（Stationary Block Bootstrap）：直接重采样历史对数收益块，
// 保留加密资产的肥尾、偏度与波动聚集，远比高斯 GBM 诚实。
// 漂移 = 历史均值收缩 70% + 信号倾斜；可选传入止损/止盈价，输出先触及概率。
export function monteCarloCone(candles, composite, horizon = 24, paths = 4000, levels = null) {
  const c = candles.map(x => x.close);
  const S0 = c[c.length - 1];
  const rets = Stats.logReturns(c.slice(-150));
  if (rets.length < 40) return null;
  const sigma = Stats.ewmaVol(rets);
  const meanR = Stats.mean(rets);
  // 漂移：收缩后的历史均值 + 信号倾斜（满分 ≈ 每bar ±0.10σ）
  const tilt = meanR * 0.3 - meanR + composite * 0.10 * sigma; // 增量 = 采样值 - meanR + tilt'
  const driftPerBar = meanR * 0.3 + composite * 0.10 * sigma;

  const BLOCK = 8;
  const horizons = [Math.floor(horizon / 4), Math.floor(horizon / 2), horizon];
  const terminalByH = horizons.map(() => []);
  let upCount = 0;
  let tpFirst = 0, stopFirst = 0, touchNone = 0;
  const tp = levels && levels.tp ? levels.tp : null;
  const stop = levels && levels.stop ? levels.stop : null;
  const isLong = levels && levels.isLong;

  for (let p = 0; p < paths; p++) {
    // 生成一条 bootstrap 收益序列（块采样保留波动聚集）
    const seq = [];
    while (seq.length < horizon) {
      const start = Math.floor(Math.random() * (rets.length - BLOCK - 1));
      for (let j = 0; j < BLOCK && seq.length < horizon; j++) seq.push(rets[start + j]);
    }
    let logS = Math.log(S0);
    let hi = 0, touched = 0; // 0=未触及 1=先止盈 2=先止损
    for (let t = 0; t < horizon; t++) {
      logS += seq[t] - meanR + driftPerBar;
      const px = Math.exp(logS);
      if (t + 1 === horizons[hi]) { terminalByH[hi].push(px); hi++; if (hi >= horizons.length && !tp && !stop) break; }
      if (!touched && tp && stop) {
        if (isLong) {
          if (px >= tp) touched = 1; else if (px <= stop) touched = 2;
        } else {
          if (px <= tp) touched = 1; else if (px >= stop) touched = 2;
        }
      }
    }
    if (logS > Math.log(S0)) upCount++;
    if (touched === 1) tpFirst++;
    else if (touched === 2) stopFirst++;
    else touchNone++;
  }

  const pct = [5, 25, 50, 75, 95];
  const rows = horizons.map((h, i) => {
    const r = { horizon: h };
    pct.forEach(p => { r['p' + p] = Stats.percentile(terminalByH[i], p); });
    return r;
  });

  return {
    S0, horizon, paths, sigma,
    probUp: upCount / paths,
    rows,
    band: pct.map(p => ({ pct: p, values: rows.map(r => r['p' + p]) })),
    touch: (tp && stop) ? {
      tpFirst: tpFirst / paths, stopFirst: stopFirst / paths, none: touchNone / paths,
    } : null,
  };
}

// ---------------- GARCH(1,1) 波动率预测 ----------------
// 加密典型参数 α=0.08 β=0.90，长期方差由样本方差校准
export function garchVolForecast(candles, horizonBars = 24) {
  const c = candles.map(x => x.close);
  const rets = Stats.logReturns(c.slice(-150));
  if (rets.length < 40) return null;
  const alpha = 0.08, beta = 0.90;
  const varLR = Stats.std(rets) ** 2;
  const omega = varLR * (1 - alpha - beta);
  let v = varLR;
  for (const r of rets) v = omega + alpha * r * r + beta * v;
  // 多步预测：E[σ²_{t+h}] = varLR + (α+β)^h · (σ²_t - varLR)
  const sigmaNow = Math.sqrt(v);
  const sigmaH = Math.sqrt(varLR + Math.pow(alpha + beta, horizonBars) * (v - varLR));
  return { sigmaNow, sigmaH, varLR: Math.sqrt(varLR), persisting: alpha + beta };
}

// ---------------- 多周期融合评分 ----------------
export function fuseMTF(mtfRows) {
  const W = { '15m': 0.20, '1h': 0.35, '4h': 0.30, '1d': 0.15 };
  let sum = 0, wsum = 0;
  for (const r of mtfRows) {
    if (r.score == null) continue;
    const w = W[r.iv] || 0.1;
    sum += r.score * w; wsum += w;
  }
  return wsum > 0 ? sum / wsum : null;
}

// ---------------- 信号置信度评级 ----------------
// 置信度 = 0.45×因子一致性 + 0.35×多周期对齐 + 0.20×市场状态适配
export function signalConfidence(factors, mtfRows) {
  const sig = Math.sign(factors.composite);
  if (sig === 0) return { score: 0, grade: 'C', confluence: 0, mtfAlign: 0, regimeFit: 0 };

  let agree = 0, total = 0;
  for (const g in factors.groups) {
    for (const s of factors.groups[g]) {
      if (Math.abs(s) > 0.2) { total++; if (Math.sign(s) === sig) agree++; }
    }
  }
  const confluence = total > 0 ? agree / total : 0;

  const valid = (mtfRows || []).filter(r => r.score != null && Math.abs(r.score) >= 0.08);
  const mtfAlign = valid.length > 0
    ? valid.filter(r => Math.sign(r.score) === sig).length / valid.length
    : 0.5;

  const regime = detectRegime(factors.rawIndicators);
  const regimeFit = regime.cls === 'flat' ? 0.45 : (regime.cls === 'trend' ? 0.85 : 0.65);

  const score = Math.round(100 * (0.45 * confluence + 0.35 * mtfAlign + 0.20 * regimeFit));
  const grade = score >= 80 ? 'S' : score >= 65 ? 'A' : score >= 50 ? 'B' : 'C';
  return { score, grade, confluence, mtfAlign, regimeFit };
}

// ---------------- BTC 联动分析 ----------------
export function btcLinkage(symbolCandles, btcCandles) {
  const c1 = symbolCandles.map(x => x.close);
  const c2 = btcCandles.map(x => x.close);
  const n = Math.min(c1.length, c2.length);
  if (n < 40) return null;
  const r1 = Stats.logReturns(c1.slice(-n));
  const r2 = Stats.logReturns(c2.slice(-n));
  const m1 = Stats.mean(r1), m2 = Stats.mean(r2);
  let cov = 0, v1 = 0, v2 = 0;
  for (let i = 0; i < r1.length; i++) {
    cov += (r1[i] - m1) * (r2[i] - m2);
    v1 += (r1[i] - m1) ** 2;
    v2 += (r2[i] - m2) ** 2;
  }
  if (v2 === 0 || v1 === 0) return null;
  const beta = cov / v2;
  const corr = cov / Math.sqrt(v1 * v2);
  // 相对强度：近 24 bar 实际收益 - Beta 隐含收益
  const k = Math.min(24, r1.length);
  const recent1 = r1.slice(-k).reduce((a, b) => a + b, 0);
  const recent2 = r2.slice(-k).reduce((a, b) => a + b, 0);
  const relStrength = recent1 - beta * recent2;
  return { beta, corr, relStrength };
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
function normalCDF(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const p = 1 - Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI) *
    (0.319381530 * t - 0.356563782 * t ** 2 + 1.781477937 * t ** 3 - 1.821255978 * t ** 4 + 1.330274429 * t ** 5);
  return x >= 0 ? p : 1 - p;
}

function returnRobustness(returns, ppy, block = 12, simulations = 240) {
  const n = returns.length;
  if (n < 40) return null;
  const mu = Stats.mean(returns), sd = Stats.std(returns);
  const sr = sd > 1e-12 ? mu / sd : 0;
  const skew = sd > 1e-12 ? Stats.mean(returns.map(r => ((r - mu) / sd) ** 3)) : 0;
  const kurt = sd > 1e-12 ? Stats.mean(returns.map(r => ((r - mu) / sd) ** 4)) : 3;
  const den = Math.sqrt(Math.max(1e-8, 1 - skew * sr + (kurt - 1) / 4 * sr * sr));
  const psr = normalCDF(sr * Math.sqrt(n - 1) / den);
  // 固定种子的循环区块自助法：可复现，且保留短期波动聚集。
  let seed = 0x2f6e2b1;
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const totals = [], sharpes = [];
  for (let s = 0; s < simulations; s++) {
    let total = 0;
    const sample = [];
    while (sample.length < n) {
      const start = Math.floor(rand() * n);
      for (let j = 0; j < block && sample.length < n; j++) sample.push(returns[(start + j) % n]);
    }
    for (const r of sample) total += r;
    totals.push(Math.exp(Math.min(20, total)) - 1);
    sharpes.push(Stats.sharpe(sample, ppy));
  }
  totals.sort((a, b) => a - b); sharpes.sort((a, b) => a - b);
  return {
    psr, skew, kurtosis: kurt, block, simulations,
    returnCI95: [Stats.percentile(totals, 2.5), Stats.percentile(totals, 97.5)],
    sharpeCI95: [Stats.percentile(sharpes, 2.5), Stats.percentile(sharpes, 97.5)],
    positiveSharpeProb: sharpes.filter(x => x > 0).length / sharpes.length,
  };
}

export function runBacktest(candles, interval, options = {}) {
  const {
    feeRate = 0.0005, slippage = 0.0002, fundingRatePer8h = 0.0001,
    warmup = 200, threshold = 0.15, minTradeDelta = 0.1,
    symbol = null, startIndex = null, endIndex = null, bootstrap = true,
  } = options;
  const n = Math.min(candles.length, endIndex || candles.length);
  const firstExec = Math.max(warmup + 1, startIndex || 0);
  if (n - firstExec < 40) return { error: '有效回测区间不足 40 根K线，请增加历史或减少预热/隔离区' };

  const ppy = Stats.periodsPerYear(interval);
  const equity = [1], bhEquity = [1], returns = [], trades = [], times = [];
  let position = 0, grossEquity = 1, totalCosts = 0, fundingCashflow = 0, fundingEvents = 0, turnover = 0, exposure = 0;
  const sigLog = [];

  for (let i = firstExec; i < n; i++) {
    const prevOpen = candles[i - 1].open, execOpen = candles[i].open;
    if (!(prevOpen > 0 && execOpen > 0)) continue;
    // 旧持仓先从上一根开盘计价到本根开盘；随后才按上一根收盘信号调仓。
    const marketReturn = position * Math.log(execOpen / prevOpen);
    // 资金费按真实 UTC 00/08/16 的 bar open 结算，而不是按数组下标近似。
    const fundingDue = candles[i].time % 288e5 === 0;
    const funding = position !== 0 && fundingDue ? position * fundingRatePer8h : 0;
    if (position !== 0 && fundingDue) fundingEvents++;
    grossEquity *= Math.exp(marketReturn);

    const slice = candles.slice(0, i); // 最后一根是 i-1，绝不可包含执行 bar i
    const factors = computeFactors(slice, null, symbol);
    if (!factors) continue;
    const posInfo = computePosition(factors.composite, slice, interval);
    let desired = Math.abs(factors.composite) < threshold ? 0 : posInfo.direction * posInfo.size;
    if (Math.abs(desired - position) <= minTradeDelta) desired = position;
    const delta = desired - position;
    const cost = Math.abs(delta) * (feeRate + slippage);
    if (Math.abs(delta) > 1e-12) {
      trades.push({ time: candles[i].time, signalTime: candles[i - 1].time, from: position, to: desired, price: execOpen, score: factors.composite, cost });
      turnover += Math.abs(delta);
    }
    totalCosts += cost; fundingCashflow += funding;
    const netReturn = marketReturn - funding - cost;
    returns.push(netReturn);
    equity.push(Math.max(1e-12, equity[equity.length - 1] * Math.exp(netReturn)));
    bhEquity.push(bhEquity[bhEquity.length - 1] * execOpen / prevOpen);
    times.push(candles[i].time);
    position = desired; exposure += Math.abs(position);

    if (Math.abs(factors.composite) >= threshold) {
      const fwdRet = candles[i].close / candles[i - 1].close - 1;
      sigLog.push({ correct: Math.sign(fwdRet) === Math.sign(factors.composite) });
    }
  }
  if (returns.length < 40) return { error: '有效信号序列不足 40 根K线' };

  const lastEq = equity[equity.length - 1], totalReturn = lastEq - 1;
  const years = returns.length / ppy;
  const annualizedReturn = years > 0 ? Math.exp(Math.log(lastEq) / years) - 1 : 0;
  const annualizedVol = Stats.std(returns) * Math.sqrt(ppy);
  const sharpe = Stats.sharpe(returns, ppy), sortino = Stats.sortino(returns, ppy);
  const mdd = Stats.maxDrawdown(equity), calmar = Stats.calmar(returns, equity, ppy);
  const activeReturns = returns.filter(r => Math.abs(r) > 1e-8);
  const wins = activeReturns.filter(r => r > 0), losses = activeReturns.filter(r => r < 0);
  const winRate = activeReturns.length ? wins.length / activeReturns.length : 0;
  const grossProfit = wins.reduce((a, b) => a + b, 0), grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const bhTotal = bhEquity[bhEquity.length - 1] - 1;
  const bhAnn = years > 0 ? Math.exp(Math.log(bhEquity[bhEquity.length - 1]) / years) - 1 : 0;
  const { var: var95, es: es95 } = Stats.varEs(returns, 95);
  const robustness = bootstrap ? returnRobustness(returns, ppy) : null;

  return {
    equity, bhEquity, returns, trades, times, robustness,
    config: { feeRate, slippage, fundingRatePer8h, warmup, threshold, minTradeDelta, symbol, firstExec, end: n },
    metrics: {
      totalReturn, grossTotalReturn: grossEquity - 1, annualizedReturn, annualizedVol, sharpe, sortino, mdd, calmar,
      winRate, avgWin: wins.length ? Stats.mean(wins) : 0, avgLoss: losses.length ? Math.abs(Stats.mean(losses)) : 0,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
      numTrades: trades.length, numBars: returns.length, var95, es95,
      sigAccuracy: sigLog.length ? sigLog.filter(s => s.correct).length / sigLog.length : null, sigCount: sigLog.length,
      totalCosts, fundingCashflow, fundingEvents, turnover, exposure: exposure / returns.length,
    },
    buyHold: { totalReturn: bhTotal, annualizedReturn: bhAnn, mdd: Stats.maxDrawdown(bhEquity), sharpe: Stats.sharpe(Stats.logReturns(bhEquity), ppy) },
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
