const { dir } = require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const crypto = require('crypto');
const { paths } = require('../lib/config');
const settings = require('../lib/settings');
const store = require('../lib/store');
const { today } = require('../lib/dates');
const { sync, coverage } = require('../lib/sync');

// A fake bank: two transactions a month for the last 13 months. By default it sends only the oldest and the newest
// month (what a bank limiting history looks like); strategy=longest gets everything, over pages including an empty one.
const iso = (d) => d.toISOString().slice(0, 10);
const day = (n) => iso(new Date(Date.parse(today()) - n * 864e5));
const BANK = [];
for (let i = 0; i < 26; i++) BANK.push({ entry_reference: 'r' + i, booking_date: day(i * 15), status: 'BOOK', credit_debit_indicator: i % 2 ? 'CRDT' : 'DBIT', transaction_amount: { amount: i % 2 ? '900.00' : String(100 + i), currency: 'EUR' }, creditor: { name: 'Shop ' + i }, debtor: { name: 'Employer' } });
const BALANCE = 5000;
let partial = false, noLongest = false, calls = [];

global.fetch = async (url) => {
  const u = new URL(url), json = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
  calls.push(u.pathname + u.search);
  if (u.pathname.endsWith('/balances')) return json({ balances: [{ balance_type: 'CLBD', balance_amount: { amount: String(BALANCE), currency: 'EUR' } }] });
  if (noLongest && u.searchParams.get('strategy')) return { ok: false, status: 422, statusText: 'x', text: async () => '{"message":"WRONG_TRANSACTIONS_PERIOD"}' };
  const from = u.searchParams.get('date_from'), longest = u.searchParams.get('strategy') === 'longest', key = u.searchParams.get('continuation_key');
  let rows = BANK.filter((t) => longest || t.booking_date >= from);
  if (partial && !longest) { const months = rows.map((t) => t.booking_date.slice(0, 7)).sort(); rows = rows.filter((t) => [months[0], months[months.length - 1]].includes(t.booking_date.slice(0, 7))); }
  if (!longest) return json({ transactions: rows });
  if (!key) return json({ transactions: rows.slice(0, 10), continuation_key: 'k1' });
  if (key === 'k1') return json({ transactions: [], continuation_key: 'k2' });
  return json({ transactions: rows.slice(10) });
};

const session = (uid) => fs.writeFileSync(paths.session, JSON.stringify({ accounts: [{ uid, identification_hash: 'HASH-1', account_id: { iban: 'FI0012345600001234' }, name: 'Erdem Kalayci', currency: 'EUR' }] }));
const mine = () => Object.values(store.txs()).filter((t) => t.acct === 'assets:bank:erdem-kalayci');
const balanceNow = () => { const m = Object.values(store.accounts())[0]; return Math.round((m.opening.amount + mine().reduce((s, t) => s + t.amount, 0)) * 100) / 100; };

test.before(() => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  settings.setEnableBanking({ appId: 'test-app', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  assert.ok(dir);
});

test('a bank that sent only part of the history: gaps are reported, a full fetch fills them, the balance stays right', async () => {
  session('uid-1');
  // An install from before full fetches existed: a one-year request that the bank answered only partly.
  partial = true; noLongest = true;
  await sync();
  noLongest = false;
  const a = store.accounts();
  delete a['uid-1'].fullAt; store.saveAccounts(a); // as left by an older version
  const before = coverage('assets:bank:erdem-kalayci');
  assert.ok(before.gaps.length >= 10, 'the empty months in between are listed');
  assert.equal(balanceNow(), BALANCE);

  // A statement file was imported for one missing month: the bank's copy of that row must not be added again.
  const gap = BANK.find((t) => t.booking_date.slice(0, 7) === before.gaps[0]);
  const amt = (gap.credit_debit_indicator === 'DBIT' ? -1 : 1) * parseFloat(gap.transaction_amount.amount);
  const all = store.txs(); all.imp1 = { acct: 'assets:bank:erdem-kalayci', date: gap.booking_date, amount: amt, cur: 'EUR', desc: 'from a file', text: 'from a file', src: 'import' }; store.saveTxs(all);

  // The next sync of an older install fetches the full history once, by itself.
  calls = [];
  const r = await sync();
  assert.ok(calls.some((c) => c.includes('strategy=longest')), 'asks for the longest history');
  assert.ok(calls.filter((c) => c.includes('continuation_key=k2')).length === 1, 'follows the key past an empty page');
  const after = coverage('assets:bank:erdem-kalayci');
  assert.deepEqual(after.gaps, []);
  assert.equal(after.count, BANK.length, 'every bank row once; the imported row stands in for its bank copy');
  assert.equal(mine().filter((t) => t.date === gap.booking_date && t.amount === amt).length, 1);
  assert.equal(r[0].gaps.length, 0);
  assert.equal(balanceNow(), BALANCE, 'opening balance recalculated so filling the gap does not change today\'s balance');

  // Later syncs are incremental again.
  calls = [];
  await sync();
  assert.ok(!calls.some((c) => c.includes('strategy=longest')));
  assert.equal(mine().length, BANK.length);
});

test('reconnecting (new uid for the same account) keeps the account and adds no duplicates; "full" can be asked for', async () => {
  session('uid-2');
  calls = [];
  const r = await sync({ full: true });
  assert.ok(calls.some((c) => c.includes('/accounts/uid-2/') && c.includes('strategy=longest')));
  assert.deepEqual(Object.keys(store.accounts()), ['uid-2']);
  assert.equal(store.accounts()['uid-2'].name, 'erdem-kalayci');
  assert.equal(r[0].added, 0);
  assert.equal(mine().length, BANK.length);
  assert.equal(balanceNow(), BALANCE);
});

test('a bank that refuses the longest search still gets a year', async () => {
  partial = false; noLongest = true;
  try { await sync({ full: true }); assert.equal(mine().length, BANK.length); assert.equal(balanceNow(), BALANCE); } finally { noLongest = false; }
});
