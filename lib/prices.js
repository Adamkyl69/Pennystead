// Fetch stock quotes and FX rates from Alpha Vantage into prices.journal (hledger P directives).
const fs = require('fs');
const { paths, loadConfig, writeAtomic } = require('./config');
const settings = require('./settings');
const manual = require('./manual');
const investments = require('./investments');

const AV = 'https://www.alphavantage.co/query';
const q = (c) => (/^[A-Za-z_]+$/.test(c) ? c : `"${c}"`);

async function av(params) {
  const key = settings.alphaVantage();
  if (!key) throw new Error('Add a free Alpha Vantage API key under Settings → Connections to fetch prices.');
  const r = await (await fetch(`${AV}?${new URLSearchParams({ ...params, apikey: key })}`)).json();
  if (r.Note || r.Information) throw new Error(r.Note || r.Information);
  return r;
}

async function updatePrices() {
  const cfg = loadConfig();
  const lines = new Map();
  if (fs.existsSync(paths.prices))
    for (const l of fs.readFileSync(paths.prices, 'utf8').split('\n')) {
      const m = l.match(/^P (\S+) (\S+) /);
      if (m) lines.set(`${m[1]} ${m[2]}`, l);
    }
  const got = [], errors = [];
  const set = (date, sym, price, cur) => { lines.set(`${date} ${q(sym)}`, `P ${date} ${q(sym)} ${price} ${q(cur)}`); got.push(`${sym}=${price} ${cur}`); };

  const held = investments.list().items.filter((i) => i.qty > 0).map((i) => ({ symbol: i.symbol, currency: i.currency }));
  const mine = new Set(held.map((h) => h.symbol));
  for (const h of [...cfg.holdings.filter((x) => !mine.has(x.symbol)), ...held]) {
    try {
      const g = (await av({ function: 'GLOBAL_QUOTE', symbol: h.av || h.symbol }))['Global Quote'] || {};
      if (!g['05. price']) throw new Error('no quote');
      set(g['07. latest trading day'], h.symbol, parseFloat(g['05. price']), h.currency || 'USD');
    } catch (e) { errors.push(`${h.symbol}: ${e.message}`); }
  }
  // Bank and imported accounts count too: an account in another currency than the main one needs that rate.
  const acctCur = [...Object.values(require('./store').accounts()).map((a) => a.currency), ...Object.values(require('./store').txs()).map((t) => t.cur)].filter((c) => /^[A-Z]{3}$/.test(c || ''));
  const currencies = new Set([...cfg.holdings.map((h) => h.currency || 'USD'), ...cfg.cash.map((c) => c.currency), ...manual.currencies(), ...investments.currencies(), ...acctCur]);
  currencies.delete(cfg.base);
  if (!cfg.base) currencies.clear(); // no main currency yet: nothing to convert into
  for (const c of currencies) {
    try {
      const r = (await av({ function: 'CURRENCY_EXCHANGE_RATE', from_currency: c, to_currency: cfg.base }))['Realtime Currency Exchange Rate'] || {};
      if (!r['5. Exchange Rate']) throw new Error('no rate');
      set(r['6. Last Refreshed'].slice(0, 10), c, parseFloat(r['5. Exchange Rate']), cfg.base);
    } catch (e) { errors.push(`${c}/${cfg.base}: ${e.message}`); }
  }
  writeAtomic(paths.prices, [...lines.values()].sort().join('\n') + '\n');
  return { updated: got, errors };
}

module.exports = { updatePrices };
