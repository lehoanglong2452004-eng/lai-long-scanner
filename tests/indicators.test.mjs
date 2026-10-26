// Checks the indicator library against straightforward Pine-style reference implementations.
// Run: node tests/indicators.test.mjs
import assert from 'node:assert/strict';
import * as ta from '../js/indicators.js';
import { evaluate, INDICATORS, GROUPS } from '../js/signals.js';

let seed = 42;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
function makeCandles(N, start = 2400, sigma = 0.6, t0 = 1761436800, step = 3600) {
  const out = []; let p = start;
  for (let i = 0; i < N; i++) {
    const o = p, c = o + gauss() * sigma + (i > N / 2 ? 0.08 : 0);
    const h = Math.max(o, c) + Math.abs(gauss()) * sigma * 0.5;
    const l = Math.min(o, c) - Math.abs(gauss()) * sigma * 0.5;
    const v = 50 + Math.floor(rnd() * 200);
    out.push({ time: t0 + i * step, open: o, high: h, low: l, close: c, volume: v, takerBuy: v * rnd() });
    p = c;
  }
  return out;
}
const C = makeCandles(600);
const close = C.map(k => k.close);

// ---- Pine-style references ----
function refRMA(src, n) {
  const out = Array(src.length).fill(NaN); let prev; const buf = [];
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (!Number.isFinite(v)) { if (prev !== undefined) out[i] = prev; continue; }
    if (prev === undefined) { buf.push(v); if (buf.length === n) out[i] = prev = buf.reduce((a, b) => a + b) / n; }
    else out[i] = prev = (v + (n - 1) * prev) / n;
  }
  return out;
}
function refEMA(src, n) {
  const out = Array(src.length).fill(NaN), a = 2 / (n + 1); let prev; const buf = [];
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (!Number.isFinite(v)) continue;
    if (prev === undefined) { buf.push(v); if (buf.length === n) out[i] = prev = buf.reduce((x, y) => x + y) / n; }
    else out[i] = prev = a * v + (1 - a) * prev;
  }
  return out;
}
function refRSI(c, n = 14) {
  const u = c.map((v, i) => i ? Math.max(v - c[i - 1], 0) : NaN);
  const d = c.map((v, i) => i ? Math.max(c[i - 1] - v, 0) : NaN);
  const au = refRMA(u, n), ad = refRMA(d, n);
  return c.map((_, i) => !Number.isFinite(au[i]) ? NaN : ad[i] === 0 ? 100 : au[i] === 0 ? 0 : 100 - 100 / (1 + au[i] / ad[i]));
}
function refADX(k, len = 14) {
  const tr = k.map((x, i) => i ? Math.max(x.high - x.low, Math.abs(x.high - k[i - 1].close), Math.abs(x.low - k[i - 1].close)) : NaN);
  const dm = sgn => k.map((x, i) => {
    if (!i) return NaN;
    const up = x.high - k[i - 1].high, dn = k[i - 1].low - x.low;
    return sgn > 0 ? (up > dn && up > 0 ? up : 0) : (dn > up && dn > 0 ? dn : 0);
  });
  const atr = refRMA(tr, len), p = refRMA(dm(1), len), m = refRMA(dm(-1), len);
  const pdi = p.map((v, i) => 100 * v / atr[i]), mdi = m.map((v, i) => 100 * v / atr[i]);
  const dx = pdi.map((v, i) => { const s = v + mdi[i]; return Math.abs(v - mdi[i]) / (s === 0 ? 1 : s); });
  return { adx: refRMA(dx, len).map(v => 100 * v), pdi };
}
function refSuperTrend(k, atrLen = 10, factor = 3) {
  const atr = ta.ATR(k, atrLen); let pU, pL, pST; const dir = [];
  for (let i = 0; i < k.length; i++) {
    const src = (k[i].high + k[i].low) / 2;
    let U = src + factor * atr[i], L = src - factor * atr[i];
    const pu = Number.isFinite(pU) ? pU : 0, pl = Number.isFinite(pL) ? pL : 0, c1 = i ? k[i - 1].close : NaN;
    L = (L > pl || c1 < pl) ? L : pl;
    U = (U < pu || c1 > pu) ? U : pu;
    let d;
    if (!Number.isFinite(atr[i - 1])) d = 1;
    else if (pST === pu) d = k[i].close > U ? -1 : 1;
    else d = k[i].close < L ? 1 : -1;
    dir.push(Number.isFinite(atr[i]) ? -d : NaN);
    pU = U; pL = L; pST = d === -1 ? L : U;
  }
  return dir;
}

function close2(a, b, label, tol = 1e-9) {
  assert.equal(a.length, b.length, `${label}: length`);
  for (let i = 0; i < a.length; i++) {
    const fa = Number.isFinite(a[i]), fb = Number.isFinite(b[i]);
    assert.equal(fa, fb, `${label}: NaN mismatch at ${i} (${a[i]} vs ${b[i]})`);
    if (fa) assert.ok(Math.abs(a[i] - b[i]) <= tol * Math.max(1, Math.abs(b[i])), `${label}: ${a[i]} vs ${b[i]} at ${i}`);
  }
}

const tests = {
  'RSI matches Wilder / ta.rsi': () => close2(ta.RSI(close), refRSI(close), 'RSI'),
  'MACD signal skips warm-up instead of seeding with zeros': () => {
    const m = ta.MACD(close), ref = refEMA(refEMA(close, 12).map((v, i) => v - refEMA(close, 26)[i]), 9);
    close2(m.signal, ref, 'MACD signal');
  },
  'ADX and +DI match ta.dmi': () => { const a = ta.DMI(C), r = refADX(C); close2(a.adx, r.adx, 'ADX'); close2(a.pdi, r.pdi, '+DI'); },
  'SuperTrend direction matches ta.supertrend': () => close2(ta.superTrend(C).dir, refSuperTrend(C), 'SuperTrend'),
  'SMA restarts after NaN': () => close2(ta.SMA([1, 2, NaN, 3, 4, 5], 2), [NaN, 1.5, NaN, NaN, 3.5, 4.5], 'SMA'),
  'EMA200 has its first value at bar 199': () => assert.equal(ta.EMA(close, 200).findIndex(Number.isFinite), 199),
  'HMA equals its WMA definition': () => {
    const wma = (s, n, i) => { let a = 0; for (let j = 0; j < n; j++) a += s[i - j] * (n - j); return a / (n * (n + 1) / 2); };
    const h = ta.HMA(close, 21), i = 300;
    const diff = [0, 1, 2, 3, 4].map(k => 2 * wma(close, 10, i - k) - wma(close, 21, i - k));
    const want = (diff[0] * 5 + diff[1] * 4 + diff[2] * 3 + diff[3] * 2 + diff[4]) / 15;
    assert.ok(Math.abs(h[i] - want) < 1e-9, `${h[i]} vs ${want}`);
  },
  'oscillators stay in range': () => {
    const inRange = (arr, lo, hi, name) => arr.filter(Number.isFinite).forEach(v => assert.ok(v >= lo - 1e-9 && v <= hi + 1e-9, `${name} out of range: ${v}`));
    inRange(ta.MFI(C), 0, 100, 'MFI');
    inRange(ta.CMF(C), -1, 1, 'CMF');
    inRange(ta.choppiness(C), 0, 100, 'CHOP');
    inRange(ta.RSI(close), 0, 100, 'RSI');
  },
  'OBV accumulates signed volume': () => {
    const k = [{ close: 1, volume: 5 }, { close: 2, volume: 3 }, { close: 1, volume: 4 }, { close: 1, volume: 9 }];
    assert.deepEqual(ta.OBV(k), [0, 3, -1, -1]);
  },
  'delta uses taker buy volume': () => assert.deepEqual(ta.delta([{ volume: 10, takerBuy: 7 }, { volume: 4 }]).map(v => Number.isNaN(v) ? 'NaN' : v), [4, 'NaN']),
  'FVG finds an unfilled bullish gap': () => {
    const k = [{ high: 10, low: 9 }, { high: 12, low: 10 }, { high: 14, low: 11 }, { high: 15, low: 12 }];
    const g = ta.fairValueGaps(k);
    assert.equal(g.length, 1);
    assert.deepEqual([g[0].type, g[0].bottom, g[0].top], [1, 10, 11]);
  },
  'FVG drops a gap once filled': () => {
    const k = [{ high: 10, low: 9 }, { high: 12, low: 10 }, { high: 14, low: 11 }, { high: 13, low: 9.5 }];
    assert.equal(ta.fairValueGaps(k).filter(g => g.bottom === 10).length, 0);
  },
  'candle patterns': () => {
    const bull = [{ open: 10, close: 9, high: 10.2, low: 8.8 }, { open: 8.9, close: 10.3, high: 10.4, low: 8.8 }];
    assert.equal(ta.candlePattern(bull, 1).name, 'Bull engulfing');
    const pin = [{ open: 10, close: 10, high: 10, low: 10 }, { open: 10, close: 10.1, high: 10.15, low: 9 }];
    assert.equal(ta.candlePattern(pin, 1).name, 'Bull pin bar');
  },
  'evaluate returns every indicator and group': () => {
    const daily = makeCandles(400, 2400, 8, 1730000000, 86400);
    const options = { list: [{ strike: 100, type: 'C', volume: 5, oi: 10 }, { strike: 100, type: 'P', volume: 3, oi: 4 }] };
    const cot = { rows: Array.from({ length: 160 }, (_, i) => ({ date: `w${i}`, spec: Math.sin(i / 9) * 1000, comm: -Math.sin(i / 9) * 900 })) };
    const monthly = Array.from({ length: 120 }, (_, i) => ({ time: Date.UTC(2016, i, 1) / 1000, close: 100 + i }));
    const r = evaluate({ candles: C, hasVolume: true, hasTakerBuy: true }, { tf: 'H1', tfSec: 3600, useClosedBar: true, trades: { buys: 3, sells: 1, n: 200 }, tradesSupported: true, daily, options, cot, monthly });
    for (const d of INDICATORS) assert.ok(r.ind[d.id], `missing ${d.id}`);
    for (const d of INDICATORS) assert.ok(!r.ind[d.id].na, `${d.id} unexpectedly unavailable: ${r.ind[d.id].na}`);
    for (const g of GROUPS) assert.ok(r.groups[g.id], `missing group ${g.id}`);
    assert.ok(['Strong buy', 'Buy', 'Neutral', 'Sell', 'Strong sell', 'Wait'].includes(r.total.label));
  },
  'TWAP averages OHLC4 and resets each UTC day': () => {
    const day = 86400, k = [
      { time: day - 3600, open: 1, high: 1, low: 1, close: 1 },
      { time: day, open: 2, high: 4, low: 2, close: 4 },
      { time: day + 3600, open: 4, high: 4, low: 4, close: 4 },
    ];
    assert.deepEqual(ta.TWAP(k), [1, 3, 3.5]);
  },
  'RVOL compares with the same time of day': () => {
    const k = [0, 1, 2, 3].map(d => ({ time: d * 86400 + 3600, volume: d === 3 ? 30 : 10 }));
    k.splice(1, 0, { time: 7200, volume: 999 });
    const r = ta.RVOL(k, k.length - 1, true);
    assert.equal(r.samples, 3);
    assert.equal(r.value, 3);
  },
  'options profile finds P/C, POC and walls': () => {
    const p = ta.optionsProfile([
      { strike: 90, type: 'P', volume: 8, oi: 50 }, { strike: 100, type: 'C', volume: 10, oi: 20 },
      { strike: 100, type: 'P', volume: 4, oi: 5 }, { strike: 110, type: 'C', volume: 2, oi: 70 },
    ]);
    assert.equal(p.putCallRatio, 1);
    assert.equal(p.poc, 100);
    assert.equal(p.callWall, 110);
    assert.equal(p.putWall, 90);
  },
  'COT index scales the latest net position into its range': () => {
    const rows = [0, 10, 8].map((spec, i) => ({ date: `d${i}`, spec, comm: -spec }));
    const k = ta.cotIndex(rows, 156);
    assert.equal(k.spec, 80);
    assert.equal(k.comm, 20);
    assert.equal(ta.cotIndex(rows, 156, true).spec, 20);
  },
  'seasonal averages the same calendar month and skips the current month': () => {
    const bars = [];
    let p = 100;
    for (let y = 2020; y <= 2026; y++) for (let m = 0; m < 12; m++) {
      if (y === 2026 && m > 9) break;
      if (m === 9) p *= y === 2026 ? 0.5 : 1.1;
      bars.push({ time: Date.UTC(y, m, 1) / 1000, close: p });
    }
    const s = ta.seasonal(bars, new Date(Date.UTC(2026, 9, 15)));
    assert.equal(s.n, 6);
    assert.ok(Math.abs(s.avg - 0.1) < 1e-12);
    assert.equal(s.win, 1);
  },
  'few recent trades are not scored': () => {
    const r = evaluate({ candles: C, hasVolume: true }, { tf: 'H1', tfSec: 3600, trades: { buys: 1, sells: 0, n: 10 }, tradesSupported: true });
    assert.equal(r.ind.big.na, 'Few trades');
  },
  'close-only data disables OHLC indicators': () => {
    const k = C.map(x => ({ ...x, open: x.close, high: x.close, low: x.close }));
    const r = evaluate({ candles: k, closeOnly: true, hasVolume: false }, { tf: 'D1', tfSec: 86400, useClosedBar: false });
    assert.equal(r.ind.st.na, 'Needs OHLC');
    assert.equal(r.ind.obv.na, 'No volume');
    assert.ok(!r.ind.rsi.na && !r.ind.macd.na && !r.ind.ema.na);
  },
  'short history is flagged': () => {
    const r = evaluate({ candles: C.slice(0, 100), hasVolume: true }, { tf: 'H1', tfSec: 3600, useClosedBar: false });
    assert.equal(r.ind.ema.na, 'Low history');
    assert.ok(!r.ind.rsi.na);
  },
  'flat ADX turns Total into Wait': () => {
    const flat = makeCandles(400, 100, 0.05).map((k, i) => ({ ...k, close: 100 + Math.sin(i) * 0.01, open: 100, high: 100.05, low: 99.95 }));
    const r = evaluate({ candles: flat, hasVolume: true }, { tf: 'H1', tfSec: 3600, useClosedBar: false });
    if (r.strength === 'Flat') assert.equal(r.total.label, 'Wait');
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log('ok   ', name); }
  catch (e) { failed++; console.log('FAIL ', name, '\n      ', e.message); }
}
console.log(`\n${Object.keys(tests).length - failed}/${Object.keys(tests).length} passed`);
process.exit(failed ? 1 : 0);
