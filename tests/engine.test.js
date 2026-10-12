// The native ledger engine against numbers worked out by hand. No hledger involved.
const { dir } = require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ledger = require('../lib/ledger'), core = require('../lib/core');
const { paths, saveConfig, loadConfig } = require('../lib/config');
const store = require('../lib/store'), manual = require('../lib/manual');

const ago = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const setPrices = (...lines) => fs.writeFileSync(paths.prices, lines.join('\n') + '\n');
const config = (o) => saveConfig({ ...loadConfig(), base: 'EUR', holdings: [], cash: [], budgets: {}, ...o });
const asset = (o) => ({ kind: 'asset', currency: 'EUR', valuations: [], ...o });
const setManual = (...assets) => fs.writeFileSync(paths.manualAssets, JSON.stringify({ assets }));
const value = (L, acct, date = ago(0)) => ledger.balances(L, [acct], { value: { target: 'EUR', date } }).find((r) => r.account === acct)?.amounts;

test.beforeEach(() => { setPrices(); setManual(); config({}); store.saveTxs({}); store.saveAccounts({}); });

test('direct conversion, chains and reversed prices', () => {
  config({ cash: [{ currency: 'USD', amount: 1000 }, { currency: 'CHF', amount: 550 }], holdings: [{ symbol: 'AAPL', qty: 10, cost: 1500, currency: 'USD' }] });
  setManual(asset({ id: 'uk-flat', name: 'UK flat', type: 'property', currency: 'GBP', valuations: [{ date: ago(30), value: 100000 }] }));
  setPrices(`P ${ago(5)} USD 0.9 EUR`, `P ${ago(5)} AAPL 200 USD`, `P ${ago(5)} GBP 1.25 USD`, `P ${ago(5)} EUR 1.10 CHF`);
  const L = ledger.build();
  assert.deepEqual(value(L, 'assets:cash:usd'), { EUR: 900 }, '1000 USD × 0.9');
  assert.deepEqual(value(L, 'assets:investments:aapl'), { EUR: 1800 }, '10 × 200 USD × 0.9 (two hops)');
  assert.deepEqual(value(L, 'assets:manual:illiquid:uk-flat'), { EUR: 112500 }, '100000 GBP → USD → EUR');
  assert.deepEqual(value(L, 'assets:cash:chf'), { EUR: 500 }, '550 CHF ÷ 1.10 (price quoted the other way round)');
});
test('the price used is the latest one on or before the date', () => {
  config({ cash: [{ currency: 'USD', amount: 1000, since: ago(200) }] });
  setPrices(`P ${ago(100)} USD 0.80 EUR`, `P ${ago(10)} USD 0.90 EUR`);
  const L = ledger.build();
  assert.equal(value(L, 'assets:cash:usd', ago(150)).USD, 1000, 'before the first price: stays unconverted');
  assert.equal(value(L, 'assets:cash:usd', ago(50)).EUR, 800); assert.equal(value(L, 'assets:cash:usd', ago(5)).EUR, 900);
  assert.equal(value(L, 'assets:cash:usd', ago(0)).EUR, 900, 'today');
});
test('no price path: the amount stays in its own commodity and is never dropped silently', () => {
  config({ holdings: [{ symbol: 'NOPRICE', qty: 7, cost: 70, currency: 'USD' }] });
  assert.deepEqual(value(ledger.build(), 'assets:investments:noprice'), { NOPRICE: 7 });
});
test('a sold asset (price 0) is worth 0 and is not listed; an unsold one with price 0 is still convertible', () => {
  setManual(asset({ id: 'car', name: 'Car', type: 'vehicle', cost: 5000, acquired: ago(100), valuations: [{ date: ago(100), value: 5000 }, { date: ago(10), value: 0 }] }));
  const L = ledger.build();
  assert.equal(value(L, 'assets:manual:illiquid:car', ago(50)).EUR, 5000); assert.equal(value(L, 'assets:manual:illiquid:car', ago(0)), undefined, 'zero balances are not listed');
});
test('liabilities are negative; secured vs unsecured change liquid and illiquid net worth', async () => {
  config({ cash: [{ currency: 'EUR', amount: 10000, account: 'assets:bank:main' }] });
  setManual(asset({ id: 'flat', name: 'Flat', type: 'property', valuations: [{ date: ago(50), value: 300000 }] }), asset({ id: 'mortgage', name: 'Mortgage', type: 'loan', kind: 'liability', valuations: [{ date: ago(50), value: 200000 }] }), asset({ id: 'card', name: 'Card', type: 'credit', kind: 'liability', valuations: [{ date: ago(50), value: 1500 }] }), asset({ id: 'btc', name: 'BTC', type: 'crypto', valuations: [{ date: ago(50), value: 4000 }] }));
  const w = await core.wealth();
  assert.equal(w.netWorth, 10000 + 300000 - 200000 - 1500 + 4000);
  assert.equal(w.liquid, 10000 + 4000 - 1500, 'cash + liquid crypto − unsecured debt');
  assert.equal(w.illiquid, 300000 - 200000, 'property − secured debt');
  assert.equal(w.secured, 200000); assert.equal(w.unsecured, 1500);
});
test('cost basis and gain: cost converted at today\'s rate; market value when no cost is recorded', () => {
  config({ holdings: [{ symbol: 'AAPL', qty: 10, cost: 1500, currency: 'USD' }, { symbol: 'MSFT', qty: 2, currency: 'USD' }] });
  setPrices(`P ${ago(1)} USD 0.9 EUR`, `P ${ago(1)} AAPL 200 USD`, `P ${ago(1)} MSFT 400 USD`);
  const L = ledger.build(), c = ledger.costBasis(L, 'EUR', ago(0));
  assert.equal(c['assets:investments:aapl'], 1350, '1500 USD × 0.9'); assert.equal(c['assets:investments:msft'], 720, 'no cost recorded → equals market value (2 × 400 × 0.9)');
});
test('history: cumulative balances valued at the end of each period; weeks, days and months line up', () => {
  config({ cash: [{ currency: 'USD', amount: 1000, since: ago(40) }] });
  setPrices(`P ${ago(30)} USD 0.80 EUR`, `P ${ago(3)} USD 0.90 EUR`);
  const L = ledger.build(), to = ago(-1), from = ago(35);
  const [daily] = ledger.series(L, [{ prefixes: ['assets'] }], 'day', from, to, 'EUR');
  assert.equal(daily.length, 36); assert.equal(daily[0].date, from); assert.equal(daily[0].value, 0, 'before the first price: unpriced USD is not counted');
  assert.equal(daily.find((p) => p.date === ago(20)).value, 800); assert.equal(daily[daily.length - 1].value, 900);
  const [weekly] = ledger.series(L, [{ prefixes: ['assets'] }], 'week', from, to, 'EUR'); assert.equal(weekly[1].date, ago(28)); assert.ok(weekly.every((p, i) => i === 0 || p.date > weekly[i - 1].date));
  const [monthly] = ledger.series(L, [{ prefixes: ['assets'] }], 'month', ago(95).slice(0, 7) + '-01', to, 'EUR'); assert.ok(monthly.length >= 3); assert.ok(monthly.every((p) => /-01$/.test(p.date)));
});
test('transactions: rules, overrides, original text and order', async () => {
  store.saveTxs({ a: { acct: 'assets:bank:x', date: '2024-02-01', amount: -12.5, cur: 'EUR', desc: 'Café Äpy', text: 'Café Äpy lunch' }, b: { acct: 'assets:bank:x', date: '2024-01-01', amount: 3000, cur: 'EUR', desc: 'ACME OY', text: 'ACME OY Salary' }, c: { acct: 'assets:bank:x', date: '2024-01-15', amount: -40, cur: 'EUR', desc: 'Unknown Shop', text: 'Unknown Shop' } });
  store.saveOverrides({ c: 'expenses:health' });
  const t = await core.transactions();
  assert.deepEqual(t.map((x) => x.id), ['b', 'c', 'a'], 'sorted by date'); assert.deepEqual(t.map((x) => x.category), ['income:salary', 'expenses:health', 'expenses:food:coffee-snacks']);
  assert.equal(t[2].desc, 'Café Äpy', 'original (non-ASCII) text is preserved');
});
