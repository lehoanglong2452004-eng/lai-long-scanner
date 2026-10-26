// Turns candles into the scanner's votes: one entry per indicator, one vote per group,
// and a Total that uses Strength and Volatility as filters rather than votes.
import * as ta from './indicators.js';
import { t, tr, monthName } from './i18n.js';

const { isNum } = ta;

export const GROUPS = [
  { id: 'tr', name: 'Trend', short: 'Trd', votes: true },
  { id: 'sg', name: 'Strength', short: 'Str', votes: false },
  { id: 'mo', name: 'Momentum', short: 'Mom', votes: true },
  { id: 'vo', name: 'Volatility', short: 'Vlt', votes: false },
  { id: 'vl', name: 'Volume', short: 'Vol', votes: true },
  { id: 'of', name: 'Order flow', short: 'Flow', votes: true },
  { id: 'cs', name: 'Structure', short: 'Strc', votes: true },
  { id: 'mc', name: 'Macro', short: 'Mac', votes: false },
];

// needs: close | ohlc | volume | flow (taker buy volume) | trades (recent trade tape) | daily
export const INDICATORS = [
  { id: 'ema', group: 'tr', name: 'EMA 20/50/200', needs: 'close', bars: 210, rule: 'Up: price above all three EMAs and 20 > 50 > 200. Down: the reverse. Otherwise neutral.' },
  { id: 'st', group: 'tr', name: 'SuperTrend', needs: 'ohlc', bars: 15, rule: 'Up: close above the SuperTrend line (ATR 10 × 3). Down: below it.' },
  { id: 'ich', group: 'tr', name: 'Ichimoku', needs: 'ohlc', bars: 78, rule: 'Up: price above the cloud. Down: below it. Neutral: inside the cloud.' },
  { id: 'hma', group: 'tr', name: 'Hull MA 21', needs: 'close', bars: 30, rule: 'Up: Hull MA is rising. Down: it is falling.' },
  { id: 'adx', group: 'sg', name: 'ADX / DMI', needs: 'ohlc', bars: 30, state: true, rule: 'Strong: ADX above 25. Weak: 20 to 25. Flat: below 20, which turns Total into Wait. Arrow shows whether +DI or −DI leads.' },
  { id: 'chop', group: 'sg', name: 'Choppiness 14', needs: 'ohlc', bars: 20, state: true, rule: 'Ranging: above 61.8. Trending: below 38.2. Mixed in between. No vote.' },
  { id: 'rsi', group: 'mo', name: 'RSI 14', needs: 'close', bars: 20, rule: 'Up: RSI above 50. Down: below 50. OB marks above 70 (overbought), OS below 30 (oversold).' },
  { id: 'macd', group: 'mo', name: 'MACD 12/26/9', needs: 'close', bars: 40, rule: 'Up: MACD line above its signal line. Down: below it.' },
  { id: 'cci', group: 'mo', name: 'CCI 20', needs: 'ohlc', bars: 20, rule: 'Up: CCI above 0. Down: below 0. Beyond ±100 is an extreme.' },
  { id: 'atr', group: 'vo', name: 'ATR % 14', needs: 'ohlc', bars: 20, state: true, rule: 'Average true range as a percent of price. Higher means bigger candles. No vote.' },
  { id: 'sq', group: 'vo', name: 'Squeeze BB/KC', needs: 'ohlc', bars: 26, state: true, rule: 'Squeeze: Bollinger Bands (20, 2) inside the Keltner Channel (20, 1.5 ATR), a breakout may follow. Expanding: bands widening fast. No vote.' },
  { id: 'don', group: 'vo', name: 'Donchian 20', needs: 'ohlc', bars: 20, rule: 'Up: close in the top 10% of the 20-bar range. Down: bottom 10%. Not counted in Total.' },
  { id: 'spk', group: 'vl', name: 'Volume spike', needs: 'volume', bars: 21, state: true, rule: 'Bar volume against its 20-bar average. ×2 or more is a spike. No vote.' },
  { id: 'rvol', group: 'vl', name: 'RVOL', needs: 'volume', bars: 3, state: true, rule: 'High: 2× normal volume or more. Quiet: half of normal or less. Intraday bars compare with the same time of day on previous days. No vote.' },
  { id: 'obv', group: 'vl', name: 'OBV', needs: 'volume', bars: 21, rule: 'Up: OBV above its 20-bar EMA. Down: below it.' },
  { id: 'mfi', group: 'vl', name: 'MFI 14', needs: 'volume', bars: 15, rule: 'Up: MFI above 50. Down: below 50. Above 80 or below 20 is an extreme.' },
  { id: 'cmf', group: 'vl', name: 'CMF 20', needs: 'volume', bars: 20, rule: 'Up: CMF above 0, buyers accumulating. Down: below 0, sellers distributing.' },
  { id: 'vwap', group: 'vl', name: 'VWAP (daily)', needs: 'volume', bars: 2, intraday: true, rule: 'Up: price above the VWAP anchored to the UTC day. Down: below it. Intraday timeframes only.' },
  { id: 'dlt', group: 'of', name: 'Delta', needs: 'flow', bars: 2, rule: 'Taker buy volume minus taker sell volume on the bar. Up when buyers lead.' },
  { id: 'cvd', group: 'of', name: 'CVD 20', needs: 'flow', bars: 21, rule: 'Change in cumulative volume delta over the last 20 bars. Up when it rises.' },
  { id: 'big', group: 'of', name: 'Big trades', needs: 'trades', bars: 0, rule: 'Trades at least 10× the median size in the latest trade tape, buys against sells. Needs 50 or more recent trades. Same value on every timeframe.' },
  { id: 'ovp', group: 'of', name: 'Options volume profile', needs: 'options', bars: 0, state: true, rule: 'Put/call ratio of 24h option volume and the strike with the most volume (POC), from Deribit. Above 1 means more puts traded than calls. BTC and ETH only. No vote.' },
  { id: 'fvg', group: 'cs', name: 'Nearest FVG', needs: 'ohlc', bars: 10, rule: 'Up: nearest unfilled fair value gap is bullish and below price. Down: bearish and above price.' },
  { id: 'sr', group: 'cs', name: 'Support / resistance', needs: 'ohlc', bars: 50, rule: 'Swing-pivot levels. Up: price within 0.5 ATR above support. Down: within 0.5 ATR below resistance.' },
  { id: 'piv', group: 'cs', name: 'Pivot (prior period)', needs: 'ohlc', bars: 2, rule: 'Classic pivot P = (H + L + C) / 3 of the prior day (prior bar on D1 and W1). Up: price above P.' },
  { id: 'twap', group: 'cs', name: 'TWAP (daily)', needs: 'ohlc', bars: 2, intraday: true, rule: 'Up: price above the time-weighted average price of the UTC day. Down: below it. Intraday timeframes only.' },
  { id: 'cdl', group: 'cs', name: 'Candle pattern', needs: 'ohlc', bars: 3, rule: 'Up: bullish engulfing or pin bar on the last closed bar. Down: bearish version. Doji is neutral.' },
  { id: 'w52', group: 'cs', name: '52-week range', needs: 'daily', bars: 0, state: true, rule: 'Distance from the 52-week high and low, from daily data. Same value on every timeframe. No vote.' },
  { id: 'chg', group: 'cs', name: 'Change', needs: 'close', bars: 2, state: true, rule: 'Price change over 24 hours (one week on W1). No vote.' },
  { id: 'cot', group: 'mc', name: 'COT index', needs: 'cot', bars: 0, state: true, rule: 'Positioning of large speculators (Specs) and commercial hedgers (Comm) against their 3-year range, from the weekly CFTC report. Above 80: near the most long in 3 years. Below 20: near the most short. Extremes often come before reversals. Same value on every timeframe. No vote.' },
  { id: 'seas', group: 'mc', name: 'Seasonal index', needs: 'monthly', bars: 0, state: true, rule: 'Average return of the current calendar month over up to 15 past years, and the share of years it rose. 70% or more in one direction is a strong seasonal tendency. Same value on every timeframe. No vote.' },
];

// What each indicator measures and how it is calculated, shown in the detail view and the legend.
// Notation: H, L, C = high, low, close; t = current bar; HHₙ / LLₙ = highest high / lowest low of n bars.
const NOTES = {
  ema: ['Exponential moving averages track the average price, giving recent bars more weight. Their order shows the trend on short, medium and long horizons.',
    'EMAₜ = α·Cₜ + (1 − α)·EMAₜ₋₁, α = 2 / (n + 1), seeded with the SMA of the first n closes. n = 20, 50 and 200.'],
  st: ['A trailing line set a multiple of ATR away from the bar midpoint. It flips side when price closes through it.',
    'Upper = (H + L)/2 + 3·ATR(10), Lower = (H + L)/2 − 3·ATR(10). Bands only tighten while the trend lasts. The line is Lower in an uptrend and Upper in a downtrend.'],
  ich: ['Japanese equilibrium chart. The cloud is a projected zone of support or resistance.',
    'Tenkan = (HH₉ + LL₉)/2, Kijun = (HH₂₆ + LL₂₆)/2, Span A = (Tenkan + Kijun)/2, Span B = (HH₅₂ + LL₅₂)/2. Both spans are shifted 25 bars forward to form the cloud.'],
  hma: ['A moving average built to lag less than an EMA while staying smooth.',
    'HMA = WMA(2·WMA(C, 10) − WMA(C, 21), 5), where WMA weights the newest bar most.'],
  adx: ['Measures how strong a trend is, whatever its direction. +DI and −DI show which side is pushing.',
    '+DM = Hₜ − Hₜ₋₁ when it beats Lₜ₋₁ − Lₜ and is positive, else 0 (−DM is the mirror). ±DI = 100·RMA(±DM, 14) / ATR(14). DX = 100·|+DI − −DI| / (+DI + −DI). ADX = RMA(DX, 14).'],
  chop: ['Tells whether the market is trending or moving sideways.',
    'CHOP = 100·log₁₀(ΣTR over 14 bars / (HH₁₄ − LL₁₄)) / log₁₀(14).'],
  rsi: ['Compares the size of recent gains with recent losses to gauge momentum.',
    'RS = RMA(gains, 14) / RMA(losses, 14), RSI = 100 − 100 / (1 + RS). RMA is Wilder smoothing, α = 1/14.'],
  macd: ['The gap between a fast and a slow EMA. The signal line shows when momentum turns.',
    'MACD = EMA₁₂(C) − EMA₂₆(C), Signal = EMA₉(MACD), Histogram = MACD − Signal.'],
  cci: ['How far the typical price sits from its average, measured in average deviations.',
    'TP = (H + L + C)/3, CCI = (TP − SMA₂₀(TP)) / (0.015 · mean|TP − SMA₂₀(TP)|).'],
  atr: ['The average size of a bar, gaps included. Shown as a percent of price so markets can be compared.',
    'TR = max(H − L, |H − Cₜ₋₁|, |L − Cₜ₋₁|), ATR = RMA(TR, 14), ATR % = 100·ATR / C.'],
  sq: ['Spots volatility compression, when Bollinger Bands contract inside the Keltner Channel.',
    'BB = SMA₂₀(C) ± 2·σ₂₀, KC = SMA₂₀(C) ± 1.5·ATR(20). Squeeze when the BB upper band is below the KC upper band and the BB lower band is above the KC lower band.'],
  don: ['The highest high and lowest low of the last 20 bars. Breaking out of this channel often starts a trend.',
    'Upper = HH₂₀, Lower = LL₂₀, Position = (C − Lower) / (Upper − Lower).'],
  spk: ['Flags bars with unusually heavy trading.',
    'Ratio = Volumeₜ / average Volume of the previous 20 bars.'],
  rvol: ['Relative volume: how busy this bar is compared with what is normal for that time of day.',
    'Intraday: RVOL = Volumeₜ / average Volume of the bars at the same UTC time on the previous 10 days. D1 and W1: Volumeₜ / average of the previous 10 bars.'],
  obv: ['A running total of volume that adds on up bars and subtracts on down bars, to check whether volume confirms price.',
    'OBVₜ = OBVₜ₋₁ + Volume when C rises, − Volume when C falls, unchanged otherwise. Compared with EMA₂₀(OBV).'],
  mfi: ['A volume-weighted RSI that tracks money flowing in and out.',
    'Flow = TP·Volume, counted as positive when TP rises and negative when it falls. MFI = 100 − 100 / (1 + Σ positive flow₁₄ / Σ negative flow₁₄).'],
  cmf: ['Buying or selling pressure from where each bar closes inside its range, weighted by volume.',
    'Multiplier = ((C − L) − (H − C)) / (H − L), CMF = Σ(Multiplier·Volume)₂₀ / ΣVolume₂₀. Ranges from −1 to +1.'],
  vwap: ['The average price paid today, weighted by volume. Many institutions benchmark against it.',
    'VWAP = Σ(TP·Volume) / ΣVolume since 00:00 UTC, TP = (H + L + C)/3.'],
  dlt: ['Net aggressive buying on the bar: whether buyers or sellers crossed the spread more.',
    'Delta = Taker buy volume − Taker sell volume = 2·Taker buy volume − Volume.'],
  cvd: ['Cumulative volume delta shows whether aggressive buyers or sellers have dominated over time.',
    'CVDₜ = running sum of Delta. The signal uses CVDₜ − CVDₜ₋₂₀.'],
  big: ['Spots unusually large trades in the latest trade tape, a sign of large players.',
    'Big trade = notional ≥ 10 × the median trade notional of the latest trades. Buys are taker buys, sells are taker sells.'],
  ovp: ['Where options traders are active. Strikes with heavy volume or open interest often act as magnets or walls for price.',
    'For every strike, sum 24h volume and open interest of calls and puts across all expiries. P/C = Σ put volume / Σ call volume. POC = strike with the most volume. Call wall / put wall = strike with the most call / put open interest.'],
  fvg: ['A three-candle imbalance where price moved so fast it left a gap. Price often comes back to it.',
    'Bullish gap when Lₜ > Hₜ₋₂ (zone Hₜ₋₂ to Lₜ). Bearish gap when Hₜ < Lₜ₋₂. A gap is filled once price trades all the way through it.'],
  sr: ['Levels where the market turned before. Swing lows act as support, swing highs as resistance.',
    'Swing high = a high above the 3 bars on each side (swing low is the mirror), within the last 200 bars. Distance to the nearest level is measured in ATR(14).'],
  piv: ['A floor-trader reference level taken from the prior period range.',
    'P = (H + L + C) / 3 of the prior UTC day, or of the prior bar on D1 and W1.'],
  twap: ['The average price of the day with every bar weighted equally, a volume-free benchmark that execution desks use.',
    'TWAP = Σ((O + H + L + C)/4) / number of bars since 00:00 UTC.'],
  cdl: ['Classic reversal shapes on the last closed bar.',
    'Engulfing: the body fully covers the previous opposite body. Pin bar: one wick ≥ 2× the body and ≥ 60% of the range. Doji: body ≤ 10% of the range.'],
  w52: ['Where price sits inside its one-year range.',
    '52-week high and low from daily bars. Shows the % distance to the nearer extreme.'],
  chg: ['Simple price performance.',
    'Change = (Price / Close 24 hours ago − 1) × 100, or one week ago on W1.'],
  cot: ['Commitments of Traders: how the big players in the US futures market are positioned, published weekly by the CFTC.',
    'Net = Long − Short for non-commercial (Specs) and commercial (Comm) traders. COT index = 100·(Netₜ − min) / (max − min) over the last 156 weekly reports. For USD-based pairs such as USDJPY the index is inverted (100 − index) because the futures contract is quoted the other way round.'],
  seas: ['Seasonality: some markets tend to rise or fall in the same months every year.',
    'Rₘ,ᵧ = Close(month m, year y) / Close(month m − 1, year y) − 1. Seasonal = mean of Rₘ over the last up to 15 years. Win rate = share of years with Rₘ > 0. Needs at least 5 years.'],
};
for (const d of INDICATORS) [d.what, d.formula] = NOTES[d.id];
// Values that do not depend on the chart timeframe (shown once in the detail view).
for (const id of ['big', 'ovp', 'w52', 'cot', 'seas']) INDICATORS.find(d => d.id === id).tfFree = true;

export const INTRADAY = new Set(['M5', 'M15', 'H1', 'H4']);

const sign = v => v > 0 ? 1 : v < 0 ? -1 : 0;
const fmt = (v, d = 2) => isNum(v) ? v.toFixed(d) : '—';
export function compact(v) {
  const a = Math.abs(v);
  const s = a >= 1e9 ? (a / 1e9).toFixed(1) + 'B' : a >= 1e6 ? (a / 1e6).toFixed(1) + 'M' : a >= 1e3 ? (a / 1e3).toFixed(1) + 'K' : a.toFixed(a >= 10 ? 0 : 2);
  return (v < 0 ? '−' : v > 0 ? '+' : '') + s;
}

// Change of `price` against the close `span` seconds before the latest bar.
function changeOver(c, price, span) {
  const target = c[c.length - 1].time - span;
  for (let i = c.length - 1; i >= 0; i--) if (c[i].time <= target) return (price / c[i].close - 1) * 100;
  return NaN;
}

/**
 * series: { candles, closeOnly, hasVolume, hasTakerBuy }
 * ctx: { tf, tfSec, useClosedBar, trades, daily, price }
 * Returns { ind: {id: {vote, text, na}}, groups: {id: {vote, na}}, total: {label, cls, na}, strength, squeeze }
 */
export function evaluate(series, ctx) {
  if (series.na) return unavailableAll(series.na);
  const all = series.candles || [];
  const now = Date.now() / 1000;
  let end = all.length - 1;
  if (ctx.useClosedBar && end >= 0 && all[end].time + ctx.tfSec > now) end--;
  const c = end >= 0 ? all.slice(0, end + 1) : [];
  const e = c.length - 1;
  const price = isNum(ctx.price) ? ctx.price : all.length ? all[all.length - 1].close : NaN;
  const cl = ta.closes(c);
  const memo = {};
  const get = (k, fn) => memo[k] ?? (memo[k] = fn());
  const atr = () => get('atr', () => ta.ATR(c, 14));
  const ind = {};

  for (const def of INDICATORS) {
    const na = unavailable(def, series, ctx, c.length);
    if (na) { ind[def.id] = { na }; continue; }
    try {
      ind[def.id] = compute(def.id) || { na: 'No data' };
    } catch (err) {
      ind[def.id] = { na: 'Error' };
    }
  }

  function compute(id) {
    const x = cl[e];
    switch (id) {
      case 'ema': {
        const a = ta.EMA(cl, 20)[e], b = ta.EMA(cl, 50)[e], d = ta.EMA(cl, 200)[e];
        if (![a, b, d].every(isNum)) return null;
        const up = x > a && x > b && x > d && a > b && b > d, dn = x < a && x < b && x < d && a < b && b < d;
        return { vote: up ? 1 : dn ? -1 : 0 };
      }
      case 'st': { const d = ta.superTrend(c).dir[e]; return isNum(d) ? { vote: d } : null; }
      case 'ich': {
        const k = ta.ichimoku(c), a = k.cloudA[e], b = k.cloudB[e];
        if (!isNum(a) || !isNum(b)) return null;
        return { vote: x > Math.max(a, b) ? 1 : x < Math.min(a, b) ? -1 : 0 };
      }
      case 'hma': { const h = ta.HMA(cl, 21); return isNum(h[e]) && isNum(h[e - 1]) ? { vote: sign(h[e] - h[e - 1]) } : null; }
      case 'adx': {
        const d = get('dmi', () => ta.DMI(c)), v = d.adx[e];
        if (!isNum(v)) return null;
        const state = v > 25 ? 'Strong' : v >= 20 ? 'Weak' : 'Flat';
        return { vote: sign(d.pdi[e] - d.mdi[e]), text: `${tr('st', state)} ${v.toFixed(0)}`, state, stateOnly: true };
      }
      case 'chop': {
        const v = ta.choppiness(c)[e];
        if (!isNum(v)) return null;
        const state = v > 61.8 ? 'Ranging' : v < 38.2 ? 'Trending' : 'Mixed';
        return { text: tr('st', state), state, stateOnly: true };
      }
      case 'rsi': {
        const v = ta.RSI(cl, 14)[e];
        if (!isNum(v)) return null;
        return { vote: sign(v - 50), text: v.toFixed(0) + (v > 70 ? ` ${t('st.OB')}` : v < 30 ? ` ${t('st.OS')}` : '') };
      }
      case 'macd': { const m = ta.MACD(cl); return isNum(m.hist[e]) ? { vote: sign(m.hist[e]) } : null; }
      case 'cci': { const v = ta.CCI(c, 20)[e]; return isNum(v) ? { vote: sign(v), text: v.toFixed(0) } : null; }
      case 'atr': { const v = atr()[e]; return isNum(v) ? { text: (v / x * 100).toFixed(2) + '%', stateOnly: true } : null; }
      case 'sq': {
        const bb = ta.bollinger(cl, 20, 2), kc = ta.keltner(c, 20, 1.5);
        if (!isNum(bb.upper[e]) || !isNum(kc.upper[e])) return null;
        const w = i => bb.upper[i] - bb.lower[i];
        const squeeze = bb.upper[e] < kc.upper[e] && bb.lower[e] > kc.lower[e];
        const expanding = isNum(w(e - 5)) && w(e) > w(e - 5) * 1.2;
        const state = squeeze ? 'Squeeze' : expanding ? 'Expanding' : 'Normal';
        return { text: tr('st', state), state, stateOnly: true };
      }
      case 'don': {
        const d = ta.donchian(c, 20), r = d.upper[e] - d.lower[e];
        if (!isNum(r)) return null;
        const p = r ? (x - d.lower[e]) / r : 0.5;
        return { vote: p >= 0.9 ? 1 : p <= 0.1 ? -1 : 0 };
      }
      case 'spk': {
        const avg = ta.SMA(ta.volumes(c), 20)[e - 1];
        if (!isNum(avg) || !avg) return null;
        const r = c[e].volume / avg;
        return { text: r >= 2 ? `${t('st.Spike')} ×${r.toFixed(1)}` : `×${r.toFixed(1)}`, state: r >= 2 ? 'Spike' : 'Normal', stateOnly: true };
      }
      case 'rvol': {
        const r = ta.RVOL(c, e, INTRADAY.has(ctx.tf));
        if (!isNum(r.value)) return { na: 'Low history' };
        const state = r.value >= 2 ? 'High' : r.value <= 0.5 ? 'Quiet' : 'Normal';
        return { text: `${tr('st', state)} ${r.value.toFixed(1)}×`, state, stateOnly: true };
      }
      case 'obv': { const o = ta.OBV(c), m = ta.EMA(o, 20)[e]; return isNum(m) ? { vote: sign(o[e] - m) } : null; }
      case 'mfi': { const v = ta.MFI(c, 14)[e]; return isNum(v) ? { vote: sign(v - 50), text: v.toFixed(0) } : null; }
      case 'cmf': { const v = ta.CMF(c, 20)[e]; return isNum(v) ? { vote: sign(v), text: v.toFixed(2) } : null; }
      case 'vwap': { const v = ta.VWAP(c)[e]; return isNum(v) ? { vote: sign(x - v) } : null; }
      case 'dlt': { const v = ta.delta(c)[e]; return isNum(v) ? { vote: sign(v), text: compact(v) } : null; }
      case 'cvd': { const v = ta.CVD(c); return isNum(v[e]) && isNum(v[e - 20]) ? { vote: sign(v[e] - v[e - 20]), text: compact(v[e] - v[e - 20]) } : null; }
      case 'big': {
        const t = ctx.trades;
        if (!t) return null;
        return { vote: sign(t.buys - t.sells), text: t.buys + t.sells ? `${t.buys}${tr('st', 'buys')} / ${t.sells}${tr('st', 'sells')}` : tr('st', 'None') };
      }
      case 'ovp': {
        const p = ta.optionsProfile(ctx.options.list);
        if (!isNum(p.putCallRatio)) return null;
        return { text: `P/C ${p.putCallRatio.toFixed(2)} · POC ${p.poc.toLocaleString('en-US')}`, profile: p, stateOnly: true };
      }
      case 'fvg': {
        const gaps = ta.fairValueGaps(c);
        let best = null;
        for (const g of gaps) {
          const dist = g.type === 1 ? (x - g.top) / x : (g.bottom - x) / x;
          if (dist < 0) continue;
          if (!best || dist < best.dist) best = { ...g, dist };
        }
        if (!best) return { vote: 0, text: tr('st', 'None') };
        return { vote: best.type, text: `${tr('st', best.type === 1 ? 'Bull' : 'Bear')} ${(best.dist * 100).toFixed(2)}%` };
      }
      case 'sr': {
        const a = atr()[e];
        if (!isNum(a) || !a) return null;
        const lv = ta.swingLevels(c);
        const sup = Math.max(...lv.lows.filter(v => v < x)), res = Math.min(...lv.highs.filter(v => v > x));
        const ds = isNum(sup) ? (x - sup) / a : Infinity, dr = isNum(res) ? (res - x) / a : Infinity;
        if (ds <= 0.5 && ds <= dr) return { vote: 1, text: `${tr('st', 'sup')} ${ds.toFixed(1)} ATR` };
        if (dr <= 0.5) return { vote: -1, text: `${tr('st', 'res')} ${dr.toFixed(1)} ATR` };
        return { vote: 0, text: tr('st', 'Mid-range') };
      }
      case 'piv': {
        let H, L, C;
        if (INTRADAY.has(ctx.tf)) {
          const today = Math.floor(c[e].time / 86400);
          const prev = c.filter(k => Math.floor(k.time / 86400) === today - 1);
          if (prev.length < 2) return null;
          H = Math.max(...prev.map(k => k.high)); L = Math.min(...prev.map(k => k.low)); C = prev[prev.length - 1].close;
        } else {
          const p = c[e - 1]; if (!p) return null;
          H = p.high; L = p.low; C = p.close;
        }
        const P = (H + L + C) / 3;
        return { vote: sign(x - P), text: tr('st', x > P ? 'Above P' : 'Below P') };
      }
      case 'twap': { const v = ta.TWAP(c)[e]; return isNum(v) ? { vote: sign(x - v) } : null; }
      case 'cdl': {
        const p = ta.candlePattern(c, e);
        return p ? { vote: p.dir, text: tr('cdl', p.name) } : { vote: 0, text: tr('st', 'None') };
      }
      case 'w52': {
        const d = ctx.daily;
        const last = d[d.length - 1].time, yr = d.filter(k => k.time > last - 365 * 86400);
        const hi = Math.max(...yr.map(k => k.high)), lo = Math.min(...yr.map(k => k.low));
        const fromHi = (price / hi - 1) * 100, fromLo = (price / lo - 1) * 100;
        return { text: Math.abs(fromHi) <= Math.abs(fromLo) ? `${fromHi.toFixed(1)}% ${t('st.vsHigh')}` : `+${fromLo.toFixed(1)}% ${t('st.vsLow')}`, stateOnly: true };
      }
      case 'chg': {
        const v = changeOver(all, price, ctx.tf === 'W1' ? 7 * 86400 : 86400);
        return isNum(v) ? { text: (v >= 0 ? '+' : '') + v.toFixed(2) + '%', value: v, stateOnly: true } : null;
      }
      case 'cot': {
        const k = ta.cotIndex(ctx.cot.rows, 156, ctx.cot.invert);
        if (k.weeks < 52) return { na: 'Low history' };
        return { text: `${t('st.Specs')} ${k.spec.toFixed(0)} · ${t('st.Comm')} ${k.comm.toFixed(0)}`, short: k.spec.toFixed(0), cot: k, stateOnly: true, extreme: k.spec >= 80 ? 1 : k.spec <= 20 ? -1 : 0 };
      }
      case 'seas': {
        const s = ta.seasonal(ctx.monthly);
        if (s.n < 5) return { na: 'Low history' };
        const pct = (s.avg * 100).toFixed(1), win = Math.round((s.avg >= 0 ? s.win : 1 - s.win) * 100);
        return { text: `${monthName(s.m)} ${s.avg >= 0 ? '+' : ''}${pct}% · ${win}% ${t(s.avg >= 0 ? 'st.up' : 'st.down')} (${s.n}${t('st.years')})`, short: `${s.avg >= 0 ? '+' : ''}${pct}%`, seasonal: s, stateOnly: true, tendency: win >= 70 ? Math.sign(s.avg) : 0 };
      }
    }
    return null;
  }

  const groups = {};
  for (const g of GROUPS) {
    const defs = INDICATORS.filter(d => d.group === g.id);
    if (!g.votes) {
      // Non-voting groups show one headline: ADX strength, the squeeze state, or COT / seasonal.
      if (g.id === 'mc') {
        const r = !ind.cot.na ? ind.cot : ind.seas;
        const isCot = r === ind.cot;
        const title = isCot
          ? t('mc.cot', { text: r.text }) + (r.extreme > 0 ? t('mc.cotHigh') : r.extreme < 0 ? t('mc.cotLow') : '')
          : t('mc.seas', { text: r.text });
        groups.mc = r.na ? { na: r.na } : { text: isCot ? `COT ${r.short}` : r.short, tone: isCot ? r.extreme : r.tendency, title };
        continue;
      }
      const r = ind[g.id === 'sg' ? 'adx' : 'sq'];
      groups[g.id] = r.na ? { na: r.na } : { text: r.state, vote: g.id === 'sg' ? r.vote : undefined };
      continue;
    }
    const votes = defs.filter(d => !d.state).map(d => ind[d.id]).filter(r => !r.na && isNum(r.vote)).map(r => r.vote);
    if (!votes.length) { groups[g.id] = { na: firstReason(defs.map(d => ind[d.id])) }; continue; }
    const m = votes.reduce((a, b) => a + b, 0) / votes.length;
    groups[g.id] = { vote: m > 0.2 ? 1 : m < -0.2 ? -1 : 0, count: votes.length, score: m };
  }

  const strength = ind.adx.na ? null : ind.adx.state;
  const dirs = GROUPS.filter(g => g.votes && !groups[g.id].na).map(g => groups[g.id].vote);
  let total;
  if (!dirs.length) total = { na: groups.tr.na || 'No data' };
  else {
    const s = dirs.reduce((a, b) => a + b, 0) / dirs.length;
    if (strength === 'Flat') total = { code: 'Wait', cls: 'N' };
    else if (s > 0.5) total = { code: strength === 'Strong' ? 'Strong buy' : 'Buy', cls: 'B' };
    else if (s > 0.1) total = { code: 'Buy', cls: 'B' };
    else if (s < -0.5) total = { code: strength === 'Strong' ? 'Strong sell' : 'Sell', cls: 'S' };
    else if (s < -0.1) total = { code: 'Sell', cls: 'S' };
    else total = { code: 'Neutral', cls: 'N' };
    total.label = tr('tot', total.code);
    total.score = s;
  }
  return { ind, groups, total, strength, squeeze: ind.sq.na ? null : ind.sq.state, change: ind.chg.na ? NaN : ind.chg.value };
}

function unavailableAll(na) {
  const ind = {}, groups = {};
  for (const d of INDICATORS) ind[d.id] = { na };
  for (const g of GROUPS) groups[g.id] = { na };
  return { ind, groups, total: { na }, strength: null, squeeze: null, change: NaN };
}

function firstReason(rs) {
  const order = ['Needs key', 'D1/W1 only', 'Needs OHLC', 'No volume', 'Binance only', 'Few trades', 'Not supported', 'BTC/ETH only', 'No COT report', 'Intraday only', 'Low history', 'No data', 'Error'];
  const got = rs.map(r => r.na).filter(Boolean);
  return order.find(o => got.includes(o)) || got[0] || 'No data';
}

function unavailable(def, s, ctx, bars) {
  if ((def.needs === 'volume' || def.needs === 'flow') && !s.hasVolume) return 'No volume';
  if (def.needs === 'flow' && !s.hasTakerBuy) return 'Binance only';
  if (s.closeOnly && def.needs === 'ohlc') return 'Needs OHLC';
  if (def.needs === 'trades' && !ctx.trades) return ctx.tradesSupported ? 'No data' : 'Not supported';
  if (def.needs === 'trades' && ctx.trades.n < 50) return 'Few trades';
  if (def.needs === 'options') return ctx.options ? null : ctx.optionsSupported ? 'No data' : 'BTC/ETH only';
  if (def.needs === 'cot') return ctx.cot ? null : ctx.cotNa || 'No COT report';
  if (def.needs === 'monthly') return ctx.monthly ? null : ctx.monthlyNa || 'Low history';
  if (def.needs === 'daily') {
    const d = ctx.daily;
    if (!d || d.length < 2) return 'Low history';
    if (d[d.length - 1].time - d[0].time < 360 * 86400) return 'Low history';
    return null;
  }
  if (def.intraday && !INTRADAY.has(ctx.tf)) return 'Intraday only';
  if (bars < def.bars || bars < 2) return 'Low history';
  return null;
}
