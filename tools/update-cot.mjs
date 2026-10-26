// Builds data/cot.json from the CFTC legacy futures-only COT files (public domain, weekly).
// The CFTC API does not allow browser requests, so the site reads this pre-built file instead.
// Run: node tools/update-cot.mjs   (a GitHub Action runs it every Saturday)
import { inflateRawSync } from 'node:zlib';
import { writeFile, mkdir } from 'node:fs/promises';
import { SYMBOLS } from '../js/symbols.js';

const WEEKS = 170;
const codes = new Map(SYMBOLS.filter(s => s.cot).map(s => [s.cot.code, s.id]));

// Extract the first file of a zip archive (CFTC zips hold one text file).
function unzipFirst(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('Not a zip file');
  const cd = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error('Bad central directory');
  const method = buf.readUInt16LE(cd + 10), size = buf.readUInt32LE(cd + 20), local = buf.readUInt32LE(cd + 42);
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const data = buf.subarray(start, start + size);
  return method === 8 ? inflateRawSync(data) : data;
}

function parseCsvLine(line) {
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

async function year(y) {
  const res = await fetch(`https://www.cftc.gov/files/dea/history/deacot${y}.zip`);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`CFTC ${y}: HTTP ${res.status}`);
  const text = unzipFirst(Buffer.from(await res.arrayBuffer())).toString('latin1');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const head = parseCsvLine(lines[0]);
  const col = name => {
    const i = head.findIndex(h => h.toLowerCase() === name.toLowerCase());
    if (i < 0) throw new Error(`Column not found: ${name}`);
    return i;
  };
  const c = {
    name: col('Market and Exchange Names'), date: col('As of Date in Form YYYY-MM-DD'), code: col('CFTC Contract Market Code'),
    nl: col('Noncommercial Positions-Long (All)'), ns: col('Noncommercial Positions-Short (All)'),
    cl: col('Commercial Positions-Long (All)'), cs: col('Commercial Positions-Short (All)'),
  };
  return lines.slice(1).map(parseCsvLine).filter(r => codes.has(r[c.code])).map(r => ({
    code: r[c.code], market: r[c.name], date: r[c.date],
    spec: +r[c.nl] - +r[c.ns], comm: +r[c.cl] - +r[c.cs],
  }));
}

const now = new Date().getUTCFullYear();
const rows = (await Promise.all([now, now - 1, now - 2, now - 3].map(year))).flat();
const markets = {};
for (const r of rows.sort((a, b) => a.date.localeCompare(b.date))) {
  const m = markets[r.code] ||= { symbol: codes.get(r.code), market: r.market, rows: [] };
  if (!m.rows.some(x => x.date === r.date)) m.rows.push({ date: r.date, spec: r.spec, comm: r.comm });
}
for (const m of Object.values(markets)) m.rows = m.rows.slice(-WEEKS);

const missing = [...codes].filter(([code]) => !markets[code]).map(([code, id]) => `${id} (${code})`);
await mkdir(new URL('../data/', import.meta.url), { recursive: true });
await writeFile(new URL('../data/cot.json', import.meta.url), JSON.stringify({
  generatedAt: new Date().toISOString(),
  source: 'CFTC Commitments of Traders, legacy futures-only report',
  markets,
}));
for (const [code, m] of Object.entries(markets)) console.log(`${m.symbol.padEnd(8)} ${code}  ${m.rows.length} weeks  last ${m.rows.at(-1).date}  ${m.market}`);
if (missing.length) { console.error(`Missing markets: ${missing.join(', ')}`); process.exitCode = 1; }
