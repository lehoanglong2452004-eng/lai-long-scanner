# Lai Long Scanner™

A free, browser-only market scanner for **forex, crypto, commodities, US indices and US tech stocks**.
It groups 31 indicators into one vote per group, shows the result on six timeframes (M5 to W1), and labels every
symbol with where its price comes from and how fresh it is.

**Live site:** https://lehoanglong2452004-eng.github.io/lai-long-scanner/

> For information only. Not financial advice. Signals are mechanical and have not been back-tested for profitability.

## What it shows

| Column | Indicators | Role |
|---|---|---|
| Trend | EMA 20/50/200, SuperTrend, Ichimoku, Hull MA | Vote |
| Strength | ADX / DMI, Choppiness | Filter: a flat ADX turns Total into **Wait** |
| Momentum | RSI 14, MACD, CCI 20 | Vote |
| Volatility | ATR %, Bollinger/Keltner squeeze, Donchian 20 | Context |
| Volume | Volume spike, RVOL, OBV, MFI, CMF, VWAP | Vote |
| Order flow | Delta, CVD, big trades, options volume profile | Vote |
| Structure | Fair value gap, support/resistance, pivot, TWAP, candle pattern, 52-week range, change | Vote |
| Macro | COT index, seasonal index | Context |

Each voting group averages its indicators into one vote (↑, ↓ or →). **Total** averages the group votes, so a group
with many indicators cannot outweigh the others. Votes use the last closed bar by default, so they do not repaint.
Open the **?** button in the app for every indicator's meaning, formula and signal rule.

## Data sources and delays

Every symbol has a badge next to it: **Live**, **Proxy · live**, **Proxy · off-hours**, **Delayed Nm**, **EOD date** or **Needs key**.
The delay is measured from the age of the data, not assumed.

| Source | Used for | Delay | Key |
|---|---|---|---|
| Binance spot | BTC, ETH | Real time | None |
| Binance perpetuals (TradFi) | Gold, silver, copper, WTI, 7 US stocks | Real time, proxy | None |
| Hyperliquid perpetuals | WTI, Brent, S&P 500, Nasdaq 100, SMH, EUR/USD, USD/JPY | Real time, proxy | None |
| Bybit, OKX, Coinbase, Kraken | Alternative sources, switchable per symbol | Real time | None |
| Twelve Data | 7 forex pairs intraday, ETFs for wheat, corn, soybeans, Dow, Russell, SOXX; long history | Refresh cycle, 15 min by default | Free key |
| ECB via Frankfurter | 7 forex pairs and DXY without a key | End of day, close only | None |
| CFTC | COT index (built weekly into `data/cot.json`) | Weekly | None |
| Deribit | BTC and ETH options volume profile | 24h stats, every 5 min | None |

Perpetual contracts and ETFs are **proxies**: they track the asset but are not the underlying market price, and
perpetuals keep trading when the underlying market is closed.

The optional Twelve Data key is stored only in your browser and sent only to `api.twelvedata.com`.

## Run locally

No build step and no dependencies. Node 18 or newer:

```bash
node tools/serve.mjs
```

Then open http://localhost:5173.

```bash
npm test
```

runs the indicator tests, which compare RSI, MACD, ADX and SuperTrend with TradingView Pine definitions.

```bash
node tools/smoke.mjs H1
```

fetches live data for every symbol and runs the signal engine on it.

## COT data

The CFTC API does not accept requests from browsers, so `tools/update-cot.mjs` downloads the public weekly
Commitments of Traders files and writes `data/cot.json`. The GitHub Action in `.github/workflows/update-cot.yml`
runs it every Saturday.

## Project layout

```
index.html            page shell
css/style.css         layout, light and dark themes, phone layout
js/app.js             scheduling, rendering, settings, legend
js/sources.js         data adapters for every provider
js/symbols.js         symbol catalog and source preferences
js/indicators.js      technical analysis library
js/signals.js         indicator catalog, notes, votes and Total
js/hours.js           trading hours of the underlying markets
js/theme.js           colour presets and fonts
tools/                dev server, smoke test, COT builder
tests/                indicator tests
```

## Copyright

© 2026 Lai Long. All rights reserved. “Lai Long”, the Lai Long logo and the Lai Long Scanner name are trademarks of
Lai Long. The software, interface design, signal model and documentation are the intellectual property of Lai Long.
No licence to copy, modify or redistribute is granted unless given in writing. See [LICENSE](LICENSE).

Market data © its respective providers.
