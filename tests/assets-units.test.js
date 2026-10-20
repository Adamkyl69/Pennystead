// Internal transfers, the Review account filter, assets held in units, investment imports and the asset history.
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, saveConfig } = require('../lib/config');
const store = require('../lib/store');
const core = require('../lib/core');
const manual = require('../lib/manual');
const importer = require('../lib/importer');
const inv = require('../lib/invimport');
const A = require('../lib/analysis');
const J = require('../lib/journal');
const { today } = require('../lib/dates');

const day = (n) => new Date(Date.parse(today()) - n * 864e5).toISOString().slice(0, 10);
test.before(() => {
  const c = loadConfig(); c.base = 'EUR'; c.baseConfirmed = true; saveConfig(c);
  store.saveAccounts({ 'import-main': { name: 'main', label: 'Main account', currency: 'EUR', imported: true, opening: { date: day(40), amount: 1000, cur: 'EUR' } }, 'import-save': { name: 'savings', label: 'Savings', currency: 'EUR', imported: true, opening: { date: day(40), amount: 0, cur: 'EUR' } } });
  const tx = (acct, n, amount, desc) => ({ acct: 'assets:bank:' + acct, date: day(n), amount, cur: 'EUR', desc, text: desc });
  store.saveTxs({ t1: tx('main', 20, 2500, 'Salary ACME'), t2: tx('main', 15, -500, 'Own transfer'), t3: tx('savings', 14, 500, 'From main account'), t4: tx('main', 10, -60, 'Corner shop'), t5: tx('savings', 5, -12, 'Bookstore') });
  J.rebuildBank();
});

test('internal transfers: suggested in Review, then left out of spending, income and budgets', async () => {
  let r = await core.review();
  assert.equal(r.transfers.length, 1, 'the -500 / +500 pair a day apart is found');
  const p = r.transfers[0];
  assert.deepEqual([p.from.id, p.to.id], ['t2', 't3']);
  const before = A.monthly(await core.transactions(), 2).reduce((s, m) => s + m.spend, 0);
  core.setOverrides([p.from.id, p.to.id], 'transfers:internal');
  const txs = await core.transactions();
  assert.ok(txs.some((t) => t.category === 'transfers:internal'), 'still listed with your transactions');
  const m = A.monthly(txs, 2);
  assert.equal(r2(m.reduce((s, x) => s + x.spend, 0)), r2(before - 500), 'the 500 is no longer spending');
  assert.equal(r2(m.reduce((s, x) => s + x.income, 0)), 2500, 'nor income');
  const sp = A.spendingReport(txs, { today: today() });
  assert.ok(!Object.values(sp.tables).some((t) => t.rows.some((x) => x.key.startsWith('transfers'))));
  assert.equal((await core.review()).transfers.length, 0, 'not suggested again');
  const cats = await core.categories();
  assert.equal(cats.find((c) => c.account === 'transfers:internal').kind, 'transfer');
  assert.throws(() => core.setBudget('transfers:internal', 100), /no budget/);
  core.addCategory('transfers:to-savings');
  assert.ok((await core.categories()).some((c) => c.account === 'transfers:to-savings'));
});
const r2 = (n) => Math.round(n * 100) / 100;

test('Review for one bank account only', async () => {
  const all = await core.review(), one = await core.review({ account: 'assets:bank:savings' });
  assert.deepEqual(all.accounts.map((a) => a.label), ['Main account', 'Savings']);
  assert.equal(one.account, 'assets:bank:savings');
  assert.ok(one.merchants.length < all.merchants.length);
  assert.deepEqual(one.merchants.map((m) => m.name), ['Bookstore']);
  assert.equal((await core.review({ account: 'assets:bank:nope' })).account, null, 'an unknown account shows everything');
});

test('an asset in units: value is units × price, a price update keeps the units, history is kept', async () => {
  const a = manual.create({ name: 'Gold coins', type: 'commodity', currency: 'EUR', units: 10, unit: 'coins', price: 180, date: day(30) });
  assert.equal(a.perUnit, true);
  manual.record(a.id, { date: day(10), price: 200 });
  manual.record(a.id, { date: day(2), units: 12, price: 210 });
  const vs = manual.load().assets.find((x) => x.id === a.id).valuations;
  assert.deepEqual(vs.map((v) => [v.units, v.price, v.value]), [[10, 180, 1800], [10, 200, 2000], [12, 210, 2520]]);
  J.writeDerived();
  const w = await core.wealth(), s = w.manual.find((x) => x.id === a.id);
  assert.equal(s.valueBase, 2520); assert.equal(s.units, 12); assert.equal(s.price, 210);
  assert.equal(r2(s.priceChange.pct), 5);
  // Net worth on earlier dates uses what you held then, at the price then.
  const h = await core.assetsHistory('3M'), it = h.items.find((x) => x.id === a.id);
  assert.deepEqual([...new Set(it.values.filter(Boolean))], [1800, 2000, 2520]);
  assert.throws(() => manual.record(a.id, { date: day(1) }), /price of one unit/);
  manual.remove(a.id);
});

test('investments import: new ones are added, later files add to the history, price lists keep the units, undo', async () => {
  const csv = (rows) => Buffer.from('Security;Ticker;Quantity;Price;Date\n' + rows.join('\n') + '\n');
  let u = importer.upload(csv([`Index Fund;IDX;100;10,00;${day(20)}`, `Tech Co;TCO;5;50,00;${day(20)}`]), 'broker.csv');
  const d = inv.describe(u.importId);
  assert.deepEqual([d.mapping.name, d.mapping.symbol, d.mapping.units, d.mapping.price, d.mapping.date], [0, 1, 2, 3, 4]);
  let p = inv.preview(u.importId, d.mapping, { currency: 'EUR' });
  assert.deepEqual(p.rows.map((r) => r.status), ['new', 'new']);
  const first = inv.commit(u.importId, d.mapping, { currency: 'EUR' });
  assert.equal(first.added, 2);
  // Same file again: nothing new.
  u = importer.upload(csv([`Index Fund;IDX;100;10,00;${day(20)}`]), 'broker.csv');
  assert.equal(inv.preview(u.importId, d.mapping, { currency: 'EUR' }).rows[0].status, 'same');
  assert.throws(() => inv.commit(u.importId, d.mapping, { currency: 'EUR' }), /Nothing new/);
  // A month later: more units of one, a new one; the old values stay.
  u = importer.upload(csv([`Index Fund;IDX;120;11,00;${day(5)}`, `New ETF;NEW;3;30,00;${day(5)}`]), 'broker2.csv');
  p = inv.preview(u.importId, d.mapping, { currency: 'EUR' });
  assert.deepEqual(p.rows.map((r) => [r.status, r.previous?.value ?? null]), [['update', 1000], ['new', null]]);
  assert.deepEqual(p.missing, ['Tech Co'], 'holdings not in the file are listed and kept');
  const second = inv.commit(u.importId, d.mapping, { currency: 'EUR' });
  const idx = manual.load().assets.find((a) => a.symbol === 'IDX');
  assert.deepEqual(idx.valuations.map((v) => [v.date, v.units, v.price]), [[day(20), 100, 10], [day(5), 120, 11]]);
  // A price list without units: the units you hold stay.
  const prices = Buffer.from(`Ticker,Price\nIDX,12.5\n`);
  u = importer.upload(prices, 'prices.csv');
  const pm = inv.describe(u.importId).mapping;
  p = inv.preview(u.importId, pm, { currency: 'EUR', date: day(1) });
  assert.deepEqual([p.rows[0].status, p.rows[0].units, p.rows[0].value], ['update', 120, 1500]);
  // A new investment needs units.
  u = importer.upload(Buffer.from('Ticker,Price\nZZZ,1\n'), 'x.csv');
  assert.match(inv.preview(u.importId, inv.describe(u.importId).mapping, { currency: 'EUR' }).errors[0].error, /units/);
  // Undo the second import: the new ETF goes, the Index Fund is back to one value.
  inv.undo(second.batch);
  assert.equal(manual.load().assets.some((a) => a.symbol === 'NEW'), false);
  assert.equal(manual.load().assets.find((a) => a.symbol === 'IDX').valuations.length, 1);
  assert.throws(() => inv.undo(second.batch), /already undone/);
  assert.equal(inv.history()[0].undoneAt != null, true);
  J.writeDerived();
  const h = await core.assetsHistory('All');
  assert.ok(h.groups.some((g) => g.name === 'Investments' && g.values[g.values.length - 1] === 1250), JSON.stringify(h.groups));
  assert.ok(first.batch);
});
