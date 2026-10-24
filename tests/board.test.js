// Features from the Kanban board: internal transfers, review by account, units on manual assets, investment imports with
// history, several connected banks, automatic sync, and read-only MCP over HTTP with a bearer token.
const { dir } = require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { paths } = require('../lib/config');
const store = require('../lib/store');
const core = require('../lib/core');

const realFetch = global.fetch;
const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });

test('internal transfers are listed but never counted as income or spending', async () => {
  require('../lib/demo').generate();
  const txs = await core.transactions();
  const out = txs.find((t) => t.amount < 0 && t.category.startsWith('expenses:') && t.date.startsWith(core.today().slice(0, 7)));
  const before = await core.overview();
  core.setOverride(out.id, 'transfers:internal');
  const after = await core.overview();
  const moved = (await core.transactions()).find((t) => t.id === out.id);
  assert.equal(moved.category, 'transfers:internal', 'still in the transactions list');
  assert.equal(after.thisMonth.spend, Math.round((before.thisMonth.spend + out.value) * 100) / 100, 'no longer counted as spending');
  const cats = await core.categories();
  assert.ok(cats.find((c) => c.account === 'transfers:internal' && c.kind === 'transfer'), 'offered as a category');
  assert.throws(() => core.setOverride(out.id, 'transfers:Bad Name'), /Category must look like/);
});

test('review can be limited to one bank account', async () => {
  const ids = Object.keys(store.txs()), t0 = store.txs()[ids[0]];
  const more = store.txs(); more.extra1 = { ...t0, acct: 'assets:bank:second', desc: 'Only here Ltd', text: 'Only here Ltd', amount: -12 }; store.saveTxs(more);
  const accts = store.accounts(); accts.second = { name: 'second', label: 'Second', currency: t0.cur, imported: true }; store.saveAccounts(accts);
  const all = await core.review();
  assert.ok(all.accounts.length >= 2, 'there are several accounts');
  const one = all.accounts[0].account;
  const r = await core.review({ account: one });
  assert.equal(r.account, one);
  const second = await core.review({ account: 'assets:bank:second' });
  assert.deepEqual(second.merchants.map((m) => m.name), ['Only here Ltd'], 'the second account has only its own merchant');
  const txs = (await core.transactions()).filter((t) => t.account === one);
  const names = new Set(txs.map((t) => t.merchant));
  assert.ok(r.merchants.every((m) => names.has(m.merchant)), 'only merchants seen in that account');
  assert.equal((await core.review({ account: 'assets:bank:nope' })).account, null, 'an unknown account is ignored');
});

test('manual assets in units: value is units × price, history keeps units, a new price keeps the units', async () => {
  const manual = require('../lib/manual');
  manual.create({ name: 'Gold bars', type: 'other', currency: 'EUR', units: 10, unit: 'g', price: 60, date: '2026-01-01' }, 'EUR');
  manual.record('gold-bars', { date: '2026-03-01', price: 65 });
  manual.record('gold-bars', { date: '2026-05-01', units: 15, price: 70 });
  const a = manual.load().assets.find((x) => x.id === 'gold-bars');
  assert.deepEqual(a.valuations.map((v) => [v.value, v.units, v.price]), [[600, 10, 60], [650, 10, 65], [1050, 15, 70]]);
  const e = manual.entries();
  assert.deepEqual(e.postings.filter((p) => p.cur === 'MANUAL_GOLD_BARS').map((p) => [p.date, p.qty]), [['2026-01-01', 10], ['2026-05-01', 5]]);
  assert.deepEqual(e.prices.filter((p) => p.from === 'MANUAL_GOLD_BARS').map((p) => p.rate), [60, 65, 70]);
  const w = await core.wealth();
  const s = w.manual.find((x) => x.id === 'gold-bars');
  assert.equal(s.units, 15); assert.equal(s.unitPrice, 70); assert.equal(s.latest.value, 1050);
  assert.equal(s.valueBase, 1050, 'net worth values the position at units × latest price');
  manual.record('gold-bars', { date: '2026-06-01', value: 1200 }); // only a total: the units carry over
  assert.equal(manual.load().assets.find((x) => x.id === 'gold-bars').valuations.pop().price, 80);
  assert.throws(() => manual.create({ name: 'X', currency: 'EUR', units: 5, date: '2026-01-01' }, 'EUR'), /price per unit|Value/i);
  const flat = manual.create({ name: 'Flat', type: 'property', currency: 'EUR', value: 100000 }, 'EUR');
  assert.equal(flat.units, undefined, 'a single item has no units');
});

test('investment imports add dated history, never overwrite, can be undone', async () => {
  const imp = require('../lib/importer'), inv = require('../lib/investments');
  const base = (await core.wealth()).base;
  const file = (csv, o = {}) => imp.investmentRows(imp.upload(Buffer.from(csv), 'h.csv').importId, { defaultDate: '2026-01-10', defaultCurrency: base, ...o });
  const a = inv.commit(file('Ticker,Name,Quantity,Price,Cost\nAAPL,Apple,10,200,1500\nMSFT,Microsoft,5,400,1800\n').rows, { file: 'jan.csv' });
  assert.equal(a.added, 2);
  // same file again: nothing new
  assert.equal(inv.commit(file('Ticker,Name,Quantity,Price,Cost\nAAPL,Apple,10,200,1500\nMSFT,Microsoft,5,400,1800\n').rows).added, 0);
  const feb = file('Ticker,Name,Quantity,Price\nAAPL,Apple,12,210\nNVDA,Nvidia,3,100\n', { defaultDate: '2026-02-10' });
  const plan = inv.plan(feb.rows, { closeMissing: true });
  assert.deepEqual(Object.fromEntries(plan.items.map((i) => [i.symbol, i.status])), { AAPL: 'changed', NVDA: 'new', MSFT: 'closed' });
  const b = inv.commit(feb.rows, { closeMissing: true, file: 'feb.csv' });
  const l = inv.list().items;
  assert.deepEqual(l.map((i) => [i.symbol, i.qty, i.history.length]).sort(), [['AAPL', 12, 2], ['MSFT', 0, 2], ['NVDA', 3, 1]]);
  assert.equal(l.find((i) => i.symbol === 'AAPL').history[1].price, 200, 'the earlier entry is still there');
  const w = await core.wealth();
  assert.equal(w.investments.find((x) => x.symbol === 'AAPL').value, 2520, 'units × latest price, in the currency of the file');
  assert.equal(w.investments.find((x) => x.symbol === 'MSFT'), undefined, 'a closed holding is no longer held');
  inv.undo(b.id);
  assert.deepEqual(inv.list().items.map((i) => [i.symbol, i.qty, i.history.length]).sort(), [['AAPL', 10, 1], ['MSFT', 5, 1]]);
  assert.throws(() => file('Ticker,Quantity,Price\nAAPL,1,2\n', { defaultDate: undefined }), /date/i);
  assert.equal(file('Ticker,Quantity,Price\nA B!,1,2\nAAPL,x,2\nGOOG,2,3\n').errors.length, 2, 'bad rows are reported, good ones kept');
});

// ---------- several banks, automatic sync ----------
const bankSession = (name, uid, hash) => ({ session_id: 's-' + name, aspsp: { name, country: 'FI' }, access: { valid_until: '2099-01-01T00:00:00Z' }, accounts: [{ uid, identification_hash: hash, account_id: { iban: 'FI' + hash }, name: name + ' account', currency: 'EUR' }] });
test.afterEach(() => { global.fetch = realFetch; });
test('several banks: both are synced, one failing does not stop the other, disconnect removes only one', async () => {
  const settings = require('../lib/settings'), sessions = require('../lib/sessions'), { sync } = require('../lib/sync');
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  settings.setEnableBanking({ appId: 'test-app', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  const day = new Date().toISOString().slice(0, 10);
  const fail = new Set();
  global.fetch = async (url) => {
    const u = new URL(url), json = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
    const uid = u.pathname.split('/')[2];
    if (fail.has(uid)) return { ok: false, status: 401, statusText: 'x', text: async () => '{"message":"EXPIRED_SESSION"}' };
    if (u.pathname.endsWith('/balances')) return json({ balances: [{ balance_type: 'CLBD', balance_amount: { amount: '100', currency: 'EUR' } }] });
    return json({ transactions: [{ entry_reference: 'e-' + uid, booking_date: day, status: 'BOOK', credit_debit_indicator: 'DBIT', transaction_amount: { amount: '5.00', currency: 'EUR' }, creditor: { name: 'Shop ' + uid } }] });
  };
  fs.rmSync(paths.session, { force: true });
  sessions.add(bankSession('Alpha Bank', 'a1', 'HA')); sessions.add(bankSession('Beta Bank', 'b1', 'HB'));
  sessions.add(bankSession('Alpha Bank', 'a2', 'HA')); // renewing a bank replaces it
  assert.deepEqual(sessions.summary().map((s) => s.name), ['Beta Bank', 'Alpha Bank']);
  let r = await sync();
  assert.equal(r.filter((x) => !x.error).length, 2);
  assert.deepEqual([...new Set(Object.values(store.accounts()).map((a) => a.bank).filter(Boolean))].sort(), ['Alpha Bank', 'Beta Bank']);
  fail.add('b1'); r = await sync();
  assert.ok(r.find((x) => x.error && x.account === 'Beta Bank'), 'the failing bank is reported');
  assert.ok(r.find((x) => !x.error), 'the other bank still synced');
  fail.add('a2');
  await assert.rejects(sync(), /EXPIRED_SESSION/, 'when every bank fails the sync fails');
  sessions.remove('s-Beta Bank');
  assert.deepEqual(sessions.summary().map((s) => s.name), ['Alpha Bank']);
  assert.equal((await core.state()).banks.length, 1);
  // an older session.json (one object, no "sessions") is still read
  fs.writeFileSync(paths.session, JSON.stringify(bankSession('Old Bank', 'o1', 'HO')));
  assert.deepEqual(sessions.summary().map((s) => s.name), ['Old Bank']);
  sessions.remove();
  assert.equal(fs.existsSync(paths.session), false);
});

test('MCP over HTTP: off without tokens, bearer token required, read-only, revocable', async () => {
  const port = await freePort(), srv = await require('../server').start({ port });
  const call = (body, token, extra = {}) => fetch(`http://localhost:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body), ...extra });
  try {
    assert.equal((await call({ jsonrpc: '2.0', id: 1, method: 'ping' })).status, 404, 'off until a token exists');
    const tokens = require('../lib/mcptokens'), t = tokens.create('phone');
    assert.match(t.token, /^pnst_/);
    assert.ok(!fs.readFileSync(paths.mcpTokens, 'utf8').includes(t.token), 'only a hash is stored');
    assert.equal((await call({ jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
    assert.equal((await call({ jsonrpc: '2.0', id: 1, method: 'ping' }, 'pnst_wrong')).status, 401);
    const list = await (await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, t.token)).json();
    const names = list.result.tools.map((x) => x.name);
    assert.ok(names.includes('net_worth') && !names.includes('record_valuation'), 'read-only tools only');
    const nw = await (await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'net_worth', arguments: {} } }, t.token)).json();
    assert.ok(JSON.parse(nw.result.content[0].text).netWorth != null);
    const w = await (await call({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'record_valuation', arguments: { asset: 'x', value: 1 } } }, t.token)).json();
    assert.equal(w.result.isError, true, 'writing is refused');
    assert.equal((await call({ jsonrpc: '2.0', method: 'notifications/initialized' }, t.token)).status, 202, 'notifications get no body');
    assert.equal((await fetch(`http://localhost:${port}/mcp`, { headers: { authorization: 'Bearer ' + t.token } })).status, 405);
    assert.equal(tokens.list()[0].name, 'phone'); assert.ok(!('hash' in tokens.list()[0]));
    tokens.revoke(t.id);
    assert.equal((await call({ jsonrpc: '2.0', id: 1, method: 'ping' }, t.token)).status, 404, 'revoked: back to off');
  } finally { await srv.stop(); }
});

test('automatic sync can be switched off in settings', async () => {
  const port = await freePort(), srv = await require('../server').start({ port });
  try {
    const post = (u, b) => fetch(`http://localhost:${port}${u}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://localhost:${port}` }, body: JSON.stringify(b) });
    assert.equal((await (await fetch(`http://localhost:${port}/api/state`)).json()).sync.auto, true);
    await post('/api/sync/auto', { on: false });
    assert.equal((await (await fetch(`http://localhost:${port}/api/state`)).json()).sync.auto, false);
    await post('/api/sync/auto', { on: true });
  } finally { await srv.stop(); }
  assert.ok(dir);
});

test('categorized history file: categories are created from "Hobbies > Climbing", and the same merchant is then suggested for approval', async () => {
  const imp = require('../lib/importer'), cfgMod = require('../lib/config');
  const csv = 'Date,Description,Amount,Category\n2026-01-05,Boulder Wall Espoo,-24.50,Hobbies > Climbing\n2026-01-09,Boulder Wall Espoo,-18.00,Hobbies > Climbing\n2026-01-12,Lidl Helsinki,-60.10,Food/Groceries\n2026-01-15,Acme Salary,2000,Side gigs\n2026-01-20,Between my accounts,-300,Transfer\n';
  const d = imp.upload(Buffer.from(csv), 'cats.csv'), account = { name: 'History test', currency: 'EUR' };
  const opts = { useCategory: true, createCategories: true };
  const pv = imp.preview(d.importId, d.mapping, account, opts);
  assert.deepEqual(pv.newCategories.map((c) => c.account).sort(), ['expenses:hobbies:climbing', 'income:side-gigs'], 'categories you have already are matched, new ones proposed');
  assert.equal(imp.preview(d.importId, d.mapping, account, { useCategory: true }).newCategories.length, 0, 'not creating: nothing is created');
  imp.commit(d.importId, d.mapping, account, opts);
  assert.ok(cfgMod.loadConfig().categories.includes('expenses:hobbies:climbing'));
  const txs = await core.transactions();
  const cat = (desc) => txs.find((t) => t.desc === desc)?.category;
  assert.equal(cat('Boulder Wall Espoo'), 'expenses:hobbies:climbing');
  assert.equal(cat('Acme Salary'), 'income:side-gigs');
  assert.equal(cat('Lidl Helsinki'), 'expenses:food:groceries');
  assert.equal(cat('Between my accounts'), 'transfers:internal');
  // The same merchant shows up again (a bank sync): uncategorized, but suggested. A merchant never seen gets no suggestion.
  const more = store.txs(), acct = Object.values(more).find((t) => t.desc === 'Boulder Wall Espoo').acct;
  more.again1 = { acct, date: '2026-02-03', amount: -31, cur: 'EUR', desc: 'Boulder Wall Espoo', text: 'Boulder Wall Espoo' };
  more.again2 = { acct, date: '2026-02-04', amount: -9, cur: 'EUR', desc: 'Qwertyuiop Zyx Oy', text: 'Qwertyuiop Zyx Oy' };
  store.saveTxs(more); require('../lib/journal').rebuildBank();
  const page = await core.transactionsPage({ pending: '1', limit: 500 });
  const known = page.rows.find((t) => t.desc === 'Boulder Wall Espoo'), unknown = page.rows.find((t) => t.desc === 'Qwertyuiop Zyx Oy');
  assert.equal(known.suggestion.category, 'expenses:hobbies:climbing');
  assert.equal(unknown.suggestion, undefined);
  assert.ok(page.rows.every((t) => t.category.endsWith(':uncategorized')), 'the filter keeps only what needs a category');
  assert.ok(page.pending >= 2);
  core.assignMerchant(known.merchant, known.suggestion.category); // "Approve"
  assert.equal((await core.transactions()).find((t) => t.id === 'again1').category, 'expenses:hobbies:climbing');
});
