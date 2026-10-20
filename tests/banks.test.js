// Several banks at once: each connection keeps its own consent; syncing goes through all of them, and one failing
// (expired consent, bank down) does not stop the others.
const { dir } = require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const crypto = require('crypto');
const { paths } = require('../lib/config');
const settings = require('../lib/settings');
const store = require('../lib/store');
const banks = require('../lib/banks');
const { today } = require('../lib/dates');
const { sync } = require('../lib/sync');

const day = (n) => new Date(Date.parse(today()) - n * 864e5).toISOString().slice(0, 10);
const TX = { 'uid-a': [{ entry_reference: 'a1', booking_date: day(3), credit_debit_indicator: 'DBIT', transaction_amount: { amount: '20.00', currency: 'EUR' }, creditor: { name: 'Shop' } }], 'uid-b': [{ entry_reference: 'b1', booking_date: day(2), credit_debit_indicator: 'CRDT', transaction_amount: { amount: '100.00', currency: 'EUR' }, debtor: { name: 'Employer' } }] };
let down = null;
global.fetch = async (url) => {
  const u = new URL(url), uid = u.pathname.split('/')[2], json = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
  if (uid === down) return { ok: false, status: 503, statusText: 'Service Unavailable', text: async () => '{"message":"bank is down"}' };
  if (u.pathname.endsWith('/balances')) return json({ balances: [{ balance_type: 'CLBD', balance_amount: { amount: uid === 'uid-a' ? '1000' : '2000', currency: 'EUR' } }] });
  return json({ transactions: TX[uid] || [] });
};
const future = new Date(Date.now() + 30 * 864e5).toISOString();
const sessionOf = (bank, uid, extra = {}) => ({ session_id: 'sess-' + uid, aspsp: { name: bank, country: 'FI' }, access: { valid_until: future }, accounts: [{ uid, name: 'Current account', currency: 'EUR', account_id: { iban: 'FI00' + uid } }], ...extra });

test.before(() => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  settings.setEnableBanking({ appId: 'test-app', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  assert.ok(dir);
});

test('an older single-bank session file still works, and a second bank is added next to it', () => {
  fs.writeFileSync(paths.session, JSON.stringify(sessionOf('Bank A', 'uid-a')));
  assert.equal(banks.list().length, 1, 'the old format is read');
  banks.add(sessionOf('Bank B', 'uid-b'));
  assert.deepEqual(banks.summary().map((b) => b.bank), ['Bank A', 'Bank B']);
  // Renewing a bank replaces its own connection only.
  banks.add(sessionOf('Bank A', 'uid-a', { session_id: 'sess-renewed' }));
  assert.deepEqual(banks.summary().map((b) => [b.bank, b.id]), [['Bank B', 'sess-uid-b'], ['Bank A', 'sess-renewed']]);
  assert.equal(banks.bankOf()['uid-a'], 'sess-renewed');
});

test('sync goes through every bank; accounts with the same name at two banks stay apart', async () => {
  const r = await sync();
  assert.equal(r.length, 2); assert.ok(r.every((x) => !x.error), JSON.stringify(r));
  const names = Object.values(store.accounts()).map((a) => a.name).sort();
  assert.deepEqual(names, ['current-account', 'current-account-2']);
  assert.equal(Object.keys(store.txs()).length, 2);
  assert.ok(Object.values(store.accounts()).every((a) => a.lastSyncAt), 'the time of the sync is kept (automatic sync uses it)');
});

test('one bank failing or expired is reported; the others still sync', async () => {
  TX['uid-b'].push({ entry_reference: 'b2', booking_date: day(1), credit_debit_indicator: 'DBIT', transaction_amount: { amount: '5.00', currency: 'EUR' }, creditor: { name: 'Cafe' } });
  down = 'uid-a';
  let r = await sync();
  assert.match(r.find((x) => x.bank === 'Bank A').error, /bank is down/);
  assert.equal(r.find((x) => x.bank === 'Bank B').added, 1);
  down = null;
  const l = banks.list(); l.find((s) => s.aspsp.name === 'Bank A').access.valid_until = '2020-01-01T00:00:00Z';
  fs.writeFileSync(paths.session, JSON.stringify({ sessions: l }));
  r = await sync();
  assert.match(r.find((x) => x.bank === 'Bank A').error, /expired/);
  assert.equal(banks.summary().find((b) => b.bank === 'Bank A').expired, true);
});

test('disconnecting one bank keeps the other and all history', () => {
  const id = banks.summary().find((b) => b.bank === 'Bank A').id;
  banks.remove(id);
  assert.deepEqual(banks.summary().map((b) => b.bank), ['Bank B']);
  assert.equal(Object.keys(store.txs()).length, 3, 'history stays');
  assert.throws(() => banks.remove('nope'), /Unknown bank/);
  banks.remove(banks.summary()[0].id);
  assert.equal(fs.existsSync(paths.session), false, 'the last one removes the file');
});
