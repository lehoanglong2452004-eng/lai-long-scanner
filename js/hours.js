// Regular trading sessions of the underlying markets, in New York time.
// Exchange holidays are not modelled.

const nyFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function newYork(d) {
  const p = Object.fromEntries(nyFormat.formatToParts(d).map(x => [x.type, x.value]));
  return { wd: WEEKDAY[p.weekday], mins: (+p.hour % 24) * 60 + +p.minute };
}

export const HOURS_LABEL = {
  crypto: 'Trades 24/7',
  fx: 'Sun 17:00 – Fri 17:00 New York time',
  futures: 'Sun 18:00 – Fri 17:00 New York time, daily break 17:00–18:00',
  us_equity: 'Mon–Fri 09:30–16:00 New York time',
};

export function isMarketOpen(kind, d = new Date()) {
  if (kind === 'crypto') return true;
  const { wd, mins } = newYork(d);
  if (kind === 'us_equity') return wd >= 1 && wd <= 5 && mins >= 570 && mins < 960;
  if (kind === 'fx') {
    if (wd === 6) return false;
    if (wd === 0) return mins >= 1020;
    if (wd === 5) return mins < 1020;
    return true;
  }
  if (kind === 'futures') {
    if (wd === 6) return false;
    if (wd === 0) return mins >= 1080;
    if (wd === 5) return mins < 1020;
    return mins < 1020 || mins >= 1080;
  }
  return true;
}
