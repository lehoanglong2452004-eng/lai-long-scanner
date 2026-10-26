// Market data adapters. Every adapter returns candles normalised to
// { time (UTC seconds, bar open), open, high, low, close, volume, takerBuy? }.
// All endpoints are public and allow browser (CORS) requests; only Twelve Data needs a key.

export const TF = {
  M5: { sec: 300, binance: '5m', hl: '5m', bybit: '5', okx: '5m', coinbase: 300, kraken: 5, td: '5min' },
  M15: { sec: 900, binance: '15m', hl: '15m', bybit: '15', okx: '15m', coinbase: 900, kraken: 15, td: '15min' },
  H1: { sec: 3600, binance: '1h', hl: '1h', bybit: '60', okx: '1H', coinbase: 3600, kraken: 60, td: '1h' },
  H4: { sec: 14400, binance: '4h', hl: '4h', bybit: '240', okx: '4H', coinbase: 3600, coinbaseGroup: 'h4', kraken: 240, td: '4h' },
  D1: { sec: 86400, binance: '1d', hl: '1d', bybit: 'D', okx: '1Dutc', coinbase: 86400, kraken: 1440, td: '1day' },
  W1: { sec: 604800, binance: '1w', hl: '1w', bybit: 'W', okx: '1Wutc', coinbase: 86400, coinbaseGroup: 'week', kraken: 10080, td: '1week' },
};
export const TIMEFRAMES = Object.keys(TF);
const INTRADAY = new Set(['M5', 'M15', 'H1', 'H4']);
const BARS = 500;

// Errors carrying `na` are expected states (shown as a reason), not failures.
export class Unavailable extends Error {
  constructor(na, message = na) { super(message); this.na = na; }
}

async function getJSON(url, opts = {}, timeout = 15000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    if (!res.ok) {
      const msg = (body && (body.msg || body.message || body.retMsg)) || `HTTP ${res.status}`;
      throw new Error(res.status === 451 || res.status === 403 ? `${msg} (blocked in your region? switch source in Settings)` : msg);
    }
    return body;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Request timed out');
    if (e instanceof TypeError) throw new Error('Network error');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
const postJSON = (url, body) => getJSON(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const num = v => +v;
const weekStart = t => { const day = Math.floor(t / 86400); return (day - ((day + 3) % 7)) * 86400; }; // Monday 00:00 UTC
const h4Start = t => Math.floor(t / 14400) * 14400;
const monthStart = t => { const d = new Date(t * 1000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000; };

// Merge consecutive bars that share a bucket key.
function aggregate(c, key) {
  const out = [];
  for (const k of c) {
    const t = key(k.time), last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, k.high); last.low = Math.min(last.low, k.low);
      last.close = k.close; last.volume += k.volume;
    } else out.push({ ...k, time: t });
  }
  return out;
}

// Big trades: notional at least 10x the median of the tape.
function bigTrades(list) {
  if (!list.length) return { buys: 0, sells: 0, n: 0 };
  const notional = list.map(t => t.px * t.sz).sort((a, b) => a - b);
  const threshold = 10 * notional[Math.floor(notional.length / 2)];
  let buys = 0, sells = 0;
  for (const t of list) if (t.px * t.sz >= threshold) t.buy ? buys++ : sells++;
  return { buys, sells, n: list.length, threshold };
}

// ---------- Binance ----------
const BINANCE_SPOT = ['https://api.binance.com', 'https://data-api.binance.vision'];
async function binanceSpotGet(path) {
  let err;
  for (const base of BINANCE_SPOT) {
    try { return await getJSON(base + path); } catch (e) { err = e; }
  }
  throw err;
}
const binanceKlines = rows => rows.map(r => ({ time: r[0] / 1000, open: num(r[1]), high: num(r[2]), low: num(r[3]), close: num(r[4]), volume: num(r[5]), takerBuy: num(r[9]) }));
const FAPI = 'https://fapi.binance.com';

// ---------- Hyperliquid ----------
const HL = 'https://api.hyperliquid.xyz/info';

// ---------- Bybit / OKX ----------
function checkBybit(r) { if (r.retCode !== 0) throw new Error(r.retMsg || 'Bybit error'); return r.result; }
function checkOkx(r) { if (r.code !== '0') throw new Error(r.msg || 'OKX error'); return r.data; }
const bybit = category => ({
  label: category === 'spot' ? 'Bybit spot' : 'Bybit perp',
  async candles(d, tf) {
    const r = checkBybit(await getJSON(`https://api.bybit.com/v5/market/kline?category=${category}&symbol=${d.sym}&interval=${TF[tf].bybit}&limit=${BARS}`));
    return { candles: r.list.map(x => ({ time: x[0] / 1000, open: num(x[1]), high: num(x[2]), low: num(x[3]), close: num(x[4]), volume: num(x[5]) })).reverse(), hasVolume: true };
  },
  async prices(ds) {
    const m = new Map();
    await Promise.all(ds.map(async d => {
      const r = checkBybit(await getJSON(`https://api.bybit.com/v5/market/tickers?category=${category}&symbol=${d.sym}`));
      if (r.list[0]) m.set(d.sym, num(r.list[0].lastPrice));
    }));
    return m;
  },
  async trades(d) {
    const r = checkBybit(await getJSON(`https://api.bybit.com/v5/market/recent-trade?category=${category}&symbol=${d.sym}&limit=${category === 'spot' ? 60 : 1000}`));
    return bigTrades(r.list.map(t => ({ px: num(t.price), sz: num(t.size), buy: t.side === 'Buy' })));
  },
});
const okx = label => ({
  label,
  async candles(d, tf) {
    const r = checkOkx(await getJSON(`https://www.okx.com/api/v5/market/candles?instId=${d.sym}&bar=${TF[tf].okx}&limit=300`));
    return { candles: r.map(x => ({ time: x[0] / 1000, open: num(x[1]), high: num(x[2]), low: num(x[3]), close: num(x[4]), volume: num(x[5]) })).reverse(), hasVolume: true };
  },
  async prices(ds) {
    const m = new Map();
    await Promise.all(ds.map(async d => {
      const r = checkOkx(await getJSON(`https://www.okx.com/api/v5/market/ticker?instId=${d.sym}`));
      if (r[0]) m.set(d.sym, num(r[0].last));
    }));
    return m;
  },
  async trades(d) {
    const r = checkOkx(await getJSON(`https://www.okx.com/api/v5/market/trades?instId=${d.sym}&limit=500`));
    return bigTrades(r.map(t => ({ px: num(t.px), sz: num(t.sz), buy: t.side === 'buy' })));
  },
});

// ---------- Twelve Data (free key: 8 requests per minute, 800 per day) ----------
const TD_GAP_MS = 8000;
const TD_DAILY_CAP = 790;
let tdChain = Promise.resolve(), tdLast = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function tdBudget() {
  const day = new Date().toISOString().slice(0, 10);
  let rec;
  try { rec = JSON.parse(localStorage.getItem('lls.td.count')) || {}; } catch { rec = {}; }
  if (rec.day !== day) rec = { day, n: 0 };
  return rec;
}
function tdQueue(fn) {
  const run = tdChain.then(async () => {
    const rec = tdBudget();
    if (rec.n >= TD_DAILY_CAP) throw new Error('Twelve Data daily limit reached, resets at 00:00 UTC');
    const wait = tdLast + TD_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    tdLast = Date.now();
    rec.n++;
    try { localStorage.setItem('lls.td.count', JSON.stringify(rec)); } catch { /* storage unavailable */ }
    return fn();
  });
  tdChain = run.catch(() => {});
  return run;
}
export const tdUsedToday = () => tdBudget().n;

// ---------- ECB reference rates via Frankfurter (one request covers every pair) ----------
let ecbCache = null;
async function ecbRows() {
  if (ecbCache && Date.now() - ecbCache.at < 3600e3) return ecbCache.rows;
  // 15 years: enough for weekly EMA200 and for the monthly seasonal index.
  const from = new Date(Date.now() - 15 * 365.25 * 86400e3).toISOString().slice(0, 10);
  const r = await getJSON(`https://api.frankfurter.dev/v1/${from}..?base=USD&symbols=EUR,JPY,GBP,CAD,SEK,CHF,AUD,NZD`);
  const rows = Object.entries(r.rates).map(([date, x]) => ({ time: Date.parse(date + 'T00:00:00Z') / 1000, x }));
  ecbCache = { at: Date.now(), rows };
  return rows;
}
const ECB_PAIRS = {
  EURUSD: x => 1 / x.EUR, GBPUSD: x => 1 / x.GBP, USDJPY: x => x.JPY, USDCHF: x => x.CHF,
  AUDUSD: x => 1 / x.AUD, USDCAD: x => x.CAD, NZDUSD: x => 1 / x.NZD,
  EURJPY: x => x.JPY / x.EUR, GBPJPY: x => x.JPY / x.GBP, EURGBP: x => x.GBP / x.EUR,
  // ICE US Dollar Index: geometric basket of six currencies.
  DXY: x => 50.14348112 * (1 / x.EUR) ** -0.576 * x.JPY ** 0.136 * (1 / x.GBP) ** -0.119 * x.CAD ** 0.091 * x.SEK ** 0.042 * x.CHF ** 0.036,
};

export const ADAPTERS = {
  binance: {
    label: 'Binance spot',
    async candles(d, tf) {
      return { candles: binanceKlines(await binanceSpotGet(`/api/v3/klines?symbol=${d.sym}&interval=${TF[tf].binance}&limit=${BARS}`)), hasVolume: true, hasTakerBuy: true };
    },
    async prices(ds) {
      const r = await binanceSpotGet(`/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(ds.map(d => d.sym)))}`);
      return new Map(r.map(x => [x.symbol, num(x.price)]));
    },
    async trades(d) {
      return bigTrades((await binanceSpotGet(`/api/v3/aggTrades?symbol=${d.sym}&limit=1000`)).map(t => ({ px: num(t.p), sz: num(t.q), buy: !t.m })));
    },
    async monthly(d) {
      return binanceKlines(await binanceSpotGet(`/api/v3/klines?symbol=${d.sym}&interval=1M&limit=240`));
    },
  },
  binanceFut: {
    label: 'Binance perp',
    async candles(d, tf) {
      return { candles: binanceKlines(await getJSON(`${FAPI}/fapi/v1/klines?symbol=${d.sym}&interval=${TF[tf].binance}&limit=${BARS}`)), hasVolume: true, hasTakerBuy: true };
    },
    async prices(ds) {
      const want = new Set(ds.map(d => d.sym));
      const r = await getJSON(`${FAPI}/fapi/v1/ticker/price`);
      return new Map(r.filter(x => want.has(x.symbol)).map(x => [x.symbol, num(x.price)]));
    },
    async trades(d) {
      return bigTrades((await getJSON(`${FAPI}/fapi/v1/aggTrades?symbol=${d.sym}&limit=1000`)).map(t => ({ px: num(t.p), sz: num(t.q), buy: !t.m })));
    },
  },
  hyperliquid: {
    label: 'Hyperliquid perp',
    async candles(d, tf) {
      const end = Date.now(), start = end - BARS * TF[tf].sec * 1000;
      const rows = await postJSON(HL, { type: 'candleSnapshot', req: { coin: d.sym, interval: TF[tf].hl, startTime: start, endTime: end } });
      if (!Array.isArray(rows)) throw new Error('Unexpected Hyperliquid response');
      return { candles: rows.map(r => ({ time: r.t / 1000, open: num(r.o), high: num(r.h), low: num(r.l), close: num(r.c), volume: num(r.v) })), hasVolume: true };
    },
    async prices(ds) {
      const m = new Map();
      for (const dex of new Set(ds.map(d => d.sym.split(':')[0]))) {
        const r = await postJSON(HL, { type: 'allMids', dex });
        for (const d of ds) if (r[d.sym] !== undefined) m.set(d.sym, num(r[d.sym]));
      }
      return m;
    },
    async trades(d) {
      const r = await postJSON(HL, { type: 'recentTrades', coin: d.sym });
      return bigTrades(r.map(t => ({ px: num(t.px), sz: num(t.sz), buy: t.side === 'B' })));
    },
  },
  bybitSpot: bybit('spot'),
  bybitPerp: bybit('linear'),
  okxSpot: okx('OKX spot'),
  okxSwap: okx('OKX perp'),
  coinbase: {
    label: 'Coinbase',
    async candles(d, tf) {
      const t = TF[tf];
      const rows = await getJSON(`https://api.exchange.coinbase.com/products/${d.sym}/candles?granularity=${t.coinbase}`);
      let c = rows.map(x => ({ time: x[0], low: x[1], high: x[2], open: x[3], close: x[4], volume: x[5] })).reverse();
      if (t.coinbaseGroup) c = aggregate(c, t.coinbaseGroup === 'week' ? weekStart : h4Start);
      return { candles: c, hasVolume: true };
    },
    async prices(ds) {
      const m = new Map();
      await Promise.all(ds.map(async d => m.set(d.sym, num((await getJSON(`https://api.exchange.coinbase.com/products/${d.sym}/ticker`)).price))));
      return m;
    },
    async trades(d) {
      // Coinbase reports the maker side, so a "sell" maker means a taker bought.
      const r = await getJSON(`https://api.exchange.coinbase.com/products/${d.sym}/trades?limit=1000`);
      return bigTrades(r.map(t => ({ px: num(t.price), sz: num(t.size), buy: t.side === 'sell' })));
    },
  },
  kraken: {
    label: 'Kraken',
    async candles(d, tf) {
      const r = await getJSON(`https://api.kraken.com/0/public/OHLC?pair=${d.sym}&interval=${TF[tf].kraken}`);
      if (r.error?.length) throw new Error(r.error[0]);
      return { candles: r.result[d.key].map(x => ({ time: x[0], open: num(x[1]), high: num(x[2]), low: num(x[3]), close: num(x[4]), volume: num(x[6]) })), hasVolume: true };
    },
    async prices(ds) {
      const r = await getJSON(`https://api.kraken.com/0/public/Ticker?pair=${ds.map(d => d.sym).join(',')}`);
      if (r.error?.length) throw new Error(r.error[0]);
      return new Map(ds.filter(d => r.result[d.key]).map(d => [d.sym, num(r.result[d.key].c[0])]));
    },
    async trades(d) {
      const r = await getJSON(`https://api.kraken.com/0/public/Trades?pair=${d.sym}&count=1000`);
      if (r.error?.length) throw new Error(r.error[0]);
      return bigTrades(r.result[d.key].map(t => ({ px: num(t[0]), sz: num(t[1]), buy: t[3] === 'b' })));
    },
  },
  twelvedata: {
    label: 'Twelve Data',
    needsKey: true,
    async candles(d, tf, { tdKey }) {
      if (!tdKey) throw new Unavailable('Needs key', 'Add a free Twelve Data API key in Settings');
      const interval = tf === 'MN' ? '1month' : TF[tf].td;
      const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(d.sym)}&interval=${interval}&outputsize=${tf === 'MN' ? 240 : BARS}&timezone=UTC&apikey=${encodeURIComponent(tdKey)}`;
      const r = await tdQueue(() => getJSON(url));
      if (r.status === 'error' || !r.values) throw new Error(r.message || 'Twelve Data error');
      const candles = r.values.map(v => ({
        time: Date.parse(v.datetime.length > 10 ? v.datetime.replace(' ', 'T') + 'Z' : v.datetime + 'T00:00:00Z') / 1000,
        open: num(v.open), high: num(v.high), low: num(v.low), close: num(v.close),
        volume: v.volume !== undefined ? num(v.volume) : 0,
      })).reverse();
      return { candles, hasVolume: candles.some(k => k.volume > 0) };
    },
    async monthly(d, opts) {
      return (await this.candles(d, 'MN', opts)).candles;
    },
  },
  ecb: {
    label: 'ECB',
    async candles(d, tf) {
      if (INTRADAY.has(tf)) throw new Unavailable('D1/W1 only', 'ECB publishes one reference rate per business day');
      const rows = await ecbRows(), f = ECB_PAIRS[d.sym];
      let c = rows.map(r => { const v = f(r.x); return { time: r.time, open: v, high: v, low: v, close: v, volume: 0 }; }).filter(k => Number.isFinite(k.close));
      if (tf === 'W1') c = aggregate(c, weekStart);
      if (tf === 'MN') c = aggregate(c, monthStart);
      return { candles: c, closeOnly: true, hasVolume: false };
    },
    async monthly(d) {
      return (await this.candles(d, 'MN')).candles;
    },
  },
};

// CFTC Commitments of Traders, legacy futures-only report (weekly, Tuesday positions).
// The CFTC API blocks browser requests, so tools/update-cot.mjs builds data/cot.json every
// week (GitHub Action) and the site reads that file from its own origin.
export async function cotHistory() {
  const r = await getJSON('data/cot.json', { cache: 'no-cache' });
  return new Map(Object.entries(r.markets).map(([code, m]) => [code, { market: m.market, rows: m.rows, generatedAt: r.generatedAt }]));
}

// Deribit option summaries (24h volume and open interest per instrument), BTC and ETH only.
export const OPTIONS_CURRENCY = { BTCUSD: 'BTC', ETHUSD: 'ETH' };
export async function optionsSummary(currency) {
  const r = await getJSON(`https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${currency}&kind=option`, {}, 25000);
  const list = [];
  for (const x of r.result || []) {
    const [, expiry, strike, type] = x.instrument_name.split('-');
    list.push({ expiry, strike: num(strike), type, volume: x.volume || 0, oi: x.open_interest || 0 });
  }
  return { list, underlying: r.result?.[0]?.estimated_delivery_price, at: Date.now() };
}

export const sourceKey = d => `${d.source}:${d.sym}`;
export const sourceLabel = d => d.note ? `${d.note} · ${ADAPTERS[d.source].label}` : ADAPTERS[d.source].label;
