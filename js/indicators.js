// Technical analysis primitives.
// Every series is a plain array aligned with the candle array; warm-up bars are NaN.
// Formulas follow TradingView Pine (ta.*) conventions so values can be cross-checked.

export const isNum = Number.isFinite;

export const closes = c => c.map(k => k.close);
export const highs = c => c.map(k => k.high);
export const lows = c => c.map(k => k.low);
export const volumes = c => c.map(k => k.volume);
export const hlc3 = c => c.map(k => (k.high + k.low + k.close) / 3);

// Rolling mean that restarts after a NaN, like ta.sma.
export function SMA(src, n) {
  const out = new Array(src.length).fill(NaN);
  let sum = 0, cnt = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (!isNum(v)) { sum = 0; cnt = 0; continue; }
    sum += v; cnt++;
    if (cnt > n) { sum -= src[i - n]; cnt = n; }
    if (cnt === n) out[i] = sum / n;
  }
  return out;
}

export function WMA(src, n) {
  const out = new Array(src.length).fill(NaN);
  const denom = n * (n + 1) / 2;
  let run = 0;
  for (let i = 0; i < src.length; i++) {
    if (!isNum(src[i])) { run = 0; continue; }
    if (++run < n) continue;
    let s = 0;
    for (let j = 0; j < n; j++) s += src[i - j] * (n - j);
    out[i] = s / denom;
  }
  return out;
}

// Exponential smoothing seeded with the SMA of the first n valid values (ta.ema / ta.rma).
function smooth(src, n, alpha) {
  const out = new Array(src.length).fill(NaN);
  let prev, sum = 0, cnt = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (!isNum(v)) { if (prev !== undefined) out[i] = prev; continue; }
    if (prev === undefined) { sum += v; if (++cnt === n) out[i] = prev = sum / n; }
    else out[i] = prev = alpha * v + (1 - alpha) * prev;
  }
  return out;
}
export const EMA = (src, n) => smooth(src, n, 2 / (n + 1));
export const RMA = (src, n) => smooth(src, n, 1 / n);

function rolling(src, n, fn) {
  const out = new Array(src.length).fill(NaN);
  for (let i = n - 1; i < src.length; i++) {
    const w = src.slice(i - n + 1, i + 1);
    if (w.every(isNum)) out[i] = fn(w);
  }
  return out;
}
export const highest = (src, n) => rolling(src, n, w => Math.max(...w));
export const lowest = (src, n) => rolling(src, n, w => Math.min(...w));
export const rollingSum = (src, n) => rolling(src, n, w => w.reduce((a, b) => a + b, 0));
export const stdev = (src, n) => rolling(src, n, w => {
  const m = w.reduce((a, b) => a + b, 0) / n;
  return Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / n);
});

export function RSI(src, n = 14) {
  const up = src.map((v, i) => i ? Math.max(v - src[i - 1], 0) : NaN);
  const dn = src.map((v, i) => i ? Math.max(src[i - 1] - v, 0) : NaN);
  const au = RMA(up, n), ad = RMA(dn, n);
  return src.map((_, i) => !isNum(au[i]) ? NaN : ad[i] === 0 ? 100 : au[i] === 0 ? 0 : 100 - 100 / (1 + au[i] / ad[i]));
}

export function MACD(src, fast = 12, slow = 26, sig = 9) {
  const f = EMA(src, fast), s = EMA(src, slow);
  const macd = src.map((_, i) => f[i] - s[i]);
  const signal = EMA(macd, sig);
  return { macd, signal, hist: macd.map((v, i) => v - signal[i]) };
}

// handleNa=true mirrors ta.tr(true): the first bar uses high - low.
export function trueRange(c, handleNa = true) {
  return c.map((k, i) => i === 0 ? (handleNa ? k.high - k.low : NaN)
    : Math.max(k.high - k.low, Math.abs(k.high - c[i - 1].close), Math.abs(k.low - c[i - 1].close)));
}
export const ATR = (c, n = 14) => RMA(trueRange(c), n);

export function bollinger(src, n = 20, mult = 2) {
  const basis = SMA(src, n), dev = stdev(src, n);
  return { basis, upper: basis.map((b, i) => b + mult * dev[i]), lower: basis.map((b, i) => b - mult * dev[i]) };
}

// TTM-squeeze style channel: SMA basis with ATR bands.
export function keltner(c, n = 20, mult = 1.5) {
  const basis = SMA(closes(c), n), atr = ATR(c, n);
  return { basis, upper: basis.map((b, i) => b + mult * atr[i]), lower: basis.map((b, i) => b - mult * atr[i]) };
}

export function CCI(c, n = 20) {
  const tp = hlc3(c), ma = SMA(tp, n);
  return tp.map((v, i) => {
    if (!isNum(ma[i])) return NaN;
    let md = 0;
    for (let j = i - n + 1; j <= i; j++) md += Math.abs(tp[j] - ma[i]);
    md /= n;
    return md ? (v - ma[i]) / (0.015 * md) : 0;
  });
}

export function DMI(c, n = 14, adxLen = 14) {
  const tr = trueRange(c, false);
  const pdm = c.map((k, i) => {
    if (!i) return NaN;
    const up = k.high - c[i - 1].high, dn = c[i - 1].low - k.low;
    return up > dn && up > 0 ? up : 0;
  });
  const mdm = c.map((k, i) => {
    if (!i) return NaN;
    const up = k.high - c[i - 1].high, dn = c[i - 1].low - k.low;
    return dn > up && dn > 0 ? dn : 0;
  });
  const atr = RMA(tr, n), sp = RMA(pdm, n), sm = RMA(mdm, n);
  const pdi = sp.map((v, i) => 100 * v / atr[i]);
  const mdi = sm.map((v, i) => 100 * v / atr[i]);
  const dx = pdi.map((p, i) => { const s = p + mdi[i]; return 100 * Math.abs(p - mdi[i]) / (s === 0 ? 1 : s); });
  return { pdi, mdi, adx: RMA(dx, adxLen) };
}

// Same band ratchet and flip rules as ta.supertrend; dir is 1 for up, -1 for down
// (Pine uses the opposite sign).
export function superTrend(c, atrLen = 10, factor = 3) {
  const atr = ATR(c, atrLen), n = c.length;
  const line = new Array(n).fill(NaN), dir = new Array(n).fill(NaN);
  let pu = NaN, pl = NaN, pst = NaN;
  for (let i = 0; i < n; i++) {
    if (!isNum(atr[i])) continue;
    const mid = (c[i].high + c[i].low) / 2;
    let up = mid + factor * atr[i], lo = mid - factor * atr[i];
    const c1 = i ? c[i - 1].close : NaN;
    if (isNum(pl)) lo = (lo > pl || c1 < pl) ? lo : pl;
    if (isNum(pu)) up = (up < pu || c1 > pu) ? up : pu;
    let d;
    if (!isNum(pst)) d = -1;
    else if (pst === pu) d = c[i].close > up ? 1 : -1;
    else d = c[i].close < lo ? -1 : 1;
    line[i] = d === 1 ? lo : up;
    dir[i] = d;
    pu = up; pl = lo; pst = line[i];
  }
  return { line, dir };
}

// The cloud is shifted displacement - 1 bars forward, matching TradingView's plot offset.
export function ichimoku(c, conv = 9, base = 26, spanB = 52, disp = 26) {
  const h = highs(c), l = lows(c);
  const mid = n => { const hh = highest(h, n), ll = lowest(l, n); return hh.map((v, i) => (v + ll[i]) / 2); };
  const tenkan = mid(conv), kijun = mid(base), b = mid(spanB);
  const a = tenkan.map((t, i) => (t + kijun[i]) / 2);
  const shift = disp - 1;
  const cloudA = c.map((_, i) => i >= shift ? a[i - shift] : NaN);
  const cloudB = c.map((_, i) => i >= shift ? b[i - shift] : NaN);
  return { tenkan, kijun, cloudA, cloudB };
}

export function HMA(src, n = 21) {
  const half = WMA(src, Math.floor(n / 2)), full = WMA(src, n);
  return WMA(half.map((v, i) => 2 * v - full[i]), Math.round(Math.sqrt(n)));
}

export function choppiness(c, n = 14) {
  const s = rollingSum(trueRange(c), n), hh = highest(highs(c), n), ll = lowest(lows(c), n);
  return s.map((v, i) => 100 * Math.log10(v / (hh[i] - ll[i])) / Math.log10(n));
}

export const donchian = (c, n = 20) => ({ upper: highest(highs(c), n), lower: lowest(lows(c), n) });

export function OBV(c) {
  let acc = 0;
  return c.map((k, i) => {
    if (i) { const d = k.close - c[i - 1].close; acc += d > 0 ? k.volume : d < 0 ? -k.volume : 0; }
    return acc;
  });
}

export function MFI(c, n = 14) {
  const tp = hlc3(c);
  const pos = tp.map((v, i) => i ? (v > tp[i - 1] ? v * c[i].volume : 0) : NaN);
  const neg = tp.map((v, i) => i ? (v < tp[i - 1] ? v * c[i].volume : 0) : NaN);
  const up = rollingSum(pos, n), dn = rollingSum(neg, n);
  return up.map((u, i) => {
    if (!isNum(u)) return NaN;
    if (dn[i] === 0) return u === 0 ? 50 : 100;
    return 100 - 100 / (1 + u / dn[i]);
  });
}

export function CMF(c, n = 20) {
  const mfv = c.map(k => { const r = k.high - k.low; return r ? ((k.close - k.low) - (k.high - k.close)) / r * k.volume : 0; });
  const a = rollingSum(mfv, n), v = rollingSum(volumes(c), n);
  return a.map((x, i) => v[i] ? x / v[i] : NaN);
}

// Anchored to each UTC day.
export function VWAP(c) {
  let day = null, pv = 0, vol = 0;
  return c.map(k => {
    const d = Math.floor(k.time / 86400);
    if (d !== day) { day = d; pv = 0; vol = 0; }
    pv += (k.high + k.low + k.close) / 3 * k.volume;
    vol += k.volume;
    return vol ? pv / vol : NaN;
  });
}

// Time-weighted average of each bar's OHLC4, anchored to each UTC day.
export function TWAP(c) {
  let day = null, sum = 0, n = 0;
  return c.map(k => {
    const d = Math.floor(k.time / 86400);
    if (d !== day) { day = d; sum = 0; n = 0; }
    sum += (k.open + k.high + k.low + k.close) / 4;
    return sum / ++n;
  });
}

// Relative volume of bar i. Intraday: against bars at the same UTC time of day on up to
// `days` previous days. Daily and weekly: against the previous `days` bars.
export function RVOL(c, i, intraday, days = 10) {
  const v = c[i].volume;
  const ref = [];
  if (intraday) {
    const tod = c[i].time % 86400;
    for (let j = i - 1; j >= 0 && ref.length < days; j--) {
      if (c[j].time % 86400 === tod && c[j].time < c[i].time) ref.push(c[j].volume);
    }
  } else {
    for (let j = i - 1; j >= 0 && ref.length < days; j--) ref.push(c[j].volume);
  }
  if (ref.length < 2) return { value: NaN, samples: ref.length };
  const avg = ref.reduce((a, b) => a + b, 0) / ref.length;
  return { value: avg ? v / avg : NaN, samples: ref.length };
}

// COT index (Larry Williams): where the latest net position sits inside its range over the
// last `weeks` reports, 0 = most short, 100 = most long.
export function cotIndex(rows, weeks = 156, invert = false) {
  const w = rows.slice(-weeks);
  const idx = key => {
    const v = w.map(r => r[key]), lo = Math.min(...v), hi = Math.max(...v), x = v[v.length - 1];
    const i = hi === lo ? 50 : 100 * (x - lo) / (hi - lo);
    return invert ? 100 - i : i;
  };
  return { spec: idx('spec'), comm: idx('comm'), date: w[w.length - 1].date, weeks: w.length };
}

// Seasonal index from monthly bars: average return of each calendar month over up to `years`
// past years, and the share of those years that closed higher.
export function seasonal(monthly, now = new Date(), years = 15) {
  const curKey = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const key = t => { const d = new Date(t * 1000); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
  const returns = [];
  for (let i = 1; i < monthly.length; i++) {
    const k = key(monthly[i].time);
    if (k >= curKey || k - key(monthly[i - 1].time) !== 1) continue;
    returns.push({ m: k % 12, r: monthly[i].close / monthly[i - 1].close - 1 });
  }
  const byMonth = Array.from({ length: 12 }, (_, m) => {
    const rs = returns.filter(x => x.m === m).slice(-years).map(x => x.r);
    return { m, n: rs.length, avg: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : NaN, win: rs.length ? rs.filter(r => r > 0).length / rs.length : NaN };
  });
  return { ...byMonth[now.getUTCMonth()], byMonth };
}

// Options volume profile from per-instrument summaries [{ strike, type: 'C'|'P', volume, oi }].
export function optionsProfile(list) {
  const byStrike = new Map();
  let callVol = 0, putVol = 0;
  for (const o of list) {
    const s = byStrike.get(o.strike) || { strike: o.strike, callVol: 0, putVol: 0, callOi: 0, putOi: 0 };
    if (o.type === 'C') { s.callVol += o.volume; s.callOi += o.oi; callVol += o.volume; }
    else { s.putVol += o.volume; s.putOi += o.oi; putVol += o.volume; }
    byStrike.set(o.strike, s);
  }
  const strikes = [...byStrike.values()].sort((a, b) => a.strike - b.strike);
  const top = (f) => strikes.reduce((b, s) => (!b || f(s) > f(b) ? s : b), null);
  return {
    strikes,
    putCallRatio: callVol ? putVol / callVol : NaN,
    poc: top(s => s.callVol + s.putVol)?.strike,
    callWall: top(s => s.callOi)?.strike,
    putWall: top(s => s.putOi)?.strike,
    callVol, putVol,
  };
}

// Needs takerBuy (base-asset volume bought by takers), which Binance klines provide.
export const delta = c => c.map(k => isNum(k.takerBuy) ? 2 * k.takerBuy - k.volume : NaN);
export function CVD(c) {
  let acc = 0;
  return delta(c).map(d => isNum(d) ? (acc += d) : NaN);
}

// Unfilled three-candle fair value gaps in the last `lookback` bars.
export function fairValueGaps(c, lookback = 150) {
  const gaps = [];
  for (let i = Math.max(2, c.length - lookback); i < c.length; i++) {
    if (c[i].low > c[i - 2].high) gaps.push({ type: 1, bottom: c[i - 2].high, top: c[i].low, i });
    else if (c[i].high < c[i - 2].low) gaps.push({ type: -1, bottom: c[i].high, top: c[i - 2].low, i });
  }
  return gaps.filter(g => {
    for (let j = g.i + 1; j < c.length; j++) {
      if (g.type === 1 ? c[j].low <= g.bottom : c[j].high >= g.top) return false;
    }
    return true;
  });
}

// Fractal swing highs and lows: a bar beats `side` bars on each side.
export function swingLevels(c, side = 3, lookback = 200) {
  const hi = [], lo = [];
  for (let i = Math.max(side, c.length - lookback); i < c.length - side; i++) {
    let isH = true, isL = true;
    for (let j = i - side; j <= i + side; j++) {
      if (j === i) continue;
      if (c[j].high >= c[i].high) isH = false;
      if (c[j].low <= c[i].low) isL = false;
    }
    if (isH) hi.push(c[i].high);
    if (isL) lo.push(c[i].low);
  }
  return { highs: hi, lows: lo };
}

export function candlePattern(c, i) {
  const k = c[i], p = c[i - 1];
  if (!k || !p) return null;
  const range = k.high - k.low;
  if (!range) return null;
  const body = Math.abs(k.close - k.open), pBody = Math.abs(p.close - p.open);
  const pTop = Math.max(p.open, p.close), pBot = Math.min(p.open, p.close);
  if (p.close < p.open && k.close > k.open && k.close >= pTop && k.open <= pBot && body > pBody) return { name: 'Bull engulfing', dir: 1 };
  if (p.close > p.open && k.close < k.open && k.open >= pTop && k.close <= pBot && body > pBody) return { name: 'Bear engulfing', dir: -1 };
  const upper = k.high - Math.max(k.open, k.close), lower = Math.min(k.open, k.close) - k.low;
  if (lower >= 2 * body && lower >= 0.6 * range) return { name: 'Bull pin bar', dir: 1 };
  if (upper >= 2 * body && upper >= 0.6 * range) return { name: 'Bear pin bar', dir: -1 };
  if (body <= 0.1 * range) return { name: 'Doji', dir: 0 };
  return null;
}
