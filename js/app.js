// Lai Long Scanner: data scheduling, rendering of the scanner table, detail panel,
// settings and legend.
import { SYMBOLS, SYMBOL_BY_ID, ASSET_GROUPS } from './symbols.js';
import { ADAPTERS, TF, TIMEFRAMES, sourceKey, sourceLabel, optionsSummary, OPTIONS_CURRENCY, cotHistory, tdUsedToday } from './sources.js';
import { evaluate, INDICATORS, GROUPS } from './signals.js';
import { isMarketOpen, HOURS_LABEL } from './hours.js';
import { loadSettings, saveSettings } from './store.js';
import { PRESETS, FONTS, COLOR_KEYS, applyTheme } from './theme.js';

const VERSION = '0.1.0';
const REPO_URL = 'https://github.com/lehoanglong2452004-eng/lai-long-scanner';

const PRICE_POLL_MS = 10_000;
const SERIES_CHECK_MS = 30_000;
const TRADES_POLL_MS = 60_000;
const OPTIONS_MAX_AGE = 5 * 60_000;
const LIVE_MAX_AGE = 10 * 60_000;
const FRESH_MS = 90_000;

const $ = (sel, el = document) => el.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isNum = Number.isFinite;

const settings = loadSettings();
const save = () => saveSettings(settings);

const state = {
  series: new Map(),   // `${id}|${tf}` -> { candles, closeOnly, hasVolume, hasTakerBuy, key, fetchedAt, error?, na? }
  prices: new Map(),   // id -> { price, at, key }
  trades: new Map(),   // id -> { buys, sells, n, at, key }
  options: new Map(),  // currency -> { list, at }
  monthly: new Map(),  // id -> { candles?, na?, at, key }
  cot: { status: 'idle', data: null, error: null, at: 0 },
  evals: new Map(),
  errors: new Map(),   // adapter -> last price polling error
  open: null,
  detailTf: settings.tf,
  info: null,
  lastUpdate: 0,
};

// ---------- sources ----------
const usable = d => !ADAPTERS[d.source].needsKey || !!settings.tdKey;
function sourceFor(sym) {
  const chosen = sym.sources.find(d => sourceKey(d) === settings.sources[sym.id]);
  if (chosen && usable(chosen)) return chosen;
  return sym.sources.find(usable) || sym.sources[0];
}

function limiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}
const limit = limiter(6);

// ---------- loading ----------
const inflight = new Map();

function isFresh(s, d, tf) {
  if (!s || s.key !== sourceKey(d)) return false;
  const age = Date.now() - s.fetchedAt;
  if (s.error || s.na === 'Error') return age < 60_000;
  if (s.na) return true;
  if (d.source === 'twelvedata') return age < settings.tdRefreshMin * 60_000;
  if (d.source === 'ecb') return age < 3_600_000;
  const last = s.candles[s.candles.length - 1];
  const barClosed = (last.time + TF[tf].sec) * 1000 + 3000 <= Date.now();
  return !barClosed && age < LIVE_MAX_AGE;
}

function loadSeries(sym, tf) {
  const d = sourceFor(sym), k = `${sym.id}|${tf}`, cur = state.series.get(k);
  if (isFresh(cur, d, tf)) return Promise.resolve(cur);
  if (inflight.has(k)) return inflight.get(k);
  const p = limit(async () => {
    try {
      const r = await ADAPTERS[d.source].candles(d, tf, { tdKey: settings.tdKey });
      if (!r.candles.length) throw new Error('No candles returned');
      state.series.set(k, { ...r, key: sourceKey(d), fetchedAt: Date.now() });
    } catch (e) {
      const keep = cur && cur.key === sourceKey(d) && cur.candles && !e.na;
      state.series.set(k, keep
        ? { ...cur, error: e.message, fetchedAt: Date.now() }
        : { na: e.na || 'Error', error: e.message, key: sourceKey(d), fetchedAt: Date.now() });
    }
    state.lastUpdate = Date.now();
    scheduleRender();
    return state.series.get(k);
  }).finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}

function loadAll(tf) {
  const jobs = SYMBOLS.map(sym => loadSeries(sym, tf));
  // End-of-day symbols also need their daily series for the price and the EOD badge.
  for (const sym of SYMBOLS) if (sourceFor(sym).source === 'ecb' && tf !== 'D1') jobs.push(loadSeries(sym, 'D1'));
  return Promise.allSettled(jobs);
}

async function pollPrices() {
  if (document.hidden) return;
  const byAdapter = new Map();
  for (const sym of SYMBOLS) {
    const d = sourceFor(sym);
    if (!ADAPTERS[d.source].prices) continue;
    if (!byAdapter.has(d.source)) byAdapter.set(d.source, []);
    byAdapter.get(d.source).push({ sym, d });
  }
  await Promise.all([...byAdapter].map(async ([src, items]) => {
    try {
      const m = await ADAPTERS[src].prices(items.map(x => x.d));
      const now = Date.now();
      for (const { sym, d } of items) {
        const p = m.get(d.sym);
        if (isNum(p)) { state.prices.set(sym.id, { price: p, at: now, key: sourceKey(d) }); patchForming(sym, p); }
      }
      state.errors.delete(src);
    } catch (e) {
      state.errors.set(src, e.message);
    }
  }));
  state.lastUpdate = Date.now();
  scheduleRender();
}

// Keep the forming bar in step with the live price between candle refreshes.
function patchForming(sym, price) {
  for (const tf of TIMEFRAMES) {
    const s = state.series.get(`${sym.id}|${tf}`);
    const last = s?.candles?.[s.candles.length - 1];
    if (!last || s.closeOnly || (last.time + TF[tf].sec) * 1000 <= Date.now()) continue;
    last.close = price;
    if (price > last.high) last.high = price;
    if (price < last.low) last.low = price;
  }
}

async function pollTrades(ids = SYMBOLS.map(s => s.id)) {
  if (document.hidden) return;
  await Promise.allSettled(ids.map(id => limit(async () => {
    const sym = SYMBOL_BY_ID[id], d = sourceFor(sym), ad = ADAPTERS[d.source];
    if (!ad.trades) return;
    try {
      const t = await ad.trades(d);
      state.trades.set(id, { ...t, at: Date.now(), key: sourceKey(d) });
    } catch { /* keep the previous tape */ }
  })));
  scheduleRender();
}

async function loadOptions(currency) {
  const cur = state.options.get(currency);
  if (cur && Date.now() - cur.at < OPTIONS_MAX_AGE) return;
  try { state.options.set(currency, await optionsSummary(currency)); } catch (e) { state.options.set(currency, { error: e.message, at: Date.now() }); }
  scheduleRender();
}

async function loadCot() {
  if (state.cot.status === 'loading' || (state.cot.status === 'ok' && Date.now() - state.cot.at < 6 * 3_600_000)) return;
  if (state.cot.status === 'error' && Date.now() - state.cot.at < 30 * 60_000) return;
  state.cot.status = 'loading';
  try {
    state.cot = { status: 'ok', data: await cotHistory(), error: null, at: Date.now() };
  } catch (e) {
    state.cot = { status: 'error', data: null, error: e.message, at: Date.now() };
  }
  scheduleRender();
}

function historySource(sym) {
  const h = sym.history;
  if (!h) return null;
  // Use the main source when it already has long history (crypto spot, ECB).
  return h;
}

async function loadMonthly(sym) {
  const h = historySource(sym), cur = state.monthly.get(sym.id);
  if (!h) { state.monthly.set(sym.id, { na: 'Low history', at: Date.now() }); return; }
  if (cur && cur.key === sourceKey(h) && Date.now() - cur.at < (cur.na === 'Error' ? 10 * 60_000 : 24 * 3_600_000)) return;
  if (ADAPTERS[h.source].needsKey && !settings.tdKey) { state.monthly.set(sym.id, { na: 'Needs key', at: Date.now(), key: sourceKey(h) }); return; }
  try {
    const candles = await ADAPTERS[h.source].monthly(h, { tdKey: settings.tdKey });
    state.monthly.set(sym.id, { candles, at: Date.now(), key: sourceKey(h) });
  } catch (e) {
    state.monthly.set(sym.id, { na: e.na || 'Error', error: e.message, at: Date.now(), key: sourceKey(h) });
  }
  scheduleRender();
}

function loadDetail(sym) {
  for (const tf of TIMEFRAMES) loadSeries(sym, tf);
  pollTrades([sym.id]);
  loadMonthly(sym);
  const cur = OPTIONS_CURRENCY[sym.id];
  if (cur) loadOptions(cur);
}

// ---------- evaluation ----------
function contextFor(sym, tf, s) {
  const d = sourceFor(sym), key = sourceKey(d);
  const pr = state.prices.get(sym.id), t = state.trades.get(sym.id);
  const daily = state.series.get(`${sym.id}|D1`);
  const cur = OPTIONS_CURRENCY[sym.id], opt = cur ? state.options.get(cur) : null;
  const m = state.monthly.get(sym.id);
  let cot = null, cotNa = null;
  if (!sym.cot) cotNa = 'No COT report';
  else if (state.cot.status === 'ok') {
    const rec = state.cot.data.get(sym.cot.code);
    if (rec) cot = { ...rec, invert: !!sym.cot.invert }; else cotNa = 'No data';
  } else cotNa = state.cot.status === 'error' ? 'COT unavailable' : 'No data';
  return {
    tf, tfSec: TF[tf].sec, useClosedBar: settings.useClosedBar,
    price: pr && pr.key === key ? pr.price : undefined,
    trades: t && t.key === key ? t : null, tradesSupported: !!ADAPTERS[d.source].trades,
    daily: daily?.candles && daily.key === s.key ? daily.candles : null,
    options: opt?.list ? opt : null, optionsSupported: !!cur,
    cot, cotNa,
    monthly: m?.candles || null, monthlyNa: m?.na || (m ? null : 'No data'),
  };
}

function evalFor(sym, tf) {
  const s = state.series.get(`${sym.id}|${tf}`);
  if (!s || s.key !== sourceKey(sourceFor(sym))) return null;
  const ctx = contextFor(sym, tf, s);
  const sig = [s.fetchedAt, ctx.price, ctx.trades?.at, ctx.daily?.length, ctx.options?.at, state.cot.at, state.monthly.get(sym.id)?.at, settings.useClosedBar].join('|');
  const k = `${sym.id}|${tf}`, memo = state.evals.get(k);
  if (memo && memo.sig === sig) return memo.r;
  const r = evaluate(s, ctx);
  state.evals.set(k, { sig, r });
  return r;
}

function priceFor(sym, tf) {
  const d = sourceFor(sym), pr = state.prices.get(sym.id);
  if (pr && pr.key === sourceKey(d)) return pr.price;
  for (const t of [tf, 'D1', 'H1']) {
    const s = state.series.get(`${sym.id}|${t}`);
    if (s?.candles?.length && s.key === sourceKey(d)) return s.candles[s.candles.length - 1].close;
  }
  return NaN;
}

function changeFor(sym, tf) {
  for (const t of [tf, 'D1']) {
    const r = evalFor(sym, t);
    if (r && isNum(r.change)) return r.change;
  }
  return NaN;
}

// ---------- formatting ----------
const fmtPrice = (p, dp) => isNum(p) ? p.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }) : '—';
const fmtChg = v => isNum(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : '';
const fmtTime = ms => new Date(ms).toLocaleTimeString('en-GB', { hour12: false });
const fmtDay = t => new Date(t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
function fmtAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
const ARROW = { 1: '↑', '-1': '↓', 0: '→' };

// ---------- badges: what kind of data, and how old it is ----------
function badgeFor(sym, tf) {
  const d = sourceFor(sym), ad = ADAPTERS[d.source], s = state.series.get(`${sym.id}|${tf}`);
  const open = isMarketOpen(sym.hours), now = Date.now();
  if (ad.needsKey && !settings.tdKey) return { cls: 'nokey', text: 'Needs key', title: 'Add a free Twelve Data API key in Settings to load this symbol.' };
  if (d.kind === 'eod') {
    const daily = state.series.get(`${sym.id}|D1`)?.candles || s?.candles;
    const t = daily?.[daily.length - 1]?.time;
    return { cls: 'eod', text: t ? `EOD ${fmtDay(t)}` : 'EOD', title: 'ECB reference rate, published once per business day around 16:00 CET. Close only, no intraday data.' };
  }
  if (s?.na === 'Error' && !s.candles) return { cls: 'err', text: 'Error', title: s.error || 'Could not load data' };
  if (ad.prices) {
    const p = state.prices.get(sym.id);
    const at = p && p.key === sourceKey(d) ? p.at : s?.candles ? s.fetchedAt : 0;
    if (!at) return { cls: 'eod', text: 'Loading', title: 'Waiting for the first update' };
    const age = now - at;
    if (age >= FRESH_MS) return { cls: 'delay', text: `Delayed ${fmtAge(age)}`, title: `No update for ${fmtAge(age)}. ${state.errors.get(d.source) || ''}`.trim() };
    if (d.kind === 'proxy' && !open) return { cls: 'off', text: 'Proxy · off-hours', title: `The underlying market is closed (${HOURS_LABEL[sym.hours]}). The perpetual keeps trading, so its price can drift before the next open.` };
    if (d.kind === 'proxy') return { cls: 'proxy', text: 'Proxy · live', title: `Real-time perpetual contract on ${ad.label} that tracks ${sym.name}. It is not the price of the underlying market itself.` };
    return { cls: 'live', text: 'Live', title: `Real-time price from ${ad.label}.` };
  }
  if (!s?.candles) return { cls: 'eod', text: 'Loading', title: 'Waiting for the first update' };
  const pre = d.kind === 'etf' ? 'ETF · ' : '';
  if (!open) return { cls: 'eod', text: `${pre}market closed`, title: HOURS_LABEL[sym.hours] };
  const last = s.candles[s.candles.length - 1];
  const lag = Math.max(0, s.fetchedAt - (last.time + TF[tf].sec) * 1000);
  const age = now - s.fetchedAt + lag;
  const title = `Twelve Data free plan: refreshed every ${settings.tdRefreshMin} min (8 requests per minute, 800 per day).${d.kind === 'etf' ? ` ${d.sym} is an ETF used as a stand-in for ${sym.name}.` : ''}`;
  if (age < FRESH_MS) return { cls: d.kind === 'etf' ? 'proxy' : 'live', text: d.kind === 'etf' ? 'ETF · live' : 'Live', title };
  return { cls: 'delay', text: `${pre}delayed ${fmtAge(age)}`, title };
}

// ---------- scanner table ----------
// A short timeout rather than requestAnimationFrame, which some embedded views pause.
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => { renderQueued = false; render(); }, 40);
}

function voteCell(v) {
  if (!v) return '<span class="v X">…</span>';
  if (v.na) return `<span class="v ${v.na === 'Low history' ? 'W' : 'X'}" title="${esc(v.na)}">${v.na === 'Low history' ? 'Low' : '–'}</span>`;
  const cls = v.vote > 0 ? 'B' : v.vote < 0 ? 'S' : 'N';
  return `<span class="v ${cls}" title="${v.count} indicator${v.count === 1 ? '' : 's'}, score ${v.score.toFixed(2)}">${ARROW[v.vote]}</span>`;
}

function stateTone(id, r) {
  if (id === 'adx' || id === 'sg') return r.state === 'Strong' || r.text === 'Strong' ? 'A' : r.state === 'Flat' || r.text === 'Flat' ? 'W' : 'N';
  if (id === 'sq' || id === 'vo') return /Squeeze/.test(r.state || r.text) ? 'W' : /Expanding/.test(r.state || r.text) ? 'A' : 'N';
  if (id === 'cot') return r.extreme ? 'W' : 'N';
  if (id === 'seas') return r.tendency > 0 ? 'B' : r.tendency < 0 ? 'S' : 'N';
  if (id === 'rvol') return /High/.test(r.text) ? 'A' : 'N';
  if (id === 'spk') return /Spike/.test(r.text) ? 'A' : 'N';
  return 'N';
}

function groupCell(g, v) {
  if (g.votes) return voteCell(v);
  if (!v) return '<span class="v X">…</span>';
  if (v.na) return `<span class="v ${v.na === 'Low history' ? 'W' : 'X'}" title="${esc(v.na)}">${v.na === 'Low history' ? 'Low' : '–'}</span>`;
  let tone = stateTone(g.id, v);
  if (g.id === 'mc') tone = v.text.startsWith('COT') ? (v.tone ? 'W' : 'N') : v.tone > 0 ? 'B' : v.tone < 0 ? 'S' : 'N';
  const arrow = g.id === 'sg' && isNum(v.vote) ? ` ${ARROW[v.vote]}` : '';
  return `<span class="v ${tone}"${v.title ? ` title="${esc(v.title)}"` : ''}>${esc(v.text)}${arrow}</span>`;
}

// COT and seasonal do not depend on the timeframe, so fall back to the daily evaluation
// when the chosen timeframe has no data (ECB symbols on intraday timeframes).
function macroGroup(sym, r) {
  const g = r?.groups.mc;
  if (g && !g.na) return g;
  return evalFor(sym, 'D1')?.groups.mc || g;
}

function filteredSymbols() {
  const q = $('#search').value.trim().toLowerCase();
  let list = SYMBOLS.filter(s => (settings.group === 'All' || s.group === settings.group) && (!q || s.id.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)));
  if (settings.sort !== 'default') {
    const val = s => settings.sort === 'total' ? evalFor(s, settings.tf)?.total?.score : changeFor(s, settings.tf);
    list = [...list].sort((a, b) => (isNum(val(b)) ? val(b) : -Infinity) - (isNum(val(a)) ? val(a) : -Infinity));
  }
  return list;
}

function rowHtml(sym) {
  const tf = settings.tf, d = sourceFor(sym), b = badgeFor(sym, tf), r = evalFor(sym, tf);
  const chg = changeFor(sym, tf);
  const total = !r ? '<span class="v X">…</span>'
    : r.total.na ? `<span class="v ${r.total.na === 'Low history' ? 'W' : 'X'}" title="${esc(r.total.na)}">${esc(r.total.na)}</span>`
      : `<span class="v ${r.total.cls}" title="Score ${r.total.score.toFixed(2)} from ${GROUPS.filter(g => g.votes && !r.groups[g.id].na).length} groups">${r.total.label}</span>`;
  return `<div class="row" role="row" tabindex="0" data-id="${sym.id}"${state.open === sym.id ? ' aria-current="true"' : ''}>
    <div class="c sym"><span class="tk">${sym.id}</span><span class="badge b-${b.cls}" title="${esc(b.title)}">${esc(b.text)}</span><span class="nm">${esc(sym.name)}</span></div>
    <div class="c src" title="${esc(sourceLabel(d))}">${esc(sourceLabel(d))}</div>
    <div class="c q"><span class="px">${fmtPrice(priceFor(sym, tf), sym.dp)}</span><span class="chg ${chg > 0 ? 'up' : chg < 0 ? 'down' : ''}">${fmtChg(chg)}</span></div>
    ${GROUPS.map(g => `<div class="c g" data-g="${g.id}">${groupCell(g, g.id === 'mc' ? macroGroup(sym, r) : r?.groups[g.id])}</div>`).join('')}
    <div class="c tot">${total}</div>
  </div>`;
}

function headHtml() {
  return `<div class="thead" role="row">
    <div class="c symh">Symbol</div><div class="c srch">Source</div><div class="c qh">Price / chg</div>
    ${GROUPS.map(g => `<div class="c g" data-g="${g.id}" title="${g.votes ? 'Votes in Total' : 'Filter or context, no vote'}"><span class="l">${g.name}</span><span class="s">${g.short}</span></div>`).join('')}
    <div class="c tot">Total</div>
  </div>`;
}

function render() {
  const list = filteredSymbols();
  let html = headHtml();
  if (!list.length) html += '<div class="empty">No symbols match.</div>';
  else if (settings.sort === 'default') {
    for (const g of ASSET_GROUPS) {
      const rows = list.filter(s => s.group === g);
      if (!rows.length) continue;
      html += `<div class="sect">${g}<span>${rows.length}</span></div>` + rows.map(rowHtml).join('');
    }
  } else html += list.map(rowHtml).join('');
  $('#table').innerHTML = html;
  renderStatus();
  if (state.open) renderDetail();
}

function renderStatus() {
  const tf = settings.tf;
  const loaded = SYMBOLS.filter(s => state.series.get(`${s.id}|${tf}`)?.candles || sourceFor(s).source === 'ecb' && state.series.get(`${s.id}|D1`)?.candles).length;
  const errs = [...state.errors].map(([k, v]) => `${ADAPTERS[k].label}: ${v}`);
  const cot = state.cot.status === 'error' ? `COT: ${state.cot.error}` : null;
  const problems = [...errs, cot].filter(Boolean);
  $('#status').innerHTML = `${state.lastUpdate ? `Updated ${fmtTime(state.lastUpdate)}` : 'Loading market data…'} · ${loaded}/${SYMBOLS.length} symbols on ${tf} · votes from ${settings.useClosedBar ? 'last closed bar' : 'forming bar'}`
    + (problems.length ? ` · <span class="err" title="${esc(problems.join('\n'))}">${problems.length} source issue${problems.length > 1 ? 's' : ''}</span>` : '');
}

// ---------- detail panel ----------
const wide = () => matchMedia('(min-width: 900px)').matches;

function indCell(def, r) {
  if (!r) return '<span class="v X">…</span>';
  const v = r.ind[def.id];
  if (v.na) return `<span class="v ${v.na === 'Low history' ? 'W' : 'X'}" title="${esc(v.na)}">${esc(v.na)}</span>`;
  if (v.stateOnly) {
    const arrow = def.id === 'adx' && isNum(v.vote) ? ` ${ARROW[v.vote]}` : '';
    return `<span class="v ${stateTone(def.id, v)}" title="${esc(v.text)}">${esc(v.text)}${arrow}</span>`;
  }
  const cls = v.vote > 0 ? 'B' : v.vote < 0 ? 'S' : 'N';
  return `<span class="v ${cls}" title="${esc(v.text || '')}">${v.text ? esc(v.text) + ' ' : ''}${ARROW[v.vote]}</span>`;
}

function noteHtml(def, results) {
  const r = results.find(x => x && !x.ind[def.id].na)?.ind[def.id];
  let extra = '';
  if (def.id === 'ovp' && r?.profile) extra = profileHtml(r.profile);
  if (def.id === 'seas' && r?.seasonal) extra = monthsHtml(r.seasonal);
  if (def.id === 'cot' && r?.cot) {
    const rec = state.cot.data?.get(SYMBOL_BY_ID[state.open].cot.code);
    extra = `<p><b>Report:</b> ${esc(rec?.market || '')}, positions as of ${esc(r.cot.date)} (${r.cot.weeks} weeks of history).</p>`;
  }
  return `<div class="note"><p><b>What it measures.</b> ${esc(def.what)}</p><p><b>Formula.</b> ${esc(def.formula)}</p><p><b>Signal.</b> ${esc(def.rule)}</p>${extra}</div>`;
}

function profileHtml(p) {
  const price = priceFor(SYMBOL_BY_ID[state.open], 'H1');
  const near = p.strikes.filter(s => !isNum(price) || (s.strike > price * 0.7 && s.strike < price * 1.3));
  const top = [...near].sort((a, b) => (b.callVol + b.putVol) - (a.callVol + a.putVol)).slice(0, 14).sort((a, b) => b.strike - a.strike);
  const max = Math.max(...top.map(s => Math.max(s.callVol, s.putVol)), 1e-9);
  const rows = top.map(s => `<div class="k${s.strike === p.poc ? ' poc' : ''}">${s.strike.toLocaleString('en-US')}</div>
    <div class="bar call" style="width:${(100 * s.callVol / max).toFixed(1)}%" title="Calls ${s.callVol.toFixed(1)}"></div>
    <div class="bar put" style="width:${(100 * s.putVol / max).toFixed(1)}%" title="Puts ${s.putVol.toFixed(1)}"></div>`).join('');
  return `<p><b>Deribit, last 24h.</b> Calls ${p.callVol.toFixed(0)}, puts ${p.putVol.toFixed(0)} (in coins). POC ${p.poc?.toLocaleString('en-US')}, call wall ${p.callWall?.toLocaleString('en-US')}, put wall ${p.putWall?.toLocaleString('en-US')}.</p>
    <div class="prof"><div class="k">Strike</div><div>Calls</div><div>Puts</div>${rows}</div>`;
}

function monthsHtml(s) {
  const name = m => new Date(Date.UTC(2000, m, 1)).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return `<div class="months">${s.byMonth.map(x => {
    const cls = !isNum(x.avg) ? 'v X' : x.avg > 0 ? 'v B' : 'v S';
    return `<div class="${cls}" title="${name(x.m)}: avg ${(x.avg * 100).toFixed(2)}%, up ${Math.round(x.win * 100)}% of ${x.n} years"${x.m === s.m ? ' style="outline:1px solid var(--text)"' : ''}>${name(x.m)}<br>${isNum(x.avg) ? (x.avg * 100).toFixed(1) : '—'}</div>`;
  }).join('')}</div>`;
}

function historyText(sym) {
  let weeks = 0;
  for (const tf of ['W1', 'D1']) {
    const c = state.series.get(`${sym.id}|${tf}`)?.candles;
    if (c?.length) weeks = Math.max(weeks, (c[c.length - 1].time - c[0].time) / 604800);
  }
  if (!weeks) return 'Loading…';
  return weeks >= 104 ? `${(weeks / 52).toFixed(1)} years loaded` : `${Math.round(weeks)} weeks loaded`;
}

function renderDetail() {
  const el = $('#detail'), sym = SYMBOL_BY_ID[state.open];
  if (!sym) return;
  const keepScroll = el.scrollTop;
  const d = sourceFor(sym), b = badgeFor(sym, wide() ? settings.tf : state.detailTf);
  const tfs = wide() ? TIMEFRAMES : [state.detailTf];
  const results = tfs.map(tf => evalFor(sym, tf));
  const opts = sym.sources.map(x => `<option value="${esc(sourceKey(x))}"${sourceKey(x) === sourceKey(d) ? ' selected' : ''}${usable(x) ? '' : ' disabled'}>${esc(sourceLabel(x))} (${x.kind})${usable(x) ? '' : ' · needs key'}</option>`).join('');
  let mx = `<div class="mx" style="--n:${tfs.length}"><div></div>${tfs.map(tf => `<div class="h">${tf}</div>`).join('')}`;
  mx += `<div class="gh" style="grid-column:auto">Total</div>${results.map(r => `<div class="cell">${!r ? '<span class="v X">…</span>' : r.total.na ? `<span class="v X">${esc(r.total.na)}</span>` : `<span class="v ${r.total.cls}"><b>${r.total.label}</b></span>`}</div>`).join('')}`;
  for (const g of GROUPS) {
    mx += `<div class="gh" style="grid-column:auto">${g.name}</div>${results.map(r => `<div class="cell">${groupCell(g, r?.groups[g.id])}</div>`).join('')}`;
    for (const def of INDICATORS.filter(x => x.group === g.id)) {
      const open = state.info === def.id;
      mx += `<button class="nm" type="button" data-info="${def.id}" aria-expanded="${open}">${esc(def.name)}</button>${results.map(r => `<div class="cell">${indCell(def, r)}</div>`).join('')}`;
      if (open) mx += noteHtml(def, results);
    }
  }
  mx += '</div>';
  el.innerHTML = `
    <div class="panel-head">
      <button class="back" type="button" data-close aria-label="Close">←</button>
      <div style="flex:1;min-width:0">
        <h2>${sym.id} <span class="badge b-${b.cls}" title="${esc(b.title)}">${esc(b.text)}</span></h2>
        <div class="sub">${esc(sym.name)} · ${fmtPrice(priceFor(sym, settings.tf), sym.dp)} <span class="${changeFor(sym, settings.tf) >= 0 ? 'up' : 'down'}">${fmtChg(changeFor(sym, settings.tf))}</span></div>
      </div>
    </div>
    <dl class="meta">
      <dt>Source</dt><dd><select id="d-source" aria-label="Data source">${opts}</select></dd>
      <dt>Market hours</dt><dd>${esc(HOURS_LABEL[sym.hours])} · ${isMarketOpen(sym.hours) ? 'open now' : 'closed now'}</dd>
      <dt>History</dt><dd>${historyText(sym)}</dd>
      <dt>Votes from</dt><dd>${settings.useClosedBar ? 'last closed bar' : 'forming bar'} · tap an indicator for its meaning and formula</dd>
    </dl>
    <div class="seg dtf" id="d-tf">${TIMEFRAMES.map(tf => `<button type="button" data-tf="${tf}" aria-pressed="${tf === state.detailTf}">${tf}</button>`).join('')}</div>
    ${mx}`;
  el.scrollTop = keepScroll;
}

function openDetail(id, push = true) {
  const sym = SYMBOL_BY_ID[id];
  if (!sym) return;
  state.open = id;
  state.detailTf = settings.tf;
  state.info = null;
  $('#detail').hidden = false;
  $('#scrim').hidden = !wide();
  document.body.style.overflow = wide() ? '' : 'hidden';
  if (push && location.hash !== `#${id}`) history.pushState({ detail: id }, '', `#${id}`);
  loadDetail(sym);
  render();
  $('#detail').scrollTop = 0;
}

function closeDetail(pop = false) {
  if (!state.open) return;
  state.open = null;
  $('#detail').hidden = true;
  $('#scrim').hidden = true;
  document.body.style.overflow = '';
  if (!pop && location.hash) history.replaceState(null, '', location.pathname + location.search);
  render();
}

// ---------- settings ----------
const DATA_ROWS = [
  ['Binance spot', 'BTC, ETH', 'Real time', 'None'],
  ['Binance perp (TradFi)', 'Gold, silver, copper, WTI, 7 US stocks', 'Real time, proxy', 'None'],
  ['Hyperliquid perp', 'WTI, Brent, S&P 500, Nasdaq 100, SMH, EUR/USD, USD/JPY', 'Real time, proxy', 'None'],
  ['Bybit, OKX', 'Alternatives for crypto, metals, stocks, GBP/USD', 'Real time (proxy for non-crypto)', 'None'],
  ['Coinbase, Kraken', 'BTC, ETH alternatives', 'Real time', 'None'],
  ['Twelve Data', '7 forex pairs intraday, ETFs for wheat, corn, soybeans, Dow, Russell, SOXX, long history for seasonality', 'Delayed by the refresh cycle (default 15 min)', 'Free API key'],
  ['ECB via Frankfurter', '7 forex pairs and DXY without a key', 'End of day, close only', 'None'],
  ['CFTC', 'COT index for futures markets', 'Weekly (Tuesday positions, out Friday)', 'None'],
  ['Deribit', 'BTC and ETH options volume profile', '24h statistics, refreshed every 5 min', 'None'],
];
const dataTable = () => `<table class="tbl"><thead><tr><th>Source</th><th>Used for</th><th>Delay</th><th>Key</th></tr></thead><tbody>${DATA_ROWS.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
const ABOUT = `<p>Lai Long Scanner™ v${VERSION}. © 2026 Lai Long. All rights reserved. “Lai Long”, the Lai Long logo and the Lai Long Scanner name are trademarks of Lai Long. The software, interface design, signal model and documentation are the intellectual property of Lai Long.</p>
  <p>Market data © its respective providers. Prices from perpetual contracts and ETFs are proxies and can differ from the underlying market. Signals are mechanical and for information only. Not financial advice.</p>
  <p><a href="${REPO_URL}" target="_blank" rel="noopener">Source on GitHub</a></p>`;

function renderSettings() {
  const t = settings.theme, dlg = $('#settings');
  const srcRows = ASSET_GROUPS.map(g => {
    const rows = SYMBOLS.filter(s => s.group === g && s.sources.length > 1).map(s => `<label>${s.id}<select data-src="${s.id}">${s.sources.map(x => `<option value="${esc(sourceKey(x))}"${sourceKey(x) === sourceKey(sourceFor(s)) ? ' selected' : ''}${usable(x) ? '' : ' disabled'}>${esc(sourceLabel(x))}${usable(x) ? '' : ' (needs key)'}</option>`).join('')}</select></label>`).join('');
    return rows ? `<h4 style="margin:10px 0 6px;font-size:12px">${g}</h4><div class="srcs">${rows}</div>` : '';
  }).join('');
  dlg.innerHTML = `
    <div class="sheet-head"><h2>Settings</h2><button class="btn" type="button" data-close>Close</button></div>
    <div class="sheet-body">
      <h3>Appearance</h3>
      <div class="form">
        <label>Theme</label>
        <div class="seg" id="s-preset">${[...Object.keys(PRESETS), 'Custom'].map(p => `<button type="button" data-preset="${p}" aria-pressed="${t.preset === p}">${p}</button>`).join('')}</div>
        <label for="s-font">Font</label>
        <select id="s-font">${Object.keys(FONTS).map(f => `<option${f === t.font ? ' selected' : ''}>${f}</option>`).join('')}</select>
      </div>
      <p>Pick any colour below to make your own theme. IBM Plex Mono is an open font with a terminal look similar to Bloomberg's own typeface.</p>
      <div class="colors">${COLOR_KEYS.map(([k, l]) => `<label><input type="color" data-color="${k}" value="${t.colors[k]}">${l}</label>`).join('')}</div>
      <p><button class="btn" type="button" id="s-reset">Reset to Light</button></p>

      <h3>Signals</h3>
      <div class="form">
        <label for="s-closed">Repainting</label>
        <label><input type="checkbox" id="s-closed"${settings.useClosedBar ? ' checked' : ''}> Score the last closed bar, so votes do not flicker while a bar is forming</label>
      </div>

      <h3>Twelve Data (optional, free)</h3>
      <p>Unlocks intraday data for USDCHF, AUDUSD, USDCAD, NZDUSD, EURJPY, GBPJPY and EURGBP, the ETFs used for wheat, corn, soybeans, Dow Jones, Russell 2000 and semiconductors, and long monthly history for the seasonal index. Your key is stored only in this browser and is sent only to api.twelvedata.com. <a href="https://twelvedata.com/pricing" target="_blank" rel="noopener">Get a free key</a>.</p>
      <div class="form">
        <label for="s-tdkey">API key</label>
        <div style="display:flex;gap:6px"><input id="s-tdkey" type="password" autocomplete="off" spellcheck="false" value="${esc(settings.tdKey)}" style="flex:1"><button class="btn" type="button" id="s-tdshow">Show</button></div>
        <label for="s-tdmin">Refresh every (minutes)</label>
        <input id="s-tdmin" type="number" min="5" max="240" step="1" value="${settings.tdRefreshMin}">
        <label>Used today</label><span>${tdUsedToday()} of 800 free credits</span>
      </div>

      <h3>Data source per symbol</h3>
      <p>The first source that works is used by default. Sources marked "needs key" become available after you add a Twelve Data key.</p>
      ${srcRows}

      <h3>Data and delays</h3>
      ${dataTable()}

      <h3>About</h3>
      ${ABOUT}
    </div>`;
}

function setTheme(patch) {
  Object.assign(settings.theme, patch);
  applyTheme(settings.theme);
  save();
}

function bindSettings() {
  const dlg = $('#settings');
  dlg.addEventListener('click', e => {
    const p = e.target.closest('[data-preset]');
    if (p) {
      const name = p.dataset.preset;
      setTheme(name === 'Custom' ? { preset: 'Custom' } : { preset: name, colors: { ...PRESETS[name] } });
      renderSettings();
      return;
    }
    if (e.target.id === 's-reset') { setTheme({ preset: 'Light', font: 'IBM Plex Mono', colors: { ...PRESETS.Light } }); renderSettings(); return; }
    if (e.target.id === 's-tdshow') { const i = $('#s-tdkey'); i.type = i.type === 'password' ? 'text' : 'password'; e.target.textContent = i.type === 'password' ? 'Show' : 'Hide'; return; }
    if (e.target.closest('[data-close]')) dlg.close();
  });
  dlg.addEventListener('input', e => {
    const c = e.target.dataset.color;
    if (c) {
      setTheme({ preset: 'Custom', colors: { ...settings.theme.colors, [c]: e.target.value } });
      dlg.querySelectorAll('[data-preset]').forEach(b => b.setAttribute('aria-pressed', b.dataset.preset === 'Custom'));
    }
  });
  dlg.addEventListener('change', e => {
    const t = e.target;
    if (t.id === 's-font') setTheme({ font: t.value });
    else if (t.id === 's-closed') { settings.useClosedBar = t.checked; save(); render(); }
    else if (t.id === 's-tdkey') {
      settings.tdKey = t.value.trim(); save();
      state.monthly.clear();
      renderSettings(); reloadAfterSourceChange();
    } else if (t.id === 's-tdmin') { settings.tdRefreshMin = Math.min(240, Math.max(5, Math.round(+t.value) || 15)); save(); }
    else if (t.dataset.src) {
      settings.sources[t.dataset.src] = t.value; save();
      reloadAfterSourceChange();
    }
  });
}

function reloadAfterSourceChange() {
  state.evals.clear();
  loadAll(settings.tf);
  pollPrices();
  pollTrades();
  for (const s of SYMBOLS) loadMonthly(s);
  if (state.open) loadDetail(SYMBOL_BY_ID[state.open]);
  render();
}

// ---------- legend ----------
function renderLegend() {
  const badge = (cls, text, desc) => `<div><span class="badge b-${cls}">${text}</span><span>${desc}</span></div>`;
  const v = (cls, text, desc) => `<div><span class="v ${cls}">${text}</span><span>${desc}</span></div>`;
  const inds = GROUPS.map(g => `<h4 style="margin:16px 0 4px;font-size:13px">${g.name}${g.votes ? ' · votes in Total' : ' · context, no vote'}</h4>` +
    INDICATORS.filter(d => d.group === g.id).map(d => `<div class="ind"><h4>${esc(d.name)}</h4>
      <p><span class="k">What it measures.</span> ${esc(d.what)}</p>
      <p><span class="k">Formula.</span> ${esc(d.formula)}</p>
      <p><span class="k">Signal.</span> ${esc(d.rule)}</p></div>`).join('')).join('');
  $('#legend').innerHTML = `
    <div class="sheet-head"><h2>Legend and formulas</h2><button class="btn" type="button" data-close>Close</button></div>
    <div class="sheet-body">
      <h3>Data badges, next to every symbol</h3>
      <div class="lg">
        ${badge('live', 'Live', 'Real-time price of the asset itself.')}
        ${badge('proxy', 'Proxy · live', 'Real-time perpetual contract that tracks the asset, not the underlying market price.')}
        ${badge('off', 'Proxy · off-hours', 'The underlying market is closed; the perp keeps trading.')}
        ${badge('delay', 'Delayed 8m', 'Measured age of the latest data, not a fixed promise.')}
        ${badge('eod', 'EOD Oct 23', 'End-of-day reference rate with its date. Close only.')}
        ${badge('proxy', 'ETF · live', 'An ETF used as a stand-in for an index or commodity.')}
        ${badge('nokey', 'Needs key', 'Add a free Twelve Data key in Settings.')}
        ${badge('err', 'Error', 'The source failed; hover for the reason.')}
      </div>
      <h3>Signal symbols</h3>
      <div class="lg">
        ${v('B', '↑', 'Bullish vote')}
        ${v('S', '↓', 'Bearish vote')}
        ${v('N', '→', 'Neutral vote')}
        ${v('X', '–', 'Not available for this source; hover for the reason')}
        ${v('W', 'Low', 'Not enough history for this indicator')}
        ${v('A', 'Strong', 'Highlighted state: strong trend, expanding bands, high volume')}
        ${v('W', 'Squeeze', 'Warning state: flat trend, squeeze, COT extreme')}
        ${v('N', '58 ↑', 'Value with its vote, for example RSI 58 bullish')}
      </div>
      <h3>Columns</h3>
      <div class="lg">
        ${GROUPS.map(g => `<div><b style="font-weight:600;min-width:46px">${g.short}</b><span>${g.name}: ${INDICATORS.filter(d => d.group === g.id).map(d => d.name).join(', ')}.${g.votes ? '' : ' No vote.'}</span></div>`).join('')}
      </div>
      <h3>Total</h3>
      <div class="lg">
        ${v('B', 'Strong buy', 'Average group vote above +0.5 and ADX strong')}
        ${v('B', 'Buy', 'Average group vote above +0.1')}
        ${v('N', 'Neutral', 'Groups disagree')}
        ${v('N', 'Wait', 'ADX flat: the market is ranging')}
        ${v('S', 'Sell', 'Average group vote below −0.1')}
        ${v('S', 'Strong sell', 'Average group vote below −0.5 and ADX strong')}
      </div>
      <p>Each voting group gives one vote: the average of its indicators' votes, rounded to ↑ (above +0.2), ↓ (below −0.2) or →. Total is the average of the group votes, so a group with many indicators does not outweigh the others. Strength and Volatility act as filters, Macro is context. Notation in formulas: H, L, C = high, low, close; t = current bar; HHₙ and LLₙ = highest high and lowest low of n bars.</p>
      <h3>Indicators</h3>
      ${inds}
      <h3>Data and delays</h3>
      ${dataTable()}
      <h3>About</h3>
      ${ABOUT}
    </div>`;
}

// ---------- controls ----------
function renderControls() {
  $('#tf').innerHTML = TIMEFRAMES.map(tf => `<button type="button" data-tf="${tf}" aria-pressed="${tf === settings.tf}">${tf}</button>`).join('');
  $('#groups').innerHTML = ['All', ...ASSET_GROUPS].map(g => `<button type="button" data-group="${g}" aria-pressed="${g === settings.group}">${g}</button>`).join('');
  $('#sort').value = settings.sort;
}

function bindUi() {
  $('#tf').addEventListener('click', e => {
    const b = e.target.closest('[data-tf]');
    if (!b) return;
    settings.tf = b.dataset.tf; save();
    renderControls(); render();
    loadAll(settings.tf);
  });
  $('#groups').addEventListener('click', e => {
    const b = e.target.closest('[data-group]');
    if (!b) return;
    settings.group = b.dataset.group; save();
    renderControls(); render();
  });
  $('#search').addEventListener('input', scheduleRender);
  $('#sort').addEventListener('change', e => { settings.sort = e.target.value; save(); render(); });
  $('#table').addEventListener('click', e => { const r = e.target.closest('.row'); if (r) openDetail(r.dataset.id); });
  $('#table').addEventListener('keydown', e => { if (e.key === 'Enter') { const r = e.target.closest('.row'); if (r) openDetail(r.dataset.id); } });
  $('#scrim').addEventListener('click', () => closeDetail());
  $('#detail').addEventListener('click', e => {
    if (e.target.closest('[data-close]')) return closeDetail();
    const i = e.target.closest('[data-info]');
    if (i) { state.info = state.info === i.dataset.info ? null : i.dataset.info; renderDetail(); return; }
    const t = e.target.closest('[data-tf]');
    if (t) { state.detailTf = t.dataset.tf; renderDetail(); }
  });
  $('#detail').addEventListener('change', e => {
    if (e.target.id === 'd-source') {
      settings.sources[state.open] = e.target.value; save();
      reloadAfterSourceChange();
    }
  });
  $('#btn-settings').addEventListener('click', () => { renderSettings(); $('#settings').showModal(); });
  $('#btn-legend').addEventListener('click', () => { renderLegend(); $('#legend').showModal(); });
  $('#legend').addEventListener('click', e => { if (e.target.closest('[data-close]') || e.target === $('#legend')) $('#legend').close(); });
  $('#settings').addEventListener('click', e => { if (e.target === $('#settings')) $('#settings').close(); });
  bindSettings();
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && state.open && !document.querySelector('dialog[open]')) closeDetail(); });
  window.addEventListener('popstate', () => {
    const id = location.hash.slice(1);
    if (SYMBOL_BY_ID[id]) openDetail(id, false); else closeDetail(true);
  });
  matchMedia('(min-width: 900px)').addEventListener('change', () => { if (state.open) openDetail(state.open, false); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { pollPrices(); loadAll(settings.tf); } });
  const top = $('.top');
  new ResizeObserver(() => document.documentElement.style.setProperty('--head-h', `${top.offsetHeight}px`)).observe(top);
}

// ---------- start ----------
applyTheme(settings.theme);
renderControls();
bindUi();
render();
loadAll(settings.tf).then(() => {
  pollTrades();
  for (const s of SYMBOLS) loadMonthly(s);
});
pollPrices();
loadCot();
setInterval(pollPrices, PRICE_POLL_MS);
setInterval(() => { if (!document.hidden) { loadAll(settings.tf); if (state.open) loadDetail(SYMBOL_BY_ID[state.open]); loadCot(); } }, SERIES_CHECK_MS);
setInterval(() => pollTrades(), TRADES_POLL_MS);
setInterval(scheduleRender, 5000);
const initial = location.hash.slice(1);
if (SYMBOL_BY_ID[initial]) openDetail(initial, false);
