require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../lib/store'), J = require('../lib/journal'), core = require('../lib/core');

const bal = async (acct) => (await core.wealth()).accounts.find((a) => a.account === acct)?.value;
const ebTx = (ref, amount, desc) => ({ entry_reference: ref, booking_date: '2026-10-0' + ref.slice(-1), status: 'BOOK', credit_debit_indicator: amount < 0 ? 'DBIT' : 'CRDT', transaction_amount: { amount: String(Math.abs(amount)), currency: 'XYZ' }, creditor: { name: desc }, debtor: { name: desc } });

test.before(() => {
  J.writeDerived();
  store.saveAccounts({ u1: { name: 'main', label: 'Main', currency: 'XYZ', lastSync: '2026-10-10', opening: { date: '2026-09-30', amount: 1000, cur: 'XYZ' } } });
  J.ingest('u1', 'assets:bank:main', [ebTx('r1', -10, 'SHOP A'), ebTx('r2', -20, 'SHOP B'), ebTx('r3', -30, 'SHOP C'), ebTx('r4', 500, 'SALARY')]);
  J.rebuildBank();
});

test('bulk delete: gone from history, balance stays as the bank says, bank sync does not bring them back', async () => {
  const before = await bal('assets:bank:main');
  const page = await core.transactionsPage({ q: 'shop', idsOnly: 1 });
  assert.equal(page.ids.length, 3, '"select all matching" returns every matching id');
  const r = core.deleteTransactions(page.ids.slice(0, 2));
  assert.equal(r.deleted, 2);
  assert.equal((await core.transactions()).filter((t) => t.desc.startsWith('SHOP')).length, 1);
  assert.equal(await bal('assets:bank:main'), before, 'balance unchanged');
  const again = J.ingest('u1', 'assets:bank:main', [ebTx('r1', -10, 'SHOP A'), ebTx('r2', -20, 'SHOP B'), ebTx('r3', -30, 'SHOP C'), ebTx('r4', 500, 'SALARY')]);
  assert.equal(again.count, 0, 'the next sync skips deleted transactions');
  assert.equal(core.deletedBatches()[0].count, 2);
  assert.throws(() => core.deleteTransactions([]), /Select/);
  assert.throws(() => core.deleteTransactions(['nope']), /no longer exist/);
  // Undo
  assert.equal(core.restoreTransactions(r.batch).restored, 2);
  assert.equal((await core.transactions()).filter((t) => t.desc.startsWith('SHOP')).length, 3);
  assert.equal(await bal('assets:bank:main'), before);
  assert.deepEqual(core.deletedBatches(), []);
});

test('bulk category: many at once, and back to the rules', async () => {
  const ids = (await core.transactionsPage({ q: 'shop', idsOnly: 1 })).ids;
  assert.equal(core.setOverrides(ids, 'expenses:food').updated, 3);
  assert.ok((await core.transactions()).filter((t) => t.desc.startsWith('SHOP')).every((t) => t.category === 'expenses:food'));
  core.setOverrides(ids, '');
  assert.ok((await core.transactions()).filter((t) => t.desc.startsWith('SHOP')).every((t) => t.category !== 'expenses:food'));
  assert.throws(() => core.setOverrides(ids, 'not a category'), /Category must/);
});
