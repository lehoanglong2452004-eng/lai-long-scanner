// Lai Long Scanner: data scheduling, rendering of the scanner table, detail panel,
// settings and legend.
import { SYMBOLS, SYMBOL_BY_ID, ASSET_GROUPS } from './symbols.js';
import { ADAPTERS, TF, TIMEFRAMES, sourceKey, sourceLabel, optionsSummary, OPTIONS_CURRENCY, cotHistory, tdUsedToday } from './sources.js';
import { evaluate, INDICATORS, GROUPS } from './signals.js';
import { isMarketOpen } from './hours.js';
import { loadSettings, saveSettings } from './store.js';
import { PRESETS, FONTS, COLOR_KEYS, applyTheme } from './theme.js';
import { t, tr, lang, setLang, locale, LANGS, monthName, groupName, groupShort, symbolName, indText, dataRows } from './i18n.js';

const VERSION = '0.2.0';
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
if (!settings.lang) settings.lang = /^vi\b/i.test(navigator.language || '') ? 'vi' : 'en';
setLang(settings.lang);
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
      const tape = await ad.trades(d);
      state.trades.set(id, { ...tape, at: Date.now(), key: sourceKey(d) });
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

async function loadMonthly(sym) {
  const h = sym.history, cur = state.monthly.get(sym.id);
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
  const pr = state.prices.get(sym.id), tape = state.trades.get(sym.id);
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
    trades: tape && tape.key === key ? tape : null, tradesSupported: !!ADAPTERS[d.source].trades,
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
  const sig = [lang(), s.fetchedAt, ctx.price, ctx.trades?.at, ctx.daily?.length, ctx.options?.at, state.cot.at, state.monthly.get(sym.id)?.at, settings.useClosedBar].join('|');
  const k = `${sym.id}|${tf}`, memo = state.evals.get(k);
  if (memo && memo.sig === sig) return memo.r;
  const r = evaluate(s, ctx);
  state.evals.set(k, { sig, r });
  return r;
}

function priceFor(sym, tf) {
  const d = sourceFor(sym), pr = state.prices.get(sym.id);
  if (pr && pr.key === sourceKey(d)) return pr.price;
  for (const x of [tf, 'D1', 'H1']) {
    const s = state.series.get(`${sym.id}|${x}`);
    if (s?.candles?.length && s.key === sourceKey(d)) return s.candles[s.candles.length - 1].close;
  }
  return NaN;
}

function changeFor(sym, tf) {
  for (const x of [tf, 'D1']) {
    const r = evalFor(sym, x);
    if (r && isNum(r.change)) return r.change;
  }
  return NaN;
}

// ---------- formatting ----------
const fmtPrice = (p, dp) => isNum(p) ? p.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }) : '—';
const fmtChg = v => isNum(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : '';
const fmtTime = ms => new Date(ms).toLocaleTimeString('en-GB', { hour12: false });
const fmtDay = sec => new Date(sec * 1000).toLocaleDateString(locale(), { month: 'short', day: 'numeric', timeZone: 'UTC' });
function fmtAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const vi = lang() === 'vi';
  if (s < 60) return `${s}${vi ? ' giây' : 's'}`;
  if (s < 3600) return `${Math.round(s / 60)}${vi ? ' phút' : 'm'}`;
  if (s < 172800) return `${Math.round(s / 3600)}${vi ? ' giờ' : 'h'}`;
  return `${Math.round(s / 86400)}${vi ? ' ngày' : 'd'}`;
}
const ARROW = { 1: '↑', '-1': '↓', 0: '→' };
const naText = code => tr('na', code);
const naCell = code => `<span class="v ${code === 'Low history' ? 'W' : 'X'}" title="${esc(naText(code))}">${esc(code === 'Low history' ? t('na.Low') : '–')}</span>`;

// ---------- badges: what kind of data, and how old it is ----------
function badgeFor(sym, tf) {
  const d = sourceFor(sym), ad = ADAPTERS[d.source], s = state.series.get(`${sym.id}|${tf}`);
  const open = isMarketOpen(sym.hours), now = Date.now(), hours = t(`hours.${sym.hours}`);
  if (ad.needsKey && !settings.tdKey) return { cls: 'nokey', text: t('b.nokey'), title: t('bt.nokey') };
  if (d.kind === 'eod') {
    const daily = state.series.get(`${sym.id}|D1`)?.candles || s?.candles;
    const last = daily?.[daily.length - 1]?.time;
    return { cls: 'eod', text: last ? t('b.eod', { date: fmtDay(last) }) : t('b.eodNone'), title: t('bt.eod') };
  }
  if (s?.na === 'Error' && !s.candles) return { cls: 'err', text: t('b.error'), title: s.error || t('b.error') };
  if (ad.prices) {
    const p = state.prices.get(sym.id);
    const at = p && p.key === sourceKey(d) ? p.at : s?.candles ? s.fetchedAt : 0;
    if (!at) return { cls: 'eod', text: t('b.loading'), title: t('bt.loading') };
    const age = now - at;
    if (age >= FRESH_MS) return { cls: 'delay', text: t('b.delayed', { age: fmtAge(age) }), title: `${t('bt.stale', { age: fmtAge(age) })} ${state.errors.get(d.source) || ''}`.trim() };
    if (d.kind === 'proxy' && !open) return { cls: 'off', text: t('b.off'), title: t('bt.off', { hours }) };
    if (d.kind === 'proxy') return { cls: 'proxy', text: t('b.proxy'), title: t('bt.proxy', { src: ad.label, name: symbolName(sym) }) };
    return { cls: 'live', text: t('b.live'), title: t('bt.live', { src: ad.label }) };
  }
  if (!s?.candles) return { cls: 'eod', text: t('b.loading'), title: t('bt.loading') };
  const etf = d.kind === 'etf';
  const title = t('bt.td', { min: settings.tdRefreshMin }) + (etf ? ` ${t('bt.etf', { etf: d.sym, name: symbolName(sym) })}` : '');
  if (!open) return { cls: 'eod', text: t(etf ? 'b.etfClosed' : 'b.closed'), title: hours };
  const last = s.candles[s.candles.length - 1];
  const lag = Math.max(0, s.fetchedAt - (last.time + TF[tf].sec) * 1000);
  const age = now - s.fetchedAt + lag;
  if (age < FRESH_MS) return { cls: etf ? 'proxy' : 'live', text: t(etf ? 'b.etfLive' : 'b.live'), title };
  return { cls: 'delay', text: t(etf ? 'b.etfDelayed' : 'b.delayed', { age: fmtAge(age) }), title };
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
  if (v.na) return naCell(v.na);
  const cls = v.vote > 0 ? 'B' : v.vote < 0 ? 'S' : 'N';
  return `<span class="v ${cls}" title="${esc(t('grp.title', { n: v.count, score: v.score.toFixed(2) }))}">${ARROW[v.vote]}</span>`;
}

// Colour for a state, from its internal code.
function stateTone(id, code, r = {}) {
  if (id === 'adx' || id === 'sg') return code === 'Strong' ? 'A' : code === 'Flat' ? 'W' : 'N';
  if (id === 'sq' || id === 'vo') return code === 'Squeeze' ? 'W' : code === 'Expanding' ? 'A' : 'N';
  if (id === 'cot') return r.extreme ? 'W' : 'N';
  if (id === 'seas') return r.tendency > 0 ? 'B' : r.tendency < 0 ? 'S' : 'N';
  if (id === 'rvol') return code === 'High' ? 'A' : 'N';
  if (id === 'spk') return code === 'Spike' ? 'A' : 'N';
  return 'N';
}

function groupCell(g, v) {
  if (g.votes) return voteCell(v);
  if (!v) return '<span class="v X">…</span>';
  if (v.na) return naCell(v.na);
  if (g.id === 'mc') {
    const tone = v.text.startsWith('COT') ? (v.tone ? 'W' : 'N') : v.tone > 0 ? 'B' : v.tone < 0 ? 'S' : 'N';
    return `<span class="v ${tone}"${v.title ? ` title="${esc(v.title)}"` : ''}>${esc(v.text)}</span>`;
  }
  const arrow = g.id === 'sg' && isNum(v.vote) ? ` ${ARROW[v.vote]}` : '';
  return `<span class="v ${stateTone(g.id, v.text)}">${esc(tr('st', v.text))}${arrow}</span>`;
}

// COT and seasonal do not depend on the timeframe, so fall back to the daily evaluation
// when the chosen timeframe has no data (ECB symbols on intraday timeframes).
function macroGroup(sym, r) {
  const g = r?.groups.mc;
  if (g && !g.na) return g;
  return evalFor(sym, 'D1')?.groups.mc || g;
}

function totalCell(r) {
  if (!r) return '<span class="v X">…</span>';
  if (r.total.na) return `<span class="v ${r.total.na === 'Low history' ? 'W' : 'X'}" title="${esc(naText(r.total.na))}">${esc(naText(r.total.na))}</span>`;
  const n = GROUPS.filter(g => g.votes && !r.groups[g.id].na).length;
  return `<span class="v ${r.total.cls}" title="${esc(t('tot.title', { score: r.total.score.toFixed(2), n }))}">${esc(r.total.label)}</span>`;
}

function filteredSymbols() {
  const q = $('#search').value.trim().toLowerCase();
  let list = SYMBOLS.filter(s => (settings.group === 'All' || s.group === settings.group)
    && (!q || s.id.toLowerCase().includes(q) || s.name.toLowerCase().includes(q) || symbolName(s).toLowerCase().includes(q)));
  if (settings.sort !== 'default') {
    const val = s => settings.sort === 'total' ? evalFor(s, settings.tf)?.total?.score : changeFor(s, settings.tf);
    list = [...list].sort((a, b) => (isNum(val(b)) ? val(b) : -Infinity) - (isNum(val(a)) ? val(a) : -Infinity));
  }
  return list;
}

function rowHtml(sym) {
  const tf = settings.tf, d = sourceFor(sym), b = badgeFor(sym, tf), r = evalFor(sym, tf);
  const chg = changeFor(sym, tf);
  return `<div class="row" role="row" tabindex="0" data-id="${sym.id}"${state.open === sym.id ? ' aria-current="true"' : ''}>
    <div class="c sym"><span class="tk">${sym.id}</span><span class="badge b-${b.cls}" title="${esc(b.title)}">${esc(b.text)}</span><span class="nm">${esc(symbolName(sym))}</span></div>
    <div class="c src" title="${esc(sourceLabel(d))}">${esc(sourceLabel(d))}</div>
    <div class="c q"><span class="px">${fmtPrice(priceFor(sym, tf), sym.dp)}</span><span class="chg ${chg > 0 ? 'up' : chg < 0 ? 'down' : ''}">${fmtChg(chg)}</span></div>
    ${GROUPS.map(g => `<div class="c g" data-g="${g.id}">${groupCell(g, g.id === 'mc' ? macroGroup(sym, r) : r?.groups[g.id])}</div>`).join('')}
    <div class="c tot">${totalCell(r)}</div>
  </div>`;
}

function headHtml() {
  return `<div class="thead" role="row">
    <div class="c symh">${t('col.symbol')}</div><div class="c srch">${t('col.source')}</div><div class="c qh">${t('col.price')}</div>
    ${GROUPS.map(g => `<div class="c g" data-g="${g.id}" title="${esc(t(g.votes ? 'col.votes' : 'col.context'))}"><span class="l">${esc(groupName(g))}</span><span class="s">${esc(groupShort(g))}</span></div>`).join('')}
    <div class="c tot">${t('col.total')}</div>
  </div>`;
}

function render() {
  const list = filteredSymbols();
  let html = headHtml();
  if (!list.length) html += `<div class="empty">${t('empty')}</div>`;
  else if (settings.sort === 'default') {
    for (const g of ASSET_GROUPS) {
      const rows = list.filter(s => s.group === g);
      if (!rows.length) continue;
      html += `<div class="sect">${esc(t(`grp.${g}`))}<span>${rows.length}</span></div>` + rows.map(rowHtml).join('');
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
  $('#status').innerHTML = `${state.lastUpdate ? t('status.updated', { time: fmtTime(state.lastUpdate) }) : t('status.loading')} · ${t('status.symbols', { n: loaded, total: SYMBOLS.length, tf })} · ${t(settings.useClosedBar ? 'status.closed' : 'status.forming')}`
    + (problems.length ? ` · <span class="err" title="${esc(problems.join('\n'))}">${esc(t('status.issues', { n: problems.length }))}</span>` : '');
}

// ---------- detail panel ----------
const wide = () => matchMedia('(min-width: 900px)').matches;

function indCell(def, r) {
  if (!r) return '<span class="v X">…</span>';
  const v = r.ind[def.id];
  if (v.na) return `<span class="v ${v.na === 'Low history' ? 'W' : 'X'}">${esc(naText(v.na))}</span>`;
  if (v.stateOnly) {
    const arrow = def.id === 'adx' && isNum(v.vote) ? ` ${ARROW[v.vote]}` : '';
    return `<span class="v ${stateTone(def.id, v.state, v)}">${esc(v.text)}${arrow}</span>`;
  }
  const cls = v.vote > 0 ? 'B' : v.vote < 0 ? 'S' : 'N';
  return `<span class="v ${cls}">${v.text ? esc(v.text) + ' ' : ''}${ARROW[v.vote]}</span>`;
}

function noteHtml(def, results) {
  const r = results.find(x => x && !x.ind[def.id].na)?.ind[def.id];
  let extra = '';
  if (def.id === 'ovp' && r?.profile) extra = profileHtml(r.profile);
  if (def.id === 'seas' && r?.seasonal) extra = monthsHtml(r.seasonal);
  if (def.id === 'cot' && r?.cot) {
    const rec = state.cot.data?.get(SYMBOL_BY_ID[state.open].cot.code);
    extra = `<p><b>${t('d.report')}</b> ${esc(rec?.market || '')}, ${esc(t('d.asOf', { date: r.cot.date, n: r.cot.weeks }))}</p>`;
  }
  return `<div class="note"><p><b>${t('d.what')}</b> ${esc(indText(def, 'what'))}</p><p><b>${t('d.formula')}</b> ${esc(indText(def, 'formula'))}</p><p><b>${t('d.signal')}</b> ${esc(indText(def, 'rule'))}</p>${extra}</div>`;
}

function profileHtml(p) {
  const price = priceFor(SYMBOL_BY_ID[state.open], 'H1');
  const near = p.strikes.filter(s => !isNum(price) || (s.strike > price * 0.7 && s.strike < price * 1.3));
  const top = [...near].sort((a, b) => (b.callVol + b.putVol) - (a.callVol + a.putVol)).slice(0, 14).sort((a, b) => b.strike - a.strike);
  const max = Math.max(...top.map(s => Math.max(s.callVol, s.putVol)), 1e-9);
  const n = v => v?.toLocaleString('en-US');
  const rows = top.map(s => `<div class="k${s.strike === p.poc ? ' poc' : ''}">${n(s.strike)}</div>
    <div class="bar call" style="width:${(100 * s.callVol / max).toFixed(1)}%" title="${t('d.calls')} ${s.callVol.toFixed(1)}"></div>
    <div class="bar put" style="width:${(100 * s.putVol / max).toFixed(1)}%" title="${t('d.puts')} ${s.putVol.toFixed(1)}"></div>`).join('');
  return `<p><b>${t('d.deribit')}</b> ${t('d.calls')} ${p.callVol.toFixed(0)}, ${t('d.puts')} ${p.putVol.toFixed(0)} (${t('d.coins')}). ${t('d.poc')} ${n(p.poc)}, ${t('d.callWall')} ${n(p.callWall)}, ${t('d.putWall')} ${n(p.putWall)}.</p>
    <div class="prof"><div class="k">${t('d.strike')}</div><div>${t('d.calls')}</div><div>${t('d.puts')}</div>${rows}</div>`;
}

function monthsHtml(s) {
  return `<div class="months">${s.byMonth.map(x => {
    const cls = !isNum(x.avg) ? 'v X' : x.avg > 0 ? 'v B' : 'v S';
    const tip = t('d.monthTip', { m: monthName(x.m), avg: (x.avg * 100).toFixed(2), win: Math.round(x.win * 100), n: x.n });
    return `<div class="${cls}" title="${esc(tip)}"${x.m === s.m ? ' style="outline:1px solid var(--text)"' : ''}>${esc(monthName(x.m))}<br>${isNum(x.avg) ? (x.avg * 100).toFixed(1) : '—'}</div>`;
  }).join('')}</div>`;
}

function historyText(sym) {
  let weeks = 0;
  for (const tf of ['W1', 'D1']) {
    const c = state.series.get(`${sym.id}|${tf}`)?.candles;
    if (c?.length) weeks = Math.max(weeks, (c[c.length - 1].time - c[0].time) / 604800);
  }
  if (!weeks) return t('d.loading');
  return weeks >= 104 ? t('d.years', { n: (weeks / 52).toFixed(1) }) : t('d.weeks', { n: Math.round(weeks) });
}

function renderDetail() {
  const el = $('#detail'), sym = SYMBOL_BY_ID[state.open];
  if (!sym) return;
  const keepScroll = el.scrollTop;
  const d = sourceFor(sym), b = badgeFor(sym, wide() ? settings.tf : state.detailTf);
  const tfs = wide() ? TIMEFRAMES : [state.detailTf];
  const results = tfs.map(tf => evalFor(sym, tf));
  const span = tfs.length > 1 ? ` style="grid-column:span ${tfs.length}"` : '';
  const opts = sym.sources.map(x => `<option value="${esc(sourceKey(x))}"${sourceKey(x) === sourceKey(d) ? ' selected' : ''}${usable(x) ? '' : ' disabled'}>${esc(sourceLabel(x))} (${esc(t(`kind.${x.kind}`))})${usable(x) ? '' : ` · ${esc(t('kind.needsKey'))}`}</option>`).join('');
  let mx = `<div class="mx" style="--n:${tfs.length}"><div></div>${tfs.map(tf => `<div class="h">${tf}</div>`).join('')}`;
  mx += `<div class="gh">${t('col.total')}</div>${results.map(r => `<div class="cell">${totalCell(r)}</div>`).join('')}`;
  for (const g of GROUPS) {
    // Macro does not depend on the timeframe: one cell across all columns.
    const headCells = g.id === 'mc'
      ? `<div class="cell"${span}>${groupCell(g, results.map(r => r?.groups.mc).find(x => x && !x.na) || results[0]?.groups.mc)}</div>`
      : results.map(r => `<div class="cell">${groupCell(g, r?.groups[g.id])}</div>`).join('');
    mx += `<div class="gh">${esc(groupName(g))}</div>${headCells}`;
    for (const def of INDICATORS.filter(x => x.group === g.id)) {
      const open = state.info === def.id;
      let cells;
      if (def.tfFree && tfs.length > 1) {
        const r = results.find(x => x && !x.ind[def.id].na) || results[0];
        cells = `<div class="cell wide"${span} title="${esc(t('d.allTf'))}">${indCell(def, r)}</div>`;
      } else cells = results.map(r => `<div class="cell">${indCell(def, r)}</div>`).join('');
      mx += `<button class="nm" type="button" data-info="${def.id}" aria-expanded="${open}">${esc(indText(def, 'name'))}</button>${cells}`;
      if (open) mx += noteHtml(def, results);
    }
  }
  mx += '</div>';
  const chg = changeFor(sym, settings.tf);
  el.innerHTML = `
    <div class="panel-head">
      <button class="back" type="button" data-close aria-label="${esc(t('d.close'))}">←</button>
      <div style="flex:1;min-width:0">
        <h2>${sym.id} <span class="badge b-${b.cls}" title="${esc(b.title)}">${esc(b.text)}</span></h2>
        <div class="sub">${esc(symbolName(sym))} · ${fmtPrice(priceFor(sym, settings.tf), sym.dp)} <span class="${chg >= 0 ? 'up' : 'down'}">${fmtChg(chg)}</span></div>
      </div>
    </div>
    <dl class="meta">
      <dt>${t('d.source')}</dt><dd><select id="d-source" aria-label="${esc(t('d.source'))}">${opts}</select></dd>
      <dt>${t('d.hours')}</dt><dd>${esc(t(`hours.${sym.hours}`))} · ${t(isMarketOpen(sym.hours) ? 'd.open' : 'd.closed')}</dd>
      <dt>${t('d.history')}</dt><dd>${historyText(sym)}</dd>
      <dt>${t('d.votesFrom')}</dt><dd>${t(settings.useClosedBar ? 'd.lastClosed' : 'd.forming')} · ${t('d.tap')}</dd>
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
const dataTable = () => `<table class="tbl"><thead><tr><th>${t('t.source')}</th><th>${t('t.usedFor')}</th><th>${t('t.delay')}</th><th>${t('t.key')}</th></tr></thead><tbody>${dataRows().map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
const aboutHtml = () => `<p>${esc(t('about.1', { v: VERSION }))}</p><p>${esc(t('about.2'))}</p><p><a href="${REPO_URL}" target="_blank" rel="noopener">${t('about.repo')}</a></p>`;

function renderSettings() {
  const th = settings.theme, dlg = $('#settings');
  const srcRows = ASSET_GROUPS.map(g => {
    const rows = SYMBOLS.filter(s => s.group === g && s.sources.length > 1).map(s => `<label>${s.id}<select data-src="${s.id}">${s.sources.map(x => `<option value="${esc(sourceKey(x))}"${sourceKey(x) === sourceKey(sourceFor(s)) ? ' selected' : ''}${usable(x) ? '' : ' disabled'}>${esc(sourceLabel(x))}${usable(x) ? '' : ` (${esc(t('kind.needsKey'))})`}</option>`).join('')}</select></label>`).join('');
    return rows ? `<h4 style="margin:10px 0 6px;font-size:12px">${esc(t(`grp.${g}`))}</h4><div class="srcs">${rows}</div>` : '';
  }).join('');
  dlg.innerHTML = `
    <div class="sheet-head"><h2>${t('s.title')}</h2><button class="btn" type="button" data-close>${t('d.close')}</button></div>
    <div class="sheet-body">
      <h3>${t('s.lang')}</h3>
      <div class="seg" id="s-lang">${Object.entries(LANGS).map(([k, v]) => `<button type="button" data-lang="${k}" aria-pressed="${lang() === k}">${v}</button>`).join('')}</div>

      <h3>${t('s.appearance')}</h3>
      <div class="form">
        <label>${t('s.theme')}</label>
        <div class="seg" id="s-preset">${[...Object.keys(PRESETS), 'Custom'].map(p => `<button type="button" data-preset="${p}" aria-pressed="${th.preset === p}">${p === 'Custom' ? t('s.custom') : p}</button>`).join('')}</div>
        <label for="s-font">${t('s.font')}</label>
        <select id="s-font">${Object.keys(FONTS).map(f => `<option${f === th.font ? ' selected' : ''}>${f}</option>`).join('')}</select>
      </div>
      <p>${esc(t('s.colorsHelp'))}</p>
      <div class="colors">${COLOR_KEYS.map(([k]) => `<label><input type="color" data-color="${k}" value="${th.colors[k]}">${t(`c.color${k[0].toUpperCase()}${k.slice(1)}`)}</label>`).join('')}</div>
      <p><button class="btn" type="button" id="s-reset">${t('s.reset')}</button></p>

      <h3>${t('s.signals')}</h3>
      <div class="form">
        <label for="s-closed">${t('s.repaint')}</label>
        <label><input type="checkbox" id="s-closed"${settings.useClosedBar ? ' checked' : ''}> ${t('s.closedBar')}</label>
      </div>

      <h3>${t('s.td')}</h3>
      <p>${esc(t('s.tdHelp'))} <a href="https://twelvedata.com/pricing" target="_blank" rel="noopener">${t('s.tdGet')}</a>.</p>
      <div class="form">
        <label for="s-tdkey">${t('s.tdKey')}</label>
        <div style="display:flex;gap:6px"><input id="s-tdkey" type="password" autocomplete="off" spellcheck="false" value="${esc(settings.tdKey)}" style="flex:1"><button class="btn" type="button" id="s-tdshow">${t('s.show')}</button></div>
        <label for="s-tdmin">${t('s.tdEvery')}</label>
        <input id="s-tdmin" type="number" min="5" max="240" step="1" value="${settings.tdRefreshMin}">
        <label>${t('s.tdUsed')}</label><span>${t('s.tdCredits', { n: tdUsedToday() })}</span>
      </div>

      <h3>${t('s.perSymbol')}</h3>
      <p>${esc(t('s.perSymbolHelp'))}</p>
      ${srcRows}

      <h3>${t('s.delays')}</h3>
      ${dataTable()}

      <h3>${t('s.about')}</h3>
      ${aboutHtml()}
    </div>`;
}

function setTheme(patch) {
  Object.assign(settings.theme, patch);
  applyTheme(settings.theme);
  save();
}

function changeLang(l) {
  settings.lang = l;
  setLang(l);
  save();
  applyStaticText();
  renderControls();
  render();
  if ($('#settings').open) renderSettings();
  if ($('#legend').open) renderLegend();
}

function bindSettings() {
  const dlg = $('#settings');
  dlg.addEventListener('click', e => {
    const l = e.target.closest('[data-lang]');
    if (l) { changeLang(l.dataset.lang); return; }
    const p = e.target.closest('[data-preset]');
    if (p) {
      const name = p.dataset.preset;
      setTheme(name === 'Custom' ? { preset: 'Custom' } : { preset: name, colors: { ...PRESETS[name] } });
      renderSettings();
      return;
    }
    if (e.target.id === 's-reset') { setTheme({ preset: 'Light', font: 'IBM Plex Mono', colors: { ...PRESETS.Light } }); renderSettings(); return; }
    if (e.target.id === 's-tdshow') { const i = $('#s-tdkey'); i.type = i.type === 'password' ? 'text' : 'password'; e.target.textContent = t(i.type === 'password' ? 's.show' : 's.hide'); return; }
    if (e.target.closest('[data-close]') || e.target === dlg) dlg.close();
  });
  dlg.addEventListener('input', e => {
    const c = e.target.dataset.color;
    if (c) {
      setTheme({ preset: 'Custom', colors: { ...settings.theme.colors, [c]: e.target.value } });
      dlg.querySelectorAll('[data-preset]').forEach(b => b.setAttribute('aria-pressed', b.dataset.preset === 'Custom'));
    }
  });
  dlg.addEventListener('change', e => {
    const el = e.target;
    if (el.id === 's-font') setTheme({ font: el.value });
    else if (el.id === 's-closed') { settings.useClosedBar = el.checked; save(); render(); }
    else if (el.id === 's-tdkey') {
      settings.tdKey = el.value.trim(); save();
      state.monthly.clear();
      renderSettings(); reloadAfterSourceChange();
    } else if (el.id === 's-tdmin') { settings.tdRefreshMin = Math.min(240, Math.max(5, Math.round(+el.value) || 15)); save(); }
    else if (el.dataset.src) {
      settings.sources[el.dataset.src] = el.value; save();
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
  const badge = (cls, text, desc) => `<div><span class="badge b-${cls}">${esc(text)}</span><span>${esc(desc)}</span></div>`;
  const v = (cls, text, desc) => `<div><span class="v ${cls}">${esc(text)}</span><span>${esc(desc)}</span></div>`;
  const inds = GROUPS.map(g => `<h4 style="margin:16px 0 4px;font-size:13px">${esc(groupName(g))} · ${t(g.votes ? 'l.votesIn' : 'l.contextNoVote')}</h4>` +
    INDICATORS.filter(d => d.group === g.id).map(d => `<div class="ind"><h4>${esc(indText(d, 'name'))}</h4>
      <p><span class="k">${t('d.what')}</span> ${esc(indText(d, 'what'))}</p>
      <p><span class="k">${t('d.formula')}</span> ${esc(indText(d, 'formula'))}</p>
      <p><span class="k">${t('d.signal')}</span> ${esc(indText(d, 'rule'))}</p></div>`).join('')).join('');
  $('#legend').innerHTML = `
    <div class="sheet-head"><h2>${t('l.title')}</h2><button class="btn" type="button" data-close>${t('d.close')}</button></div>
    <div class="sheet-body">
      <h3>${t('l.badges')}</h3>
      <div class="lg">
        ${badge('live', t('b.live'), t('l.live'))}
        ${badge('proxy', t('b.proxy'), t('l.proxy'))}
        ${badge('off', t('b.off'), t('l.off'))}
        ${badge('delay', t('b.delayed', { age: fmtAge(8 * 60_000) }), t('l.delayed'))}
        ${badge('eod', t('b.eod', { date: fmtDay(Date.UTC(2026, 9, 23) / 1000) }), t('l.eod'))}
        ${badge('proxy', t('b.etfLive'), t('l.etf'))}
        ${badge('nokey', t('b.nokey'), t('l.nokey'))}
        ${badge('err', t('b.error'), t('l.error'))}
      </div>
      <h3>${t('l.symbols')}</h3>
      <div class="lg">
        ${v('B', '↑', t('l.up'))}
        ${v('S', '↓', t('l.down'))}
        ${v('N', '→', t('l.flat'))}
        ${v('X', '–', t('l.na'))}
        ${v('W', t('na.Low'), t('l.low'))}
        ${v('A', t('st.Strong'), t('l.accent'))}
        ${v('W', t('st.Squeeze'), t('l.warn'))}
        ${v('N', '58 ↑', t('l.value'))}
      </div>
      <h3>${t('l.columns')}</h3>
      <div class="lg">
        ${GROUPS.map(g => `<div><b style="font-weight:600;min-width:46px">${esc(groupShort(g))}</b><span>${esc(groupName(g))}: ${INDICATORS.filter(d => d.group === g.id).map(d => esc(indText(d, 'name'))).join(', ')}.${g.votes ? '' : ` ${t('l.noVote')}`}</span></div>`).join('')}
      </div>
      <h3>${t('l.total')}</h3>
      <div class="lg">
        ${v('B', t('tot.Strong buy'), t('l.sbuy'))}
        ${v('B', t('tot.Buy'), t('l.buy'))}
        ${v('N', t('tot.Neutral'), t('l.neutral'))}
        ${v('N', t('tot.Wait'), t('l.wait'))}
        ${v('S', t('tot.Sell'), t('l.sell'))}
        ${v('S', t('tot.Strong sell'), t('l.ssell'))}
      </div>
      <p>${esc(t('l.rules'))} ${esc(t('l.notation'))}</p>
      <h3>${t('l.indicators')}</h3>
      ${inds}
      <h3>${t('s.delays')}</h3>
      ${dataTable()}
      <h3>${t('s.about')}</h3>
      ${aboutHtml()}
    </div>`;
}

// ---------- static text and controls ----------
function applyStaticText() {
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); el.title = t(el.dataset.i18nAria); });
  $('#search').placeholder = t('search');
  $('#search').setAttribute('aria-label', t('search.aria'));
  const lb = $('#btn-lang');
  lb.textContent = lang() === 'vi' ? 'EN' : 'VI';
  lb.title = t('nav.lang');
  lb.setAttribute('aria-label', t('nav.lang'));
}

function renderControls() {
  $('#tf').innerHTML = TIMEFRAMES.map(tf => `<button type="button" data-tf="${tf}" aria-pressed="${tf === settings.tf}">${tf}</button>`).join('');
  $('#groups').innerHTML = ['All', ...ASSET_GROUPS].map(g => `<button type="button" data-group="${g}" aria-pressed="${g === settings.group}">${esc(t(`grp.${g}`))}</button>`).join('');
  $('#sort').innerHTML = ['default', 'total', 'change'].map(s => `<option value="${s}"${settings.sort === s ? ' selected' : ''}>${t(`sort.${s}`)}</option>`).join('');
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
    const b = e.target.closest('[data-tf]');
    if (b) { state.detailTf = b.dataset.tf; renderDetail(); }
  });
  $('#detail').addEventListener('change', e => {
    if (e.target.id === 'd-source') {
      settings.sources[state.open] = e.target.value; save();
      reloadAfterSourceChange();
    }
  });
  $('#btn-lang').addEventListener('click', () => changeLang(lang() === 'vi' ? 'en' : 'vi'));
  $('#btn-settings').addEventListener('click', () => { renderSettings(); $('#settings').showModal(); });
  $('#btn-legend').addEventListener('click', () => { renderLegend(); $('#legend').showModal(); });
  $('#legend').addEventListener('click', e => { if (e.target.closest('[data-close]') || e.target === $('#legend')) $('#legend').close(); });
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
applyStaticText();
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
