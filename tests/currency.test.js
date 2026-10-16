require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const store = require('../lib/store'), J = require('../lib/journal'), core = require('../lib/core');
const { paths, loadConfig } = require('../lib/config');

// A bank-synced Turkish lira account, while Pennystead still has its default main currency (EUR).
test.before(() => {
  J.writeDerived();
  store.saveAccounts({ u1: { name: 'vadesiz', label: 'Vadesiz TL', currency: 'TRY', lastSync: '2026-10-16', opening: { date: '2026-09-30', amount: 10000, cur: 'TRY' } } });
  store.saveTxs({ a: { acct: 'assets:bank:vadesiz', date: '2026-10-02', amount: -1500, cur: 'TRY', desc: 'MIGROS', text: 'MIGROS' }, b: { acct: 'assets:bank:vadesiz', date: '2026-10-05', amount: 45000, cur: 'TRY', desc: 'MAAS', text: 'MAAS' } });
  J.rebuildBank();
});

test('a TRY account under an EUR main currency is reported, not silently counted as euros', async () => {
  const c = (await core.state()).currency;
  assert.deepEqual(c, { base: 'EUR', confirmed: false, accounts: ['TRY'], unconverted: { TRY: 2 } });
});

test('choosing TRY as the main currency: confirmed, nothing left unconverted, balance in TRY', async () => {
  core.setBase('try');
  const st = await core.state();
  assert.deepEqual(st.currency, { base: 'TRY', confirmed: true, accounts: ['TRY'], unconverted: {} });
  assert.equal(loadConfig().base, 'TRY');
  const w = await core.wealth();
  assert.equal(w.accounts.find((a) => a.account === 'assets:bank:vadesiz').value, 10000 - 1500 + 45000);
  assert.throws(() => core.setBase('lira'), /3-letter/);
});

test('keeping EUR with an exchange rate converts properly; keeping it without one stays flagged', async () => {
  core.setBase('EUR');
  fs.writeFileSync(paths.prices, 'P 2026-10-01 TRY 0.025 EUR\n');
  const t = (await core.transactions()).find((x) => x.desc === 'MIGROS');
  assert.equal(t.value, -37.5); assert.ok(!t.unconverted);
  assert.deepEqual((await core.state()).currency.unconverted, {});
  fs.writeFileSync(paths.prices, '');
  core.confirmBase();
  const c = (await core.state()).currency;
  assert.equal(c.confirmed, true); assert.deepEqual(c.unconverted, { TRY: 2 });
});
