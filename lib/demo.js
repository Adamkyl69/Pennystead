// Generates a realistic fake dataset (a Helsinki-flavoured household) so every feature can be tried without a bank.
const fs = require('fs');
const { paths, saveConfig, DEFAULTS } = require('./config');
const J = require('./journal');
const store = require('./store');

// Everything the user's own data lives in. Credentials (secrets, auth, bank session, Google token) are deliberately not listed.
const DATA_KEYS = ['main', 'bank', 'manual', 'holdings', 'prices', 'budget', 'config', 'imports', 'importProfiles', 'txs', 'overrides', 'manualAssets', 'valuations', 'accounts', 'demoFlag'];

/** True when there is nothing a user would miss: no transactions, accounts, manual assets or imports. */
function isEmpty() {
  const nonEmpty = (f, test) => { try { return test(JSON.parse(fs.readFileSync(f, 'utf8'))); } catch { return false; } };
  return !nonEmpty(paths.txs, (o) => Object.keys(o).length) && !nonEmpty(paths.accounts, (o) => Object.keys(o).length) && !nonEmpty(paths.manualAssets, (o) => (o.assets || []).length) && !nonEmpty(paths.imports, (a) => a.length);
}
const isDemo = () => fs.existsSync(paths.demoFlag);
function clear() { for (const k of DATA_KEYS) fs.rmSync(paths[k], { force: true }); }

function generate() {
  clear();
  let seed = 42;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const between = (a, b) => a + rnd() * (b - a);
  const iso = (d) => d.toISOString().slice(0, 10);
  const today = new Date();
  const txs = [];
  let n = 0;
  const add = (date, amount, name, rem) => {
    if (date > today) return;
    txs.push({
      entry_reference: 'demo' + n++, booking_date: iso(date), status: 'BOOK',
      transaction_amount: { amount: Math.abs(amount).toFixed(2), currency: 'EUR' },
      credit_debit_indicator: amount < 0 ? 'DBIT' : 'CRDT',
      ...(amount < 0 ? { creditor: { name } } : { debtor: { name } }), remittance_information: rem ? [rem] : [],
    });
  };
  const day = (y, m, d) => new Date(Date.UTC(y, m, d));
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 12, 1));

  for (let i = 0; i <= 12; i++) {
    const y = start.getUTCFullYear(), m = start.getUTCMonth() + i;
    const recent = i >= 11; // last two months: Netflix price hike
    add(day(y, m, 1), 3400, 'ACME OY', 'Salary');
    add(day(y, m, 2), -1150, 'Helsinki Housing Ltd', 'Rent');
    add(day(y, m, 5), -(between(58, 74)), 'Helen Energy', 'Electricity');
    add(day(y, m, 6), -29.9, 'CITY GYM CLUBHOUSE');
    add(day(y, m, 8), -10.99, 'SPOTIFY');
    add(day(y, m, 12), -(recent ? 15.49 : 12.99), 'NETFLIX.COM');
    add(day(y, m, 15), -8.99, 'DISNEY PLUS');
    add(day(y, m, 17), -2.99, 'APPLE ICLOUD');
    add(day(y, m, 20), -(between(24, 28)), 'Telia Mobile');
    if (i % 12 === 3) add(day(y, m, 9), -89, 'AMAZON PRIME');
    for (let d = 1; d <= 28; d++) {
      if (rnd() < 0.35) add(day(y, m, d), -between(12, 85), rnd() < 0.5 ? 'LIDL HELSINKI' : 'S-MARKET KAMPPI');
      if (rnd() < 0.2) add(day(y, m, d), -between(6, 42), rnd() < 0.5 ? 'CAFE ENGEL' : 'RAVINTOLA NYLUND restaurant');
      if (rnd() < 0.15) add(day(y, m, d), -between(4, 22), 'HSL TRANSIT');
      if (rnd() < 0.05) add(day(y, m, d), -between(15, 120), 'ZALANDO');
    }
  }
  // planted oddities in the last few weeks
  const ago = (n) => new Date(today.getTime() - n * 864e5);
  add(ago(6), -649, 'MEDIAMARKT HELSINKI', 'TV');
  add(ago(4), -18.4, 'UBER *TRIP');
  add(ago(4), -18.4, 'UBER *TRIP');
  add(ago(3), -420, 'NORDIC DIGITAL SERVICES LTD', 'Online order');
  for (let i = 0; i < 6; i++) add(ago(25 - i * 3), -between(40, 90), 'RAVINTOLA NYLUND restaurant'); // dining spike

  J.ensureFiles();
  const { net, first } = J.ingest('demo-acct', 'assets:bank:checking', txs);
  store.saveAccounts({ 'demo-acct': { name: 'checking', label: 'Everyday account', currency: 'EUR', lastSync: iso(today), opening: { date: iso(new Date(Date.parse(first) - 864e5)), amount: 4200 - net, cur: 'EUR' } } });

  saveConfig({
    ...DEFAULTS, base: 'EUR',
    budgets: { 'expenses:food:groceries': 450, 'expenses:food:restaurants': 150, 'expenses:food:coffee-snacks': 60, 'expenses:transport': 70, 'expenses:shopping': { amount: 1500, period: 'year' }, 'expenses:subscriptions': 90 },
    holdings: [
      { symbol: 'AAPL', qty: 12, cost: 2100, currency: 'USD', since: '2025-03-01' },
      { symbol: 'MSFT', qty: 5, cost: 1900, currency: 'USD', since: '2025-06-01' },
    ],
    cash: [{ currency: 'USD', amount: 1500 }],
  });
  const mAgo = (n, d = 1) => iso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - n, d)));
  const series = (vals, step = 3, last = 0) => vals.map((v, i) => ({ date: mAgo(last + (vals.length - 1 - i) * step), value: v }));
  fs.writeFileSync(paths.manualAssets, JSON.stringify({ assets: [
    { id: 'flat-helsinki', name: 'Flat, Helsinki', type: 'property', kind: 'asset', currency: 'EUR', cost: 320000, acquired: mAgo(16), valuations: series([320000, 326000, 331000, 336000, 341000, 344500], 3, 1) },
    { id: 'mortgage', name: 'Mortgage', type: 'loan', kind: 'liability', currency: 'EUR', valuations: series([262000, 259800, 257600, 255400, 253200, 251000, 248800], 2, 0) },
    { id: 'car', name: 'Car (Skoda Octavia)', type: 'vehicle', kind: 'asset', currency: 'EUR', cost: 24000, acquired: mAgo(14), valuations: series([22100, 20400, 18900, 17600], 4, 2) },
    { id: 'pension', name: 'Private pension', type: 'pension', kind: 'asset', currency: 'EUR', valuations: series([41000, 42800, 44100, 45900, 47200], 3, 1) },
    { id: 'btc-wallet', name: 'Bitcoin wallet', type: 'crypto', kind: 'asset', currency: 'EUR', cost: 3000, acquired: mAgo(11), valuations: series([3000, 4100, 5200], 4, 4) },
  ] }, null, 2));
  J.writeDerived();
  J.rebuildBank();
  fs.writeFileSync(paths.prices, `P ${iso(today)} AAPL 231.40 USD\nP ${iso(today)} MSFT 468.10 USD\nP ${iso(today)} USD 0.86 EUR\n`);
  fs.writeFileSync(paths.demoFlag, new Date().toISOString());
  return { transactions: txs.length };
}

module.exports = { generate, clear, isEmpty, isDemo };
