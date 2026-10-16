require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const store = require('../lib/store'), J = require('../lib/journal'), core = require('../lib/core');
const { paths, loadConfig, saveConfig } = require('../lib/config');

// No currency is assumed anywhere: the currency codes below are only test data (any ISO code works the same).
const acct = (cur, n = 'main') => ({ name: n, label: n, currency: cur, lastSync: '2026-10-16', opening: { date: '2026-09-30', amount: 10000, cur } });
const tx = (cur, a, n = 'main') => ({ acct: 'assets:bank:' + n, date: '2026-10-02', amount: a, cur, desc: 'SHOP ' + a, text: 'SHOP' });

test('a fresh install has no main currency at all', async () => {
  J.writeDerived();
  assert.equal(loadConfig().base, null);
  const st = await core.state();
  assert.equal(st.base, null);
  assert.deepEqual(st.currency, { base: null, confirmed: false, accounts: [], unconverted: {} });
  assert.throws(() => core.confirmBase(), /no currency/);
});

test('the main currency is whatever the bank reports, even over an old saved default', async () => {
  const c = loadConfig(); c.base = 'EUR'; saveConfig(c); // what older versions wrote before anyone chose
  store.saveAccounts({ u1: acct('XYZ') }); store.saveTxs({ a: tx('XYZ', -1500), b: tx('XYZ', 45000) }); J.rebuildBank();
  const st = await core.state();
  assert.deepEqual(st.currency, { base: 'XYZ', confirmed: false, accounts: ['XYZ'], unconverted: {} });
  assert.equal((await core.wealth()).netWorth, 10000 - 1500 + 45000);
  core.confirmBase();
  assert.equal(loadConfig().base, 'XYZ'); assert.equal(loadConfig().baseConfirmed, true);
});

test('several currencies: the one most accounts use, the rest converted with rates or reported as unconverted', async () => {
  const c = loadConfig(); delete c.baseConfirmed; saveConfig(c);
  store.saveAccounts({ u1: acct('AAA', 'a1'), u2: acct('AAA', 'a2'), u3: acct('BBB', 'b1') });
  store.saveTxs({ x: tx('AAA', -10, 'a1'), y: tx('AAA', -20, 'a2'), z: tx('BBB', -100, 'b1') }); J.rebuildBank();
  let st = (await core.state()).currency;
  assert.equal(st.base, 'AAA'); assert.deepEqual(st.accounts, ['AAA', 'BBB']); assert.deepEqual(st.unconverted, { BBB: 1 });
  fs.writeFileSync(paths.prices, 'P 2026-10-01 BBB 0.5 AAA\n');
  assert.equal((await core.transactions()).find((t) => t.cur === 'BBB').value, -50);
  core.setBase('bbb');
  st = (await core.state()).currency;
  assert.deepEqual([st.base, st.confirmed], ['BBB', true]);
  assert.throws(() => core.setBase('dollars'), /3-letter/);
});
