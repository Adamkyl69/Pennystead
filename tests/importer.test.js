const { fixture } = require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const imp = require('../lib/importer'), core = require('../lib/core'), store = require('../lib/store'), demo = require('../lib/demo');

const bal = async (acct) => (await core.wealth()).accounts.find((a) => a.account === acct)?.value;
const csv = (s) => Buffer.from(s);
const run = (buf, name, account, options = {}, commit = true) => { const d = imp.upload(buf, name); return commit ? imp.commit(d.importId, d.mapping, account, options) : imp.preview(d.importId, d.mapping, account, options); };

test.before(() => { demo.generate(); });

test('older history into a bank-synced account: today\'s balance does not change, opening shifts back', async () => {
  const before = await bal('assets:bank:checking'), nw = (await core.wealth()).netWorth, open0 = { ...store.accounts()['demo-acct'].opening };
  const file = csv('Date,Payee,Amount\n2024-01-05,Old Shop A,-100.00\n2024-01-20,Old Employer,2000.00\n2024-02-10,Old Shop B,-25.50\n2026-10-01,ACME OY,3400.00\n2026-10-08,Spotify Premium,-10.99\n2026-10-09,Brand New Cafe,-4.20\n');
  const p = run(file, 'm.csv', { uid: 'demo-acct' }, {}, false);
  assert.deepEqual([p.counts.new, p.counts.duplicate, p.counts.possible_duplicate, p.counts.overlap], [3, 1, 1, 1], 'exact duplicate, same date+amount, and in-window row are held back');
  const r = run(file, 'm.csv', { uid: 'demo-acct' });
  assert.equal(r.added, 3); assert.equal(await bal('assets:bank:checking'), before); assert.equal((await core.wealth()).netWorth, nw);
  const open1 = store.accounts()['demo-acct'].opening; assert.equal(open1.date, '2024-01-04'); assert.equal(Math.round((open0.amount - open1.amount) * 100) / 100, 1874.5);
  // re-importing is a no-op
  assert.throws(() => run(file, 'm.csv', { uid: 'demo-acct' }), /Nothing to import/);
  // undo restores everything exactly
  const txs = Object.keys(store.txs()).length; imp.undo(r.batch);
  assert.deepEqual(store.accounts()['demo-acct'].opening, open0); assert.equal(await bal('assets:bank:checking'), before); assert.equal(Object.keys(store.txs()).length, txs - 3);
  assert.throws(() => imp.undo(r.batch), /already undone/);
});

test('opt-in for possible duplicates and bank-sync overlap', () => {
  const file = csv('Date,Payee,Amount\n2026-10-08,Spotify Premium,-10.99\n2026-10-09,Brand New Cafe,-4.20\n');
  assert.equal(run(file, 'o.csv', { uid: 'demo-acct' }, {}, false).counts.toImport, 0);
  assert.equal(run(file, 'o.csv', { uid: 'demo-acct' }, { includePossible: true, includeOverlap: true }, false).counts.toImport, 2);
});

test('new account: anchored to the balance column, repeated file is all duplicates, same name reuses the account', async () => {
  const nw0 = (await core.wealth()).netWorth;
  const r = run(fixture('fi.csv'), 'fi.csv', { name: 'Nordea Säästö', currency: 'EUR' });
  const uid = Object.keys(store.accounts()).find((k) => k.startsWith('import-')), name = store.accounts()[uid].name;
  assert.equal(name, 'nordea-saasto', 'accents are folded in the account id'); assert.equal(await bal('assets:bank:' + name), 8765.5);
  assert.equal(Math.round(((await core.wealth()).netWorth - nw0) * 100) / 100, 8765.5);
  const again = run(fixture('fi.csv'), 'fi.csv', { name: 'nordea saasto', currency: 'EUR' }, {}, false);
  assert.equal(again.counts.duplicate, 4); assert.equal(again.account.isNew, false, 'typing the same name reuses the account instead of making "-2"');
  assert.equal(Object.keys(store.accounts()).filter((k) => k.startsWith('import-')).length, 1);
  // keep for the next tests
  return r;
});

test('balances: older rows keep today; a newer file re-anchors; an older file\'s stale balance is ignored; typed balance works', async () => {
  const uid = Object.keys(store.accounts()).find((k) => k.startsWith('import-')), A = 'assets:bank:' + store.accounts()[uid].name;
  run(csv('Kirjauspäivä;Määrä;Saaja/Maksaja\n15.02.2024;-100,00;Old thing\n20.02.2024;500,00;Old income\n'), 'older.csv', { uid });
  assert.equal(await bal(A), 8765.5, 'older rows must not change today');
  const newer = run(csv('Kirjauspäivä;Määrä;Saaja/Maksaja;Saldo\n10.03.2024;-200,00;Later shop;8 565,50\n'), 'newer.csv', { uid }); assert.equal(await bal(A), 8565.5);
  const stale = run(csv('Kirjauspäivä;Määrä;Saaja/Maksaja;Saldo\n01.02.2024;-50,00;Ancient;111,00\n'), 'stale.csv', { uid }, {}, false);
  assert.equal(stale.balance.used, false); run(csv('Kirjauspäivä;Määrä;Saaja/Maksaja;Saldo\n01.02.2024;-50,00;Ancient;111,00\n'), 'stale.csv', { uid }); assert.equal(await bal(A), 8565.5, 'stale balance ignored');
  run(csv('Date,Payee,Amount\n2024-03-20,Another,-10.00\n'), 'm.csv', { uid }, { balance: 8000 }); assert.equal(await bal(A), 8000);
  run(csv('Date,Payee,Amount\n2024-01-02,Older,-5.00\n'), 'm2.csv', { uid }, { balance: 1 }); assert.equal(await bal(A), 8000, 'typed balance on an older file is ignored too');
  // undo newest-first; refused otherwise
  const mine = imp.history().filter((x) => x.uid === uid && !x.undoneAt); assert.ok(mine.length >= 3); assert.throws(() => imp.undo(mine[mine.length - 1].id), /newer import/);
  for (const e of imp.history().filter((x) => !x.undoneAt)) imp.undo(e.id);
  assert.equal(store.accounts()[uid], undefined, 'the account created by the first import disappears when everything is undone');
});

test('category column is used when it matches, otherwise rules apply; everything unknown goes to Review', () => {
  const p = run(fixture('us.csv'), 'us.csv', { name: 'US', currency: 'EUR' }, { useCategory: true }, false);
  const cat = (d) => p.sample.find((r) => r.desc.startsWith(d)).category;
  assert.equal(cat('AMAZON'), 'expenses:shopping'); assert.equal(cat('TRADER'), 'expenses:food:groceries'); assert.equal(cat('SHELL'), 'expenses:transport');
});
test('wrong currency rows are reported, not silently mixed', () => {
  const p = run(fixture('dir.csv'), 'dir.csv', { name: 'Cur', currency: 'EUR' }, {}, false);
  assert.equal(p.counts.errors, 1); assert.match(p.errors[0].error, /USD.*EUR/);
});
test('imported text keeps accents in the app while the ledger journal stays ASCII', async () => {
  run(fixture('fi.csv'), 'fi.csv', { name: 'Accent test', currency: 'EUR' });
  assert.ok((await core.transactions()).some((t) => t.desc === 'Kahvila Äpy'));
  const j = require('node:fs').readFileSync(require('../lib/config').paths.bank, 'utf8'); assert.ok(!/[^\x00-\x7f]/.test(j), 'journal must be ASCII-only'); assert.ok(j.includes('Kahvila Apy'));
});
