// Symbol catalog. Each symbol lists its data sources in order of preference; the first one
// that is usable (API key present when required) is the default, and users can override it.
//
// kind: live  = the asset's own real-time price (crypto spot)
//       proxy = a perpetual contract that tracks the asset
//       quote = a spot quote from a data vendor (may be delayed)
//       etf   = an ETF used as a stand-in for an index or a commodity
//       eod   = end-of-day reference rate
// hours:   when the underlying market trades (see hours.js).
// cot:     CFTC contract market code for the COT index; invert when the futures contract is
//          quoted against the USD the other way round (JPY futures vs USDJPY).
// history: a long-history source used for the seasonal index when the main source is too new.

const src = (source, sym, kind, extra = {}) => ({ source, sym, kind, ...extra });
const binance = s => src('binance', s, 'live');
const binancePerp = s => src('binanceFut', s, 'proxy');
const hl = (s, note) => src('hyperliquid', s, 'proxy', note ? { note } : {});
const bybitSpot = s => src('bybitSpot', s, 'live');
const bybitPerp = s => src('bybitPerp', s, 'proxy');
const okxSpot = s => src('okxSpot', s, 'live');
const okxPerp = s => src('okxSwap', s, 'proxy');
const coinbase = s => src('coinbase', s, 'live');
const kraken = (s, key) => src('kraken', s, 'live', { key });
const td = s => src('twelvedata', s, 'quote');
const tdEtf = s => src('twelvedata', s, 'etf', { note: `${s} ETF` });
const ecb = s => src('ecb', s, 'eod');

export const ASSET_GROUPS = ['Forex', 'Crypto', 'Commodities', 'Indices', 'Stocks'];

const fx = (id, name, dp, sources, cot) => ({ id, name, group: 'Forex', hours: 'fx', dp, sources, cot, history: ecb(id) });

export const SYMBOLS = [
  fx('EURUSD', 'Euro / US dollar', 5, [hl('xyz:EUR'), bybitPerp('EURUSDUSDT'), td('EUR/USD'), ecb('EURUSD')], { code: '099741' }),
  fx('GBPUSD', 'British pound / US dollar', 5, [bybitPerp('GBPUSDUSDT'), hl('xyz:GBP'), td('GBP/USD'), ecb('GBPUSD')], { code: '096742' }),
  fx('USDJPY', 'US dollar / Japanese yen', 3, [hl('xyz:JPY'), td('USD/JPY'), ecb('USDJPY')], { code: '097741', invert: true }),
  fx('USDCHF', 'US dollar / Swiss franc', 5, [td('USD/CHF'), ecb('USDCHF')], { code: '092741', invert: true }),
  fx('AUDUSD', 'Australian dollar / US dollar', 5, [td('AUD/USD'), ecb('AUDUSD')], { code: '232741' }),
  fx('USDCAD', 'US dollar / Canadian dollar', 5, [td('USD/CAD'), ecb('USDCAD')], { code: '090741', invert: true }),
  fx('NZDUSD', 'New Zealand dollar / US dollar', 5, [td('NZD/USD'), ecb('NZDUSD')], { code: '112741' }),
  fx('EURJPY', 'Euro / Japanese yen', 3, [td('EUR/JPY'), ecb('EURJPY')]),
  fx('GBPJPY', 'British pound / Japanese yen', 3, [td('GBP/JPY'), ecb('GBPJPY')]),
  fx('EURGBP', 'Euro / British pound', 5, [td('EUR/GBP'), ecb('EURGBP')]),
  fx('DXY', 'US Dollar Index', 2, [ecb('DXY')], { code: '098662' }),

  { id: 'BTCUSD', name: 'Bitcoin', group: 'Crypto', hours: 'crypto', dp: 1, cot: { code: '133741' }, history: binance('BTCUSDT'),
    sources: [binance('BTCUSDT'), okxSpot('BTC-USDT'), bybitSpot('BTCUSDT'), coinbase('BTC-USD'), kraken('XBTUSD', 'XXBTZUSD')] },
  { id: 'ETHUSD', name: 'Ethereum', group: 'Crypto', hours: 'crypto', dp: 2, cot: { code: '146021' }, history: binance('ETHUSDT'),
    sources: [binance('ETHUSDT'), okxSpot('ETH-USDT'), bybitSpot('ETHUSDT'), coinbase('ETH-USD'), kraken('ETHUSD', 'XETHZUSD')] },

  { id: 'XAUUSD', name: 'Gold', group: 'Commodities', hours: 'futures', dp: 2, cot: { code: '088691' }, history: td('XAU/USD'),
    sources: [binancePerp('XAUUSDT'), hl('xyz:GOLD'), okxPerp('XAU-USDT-SWAP'), bybitPerp('XAUUSDT'), td('XAU/USD')] },
  { id: 'XAGUSD', name: 'Silver', group: 'Commodities', hours: 'futures', dp: 3, cot: { code: '084691' }, history: td('XAG/USD'),
    sources: [binancePerp('XAGUSDT'), hl('xyz:SILVER'), okxPerp('XAG-USDT-SWAP'), bybitPerp('XAGUSDT'), td('XAG/USD')] },
  { id: 'COPPER', name: 'Copper', group: 'Commodities', hours: 'futures', dp: 4, cot: { code: '085692' }, history: tdEtf('CPER'),
    sources: [binancePerp('COPPERUSDT'), hl('xyz:COPPER')] },
  { id: 'WTI', name: 'WTI crude oil', group: 'Commodities', hours: 'futures', dp: 2, cot: { code: '067651' }, history: td('WTI/USD'),
    sources: [hl('xyz:CL'), binancePerp('CLUSDT'), td('WTI/USD')] },
  { id: 'BRENT', name: 'Brent crude oil', group: 'Commodities', hours: 'futures', dp: 2, history: td('XBR/USD'),
    sources: [hl('xyz:BRENTOIL'), td('XBR/USD')] },
  { id: 'WHEAT', name: 'Wheat', group: 'Commodities', hours: 'us_equity', dp: 2, cot: { code: '001602' }, history: tdEtf('WEAT'), sources: [tdEtf('WEAT')] },
  { id: 'CORN', name: 'Corn', group: 'Commodities', hours: 'us_equity', dp: 2, cot: { code: '002602' }, history: tdEtf('CORN'), sources: [tdEtf('CORN')] },
  { id: 'SOYBEAN', name: 'Soybeans', group: 'Commodities', hours: 'us_equity', dp: 2, cot: { code: '005602' }, history: tdEtf('SOYB'), sources: [tdEtf('SOYB')] },

  { id: 'SPX', name: 'S&P 500', group: 'Indices', hours: 'futures', dp: 1, cot: { code: '13874A' }, history: tdEtf('SPY'), sources: [hl('xyz:SP500')] },
  { id: 'NDX', name: 'Nasdaq 100', group: 'Indices', hours: 'futures', dp: 1, cot: { code: '209742' }, history: tdEtf('QQQ'), sources: [hl('xyz:XYZ100')] },
  { id: 'DJI', name: 'Dow Jones 30', group: 'Indices', hours: 'us_equity', dp: 2, cot: { code: '124603' }, history: tdEtf('DIA'), sources: [tdEtf('DIA')] },
  { id: 'RUT', name: 'Russell 2000', group: 'Indices', hours: 'us_equity', dp: 2, cot: { code: '239742' }, history: tdEtf('IWM'), sources: [tdEtf('IWM')] },
  { id: 'SOX', name: 'Semiconductors', group: 'Indices', hours: 'us_equity', dp: 2, history: tdEtf('SOXX'), sources: [hl('xyz:SMH', 'SMH ETF perp'), tdEtf('SOXX')] },

  ...[['NVDA', 'Nvidia'], ['AAPL', 'Apple'], ['MSFT', 'Microsoft'], ['GOOGL', 'Alphabet'], ['AMZN', 'Amazon'], ['META', 'Meta Platforms'], ['AVGO', 'Broadcom']]
    .map(([t, name]) => ({
      id: t, name, group: 'Stocks', hours: 'us_equity', dp: 2, history: td(t),
      sources: [binancePerp(`${t}USDT`), hl(`xyz:${t}`), okxPerp(`${t}-USDT-SWAP`), bybitPerp(`${t}USDT`), td(t)],
    })),
];

export const SYMBOL_BY_ID = Object.fromEntries(SYMBOLS.map(s => [s.id, s]));
