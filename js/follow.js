// Lai Long Follow Trend in the scanner: an independent indicator shown before the groups.
// It never votes in Total. The engine is js/llft.js, a copy of the shared core; keep it identical.
import { compute, regimeLabel } from './llft.js';

// The higher timeframe the core reads for each scanner timeframe (W1 builds months from its own weeks).
export const LLFT_HTF = { M5: 'H1', M15: 'H4', H1: 'H4', H4: 'D1', D1: 'W1' };
export const LLFT_MIN_BARS = 120;
// A signal counts as fresh for this many bars; older ones stay in the detail panel only.
export const LLFT_FRESH = 5;

// Real higher-timeframe candles cost one request per symbol, so rate-limited and end-of-day sources
// let the core build them from the chart's own bars.
export const loadsHtf = d => d.source !== 'twelvedata' && d.source !== 'ecb';

export const toBar = k => ({ t: k.time * 1000, o: k.open, h: k.high, l: k.low, c: k.close, v: k.volume || 0, tb: k.takerBuy });

/**
 * series, htf: { candles, closeOnly, hasVolume, na? } as loaded by the scanner; htf may be null.
 * Returns the core result, or { na } with one of the scanner's reason codes.
 */
export function followTrend(series, tfSec, { htf = null, useClosedBar = true, now = Date.now() } = {}) {
  if (series.na) return { na: series.na };
  if (series.closeOnly) return { na: 'Needs OHLC' };
  if (!series.hasVolume) return { na: 'No volume' };
  const all = series.candles || [];
  let end = all.length - 1;
  if (useClosedBar && end >= 0 && (all[end].time + tfSec) * 1000 > now) end--;
  if (end + 1 < LLFT_MIN_BARS) return { na: 'Low history' };
  const bars = all.slice(0, end + 1).map(toBar);
  const last = bars[bars.length - 1].t;
  const htfBars = htf?.candles && !htf.closeOnly ? htf.candles.map(toBar).filter(b => b.t <= last) : undefined;
  return compute(bars, { tfMs: tfSec * 1000, htfBars: htfBars?.length >= 30 ? htfBars : undefined });
}

/**
 * What the scanner cell shows, most specific first: a fresh signal, a breakout being tracked,
 * the chart trend with or against the higher timeframe, or the state when there is no trend.
 * code: signal | wait | b1 | base | with | against | trend | transition | balance
 */
export function followState(r) {
  const L = r?.last;
  if (!L) return null;
  const sg = L.signal;
  if (sg && sg.barsAgo <= LLFT_FRESH) return { code: 'signal', dir: sg.dir, cls: sg.dir > 0 ? 'B' : 'S', signal: sg };
  if (L.breakout) return { code: L.breakout.stage, dir: L.breakout.dir, cls: 'A' };
  if (L.trend && L.trend === L.htfTrend) return { code: 'with', dir: L.trend, cls: L.trend > 0 ? 'B' : 'S' };
  if (L.trend && L.htfTrend) return { code: 'against', dir: L.trend, cls: 'N' };
  const code = regimeLabel(L.regime);
  return { code, dir: L.trend, cls: code === 'balance' ? 'W' : 'N' };
}

/** Distance from the close to a zone's near edge, in percent: support below is negative, resistance above positive, 0 inside. */
export function zoneDistance(z, close) {
  if (!z || !(close > 0)) return NaN;
  if (close >= z.bot && close <= z.top) return 0;
  return (((z.dir === 1 ? z.top : z.bot) - close) / close) * 100;
}
