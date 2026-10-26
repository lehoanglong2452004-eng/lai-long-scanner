// Live smoke test: fetches every symbol's default source and runs the signal engine on it.
// Run: node tools/smoke.mjs [TF] [--all-sources]
import { SYMBOLS } from '../js/symbols.js';
import { ADAPTERS, TF, sourceLabel } from '../js/sources.js';
import { evaluate } from '../js/signals.js';

const tf = process.argv.find(a => TF[a]) || 'H1';
const allSources = process.argv.includes('--all-sources');
let failures = 0;

for (const sym of SYMBOLS) {
  const descs = allSources ? sym.sources : [sym.sources.find(d => !ADAPTERS[d.source].needsKey) || sym.sources[0]];
  for (const d of descs) {
    const ad = ADAPTERS[d.source];
    const label = `${sym.id.padEnd(8)} ${sourceLabel(d).padEnd(30)}`;
    if (ad.needsKey) { console.log(label, 'skipped (needs key)'); continue; }
    try {
      const s = await ad.candles(d, tf, {});
      const price = ad.prices ? (await ad.prices([d])).get(d.sym) : s.candles.at(-1).close;
      const trades = ad.trades ? await ad.trades(d) : null;
      const r = evaluate(s, { tf, tfSec: TF[tf].sec, useClosedBar: true, price, trades, tradesSupported: !!ad.trades });
      const na = Object.values(r.ind).filter(x => x.na).map(x => x.na);
      const counts = na.reduce((m, x) => (m[x] = (m[x] || 0) + 1, m), {});
      console.log(label, `bars ${String(s.candles.length).padStart(4)}  price ${String(price).padStart(10)}  total ${(r.total.label || r.total.na).padEnd(11)}`,
        trades ? `big ${trades.buys}B/${trades.sells}S of ${trades.n}` : '', Object.keys(counts).length ? JSON.stringify(counts) : '');
    } catch (e) {
      if (e.na) { console.log(label, `n/a: ${e.na}`); continue; }
      failures++;
      console.log(label, 'FAIL', e.message);
    }
  }
}
console.log(failures ? `\n${failures} failure(s)` : '\nall sources ok');
process.exit(failures ? 1 : 0);
