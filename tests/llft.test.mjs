// Checks Lai Long Follow Trend as the scanner uses it: inputs from scanner candles, reason codes,
// higher-timeframe series, no lookahead, the cell state, and that it stays out of Total.
// Run: node tests/llft.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { followTrend, followState, zoneDistance, LLFT_HTF, LLFT_FRESH } from '../js/follow.js';
import { INDICATORS, GROUPS } from '../js/signals.js';

const HOUR = 3600;
// Rising swings with volume bursts, in the scanner's candle format; long enough for a 4H structure.
function swings(n = 600, t0 = 1767225600) {
  const out = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const x = Math.sin(i * 12.9898) * 43758.5453, noise = (x - Math.floor(x)) - 0.5;
    const o = p;
    p = Math.max(1, p + 0.06 + Math.sin(i / 25) * 0.5 + noise * 0.8);
    const v = 1000 * (1 + Math.abs(noise) * 2 + (i % 41 === 0 ? 3 : 0));
    out.push({ time: t0 + i * HOUR, open: o, high: Math.max(o, p) + Math.abs(noise) * 0.6, low: Math.min(o, p) - Math.abs(noise) * 0.6, close: p, volume: v, takerBuy: v * (0.5 + noise * 0.4) });
  }
  return out;
}
// The same candles grouped into 4H bars on UTC boundaries, as an exchange returns them.
function toH4(c) {
  const out = [];
  for (const k of c) {
    const t = Math.floor(k.time / (4 * HOUR)) * 4 * HOUR, cur = out[out.length - 1];
    if (!cur || cur.time !== t) out.push({ ...k, time: t });
    else { cur.high = Math.max(cur.high, k.high); cur.low = Math.min(cur.low, k.low); cur.close = k.close; cur.volume += k.volume; cur.takerBuy += k.takerBuy; }
  }
  return out;
}

const C = swings();
const series = { candles: C, hasVolume: true, hasTakerBuy: true };
const past = { useClosedBar: true, now: (C[C.length - 1].time + 10 * HOUR) * 1000 };

// Recorded Binance data with real absorption zones and signals (the synthetic swings have neither).
const fx = JSON.parse(readFileSync(new URL('./fixtures/ethusdt-15m.json', import.meta.url), 'utf8'));
const fromRows = rows => rows.map(([time, open, high, low, close, volume, takerBuy]) => ({ time, open, high, low, close, volume, takerBuy }));
const eth = followTrend({ candles: fromRows(fx.m15), hasVolume: true }, 900, { useClosedBar: false, htf: { candles: fromRows(fx.h4) } });

function checkInvariants(r) {
  for (const s of r.signals) {
    assert.equal(s.dir, r.htfTrend[s.i]);
    assert.ok(s.rr >= 1.5 - 1e-9);
    assert.notEqual(s.grade, 'C');
    if (s.dir === 1) assert.ok(s.sl < s.entry && s.tp > s.entry);
    else assert.ok(s.sl > s.entry && s.tp < s.entry);
  }
  for (const z of r.zones) assert.ok(z.top > z.bot && z.score >= 0 && z.score <= 100);
  for (const sg of [...r.vwapOrigin, ...r.vwapOriginHtf]) assert.ok(Array.from(sg.vals).every(Number.isFinite));
}

const tests = {
  'reason codes follow the scanner': () => {
    assert.equal(followTrend({ na: 'Needs key' }, HOUR).na, 'Needs key');
    assert.equal(followTrend({ ...series, closeOnly: true }, HOUR).na, 'Needs OHLC');
    assert.equal(followTrend({ ...series, hasVolume: false }, HOUR).na, 'No volume');
    assert.equal(followTrend({ ...series, candles: C.slice(0, 100) }, HOUR, past).na, 'Low history');
  },
  'higher timeframe for every scanner timeframe': () => {
    assert.deepEqual(LLFT_HTF, { M5: 'H1', M15: 'H4', H1: 'H4', H4: 'D1', D1: 'W1' });
  },
  'the forming bar is dropped when votes use the closed bar': () => {
    const inBar = (C[C.length - 1].time + 60) * 1000;
    assert.equal(followTrend(series, HOUR, { useClosedBar: true, now: inBar }).n, C.length - 1);
    assert.equal(followTrend(series, HOUR, { useClosedBar: false, now: inBar }).n, C.length);
    assert.equal(followTrend(series, HOUR, past).n, C.length);
  },
  'invariants hold on synthetic swings': () => {
    const r = followTrend(series, HOUR, past);
    assert.equal(r.delta, 'A');
    assert.ok(r.last);
    checkInvariants(r);
  },
  'invariants hold on recorded ETH 15m: signals follow the 4H trend with RR >= 1.5': () => {
    assert.ok(eth.signals.length > 0 && eth.zones.length > 0, 'the fixture should contain signals and zones');
    assert.ok(eth.htfBars >= 30);
    checkInvariants(eth);
  },
  'real 4H candles give the same result as 4H built from the chart': () => {
    const own = followTrend(series, HOUR, past);
    const real = followTrend(series, HOUR, { ...past, htf: { candles: toH4(C), hasVolume: true } });
    assert.ok(real.htfBars >= 30);
    assert.deepEqual(Array.from(real.htfTrend), Array.from(own.htfTrend));
    assert.deepEqual(real.signals, own.signals);
  },
  'higher-timeframe bars after the last chart bar are ignored': () => {
    const cut = C.slice(0, 500);
    const a = followTrend({ ...series, candles: cut }, HOUR, { ...past, htf: { candles: toH4(cut) } });
    const b = followTrend({ ...series, candles: cut }, HOUR, { ...past, htf: { candles: toH4(C) } });
    assert.deepEqual(Array.from(b.htfTrend), Array.from(a.htfTrend));
  },
  'no lookahead: old bars do not change when new bars arrive': () => {
    const a = followTrend({ ...series, candles: C.slice(0, 450) }, HOUR, past), b = followTrend(series, HOUR, past);
    assert.deepEqual(Array.from(b.trend.slice(0, 450)), Array.from(a.trend));
    assert.deepEqual(b.signals.filter(s => s.i < 450 - 41), a.signals.filter(s => s.i < 450 - 41));
  },
  'cell state picks the most specific fact': () => {
    const L = { trend: 1, htfTrend: 1, regime: 70, breakout: null, signal: null };
    const st = last => followState({ last: { ...L, ...last } });
    assert.equal(st({ signal: { dir: -1, barsAgo: LLFT_FRESH } }).code, 'signal');
    assert.equal(st({ signal: { dir: 1, barsAgo: LLFT_FRESH + 1 } }).code, 'with');
    assert.deepEqual(st({ breakout: { dir: 1, stage: 'b1' } }), { code: 'b1', dir: 1, cls: 'A' });
    assert.equal(st({ htfTrend: -1 }).code, 'against');
    assert.equal(st({ trend: 0, regime: 30 }).code, 'balance');
    assert.equal(st({ trend: 1, htfTrend: 0, regime: 50 }).code, 'transition');
    assert.equal(followState({ last: null }), null);
  },
  'zone distance: below is negative, above positive, inside zero': () => {
    assert.equal(zoneDistance({ dir: 1, top: 99, bot: 98 }, 100), -1);
    assert.equal(zoneDistance({ dir: -1, top: 103, bot: 102 }, 100), 2);
    assert.equal(zoneDistance({ dir: 1, top: 101, bot: 99 }, 100), 0);
  },
  'it never votes in Total': () => {
    assert.ok(!INDICATORS.some(d => /llft|follow/i.test(`${d.id} ${d.group}`)));
    assert.ok(!GROUPS.some(g => /llft|follow/i.test(g.id)));
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log('ok   ', name); }
  catch (e) { failed++; console.log('FAIL ', name, '\n      ', e.message); }
}
console.log(`\n${Object.keys(tests).length - failed}/${Object.keys(tests).length} passed`);
process.exit(failed ? 1 : 0);
