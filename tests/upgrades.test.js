// Import cross-checks, ambiguity warnings, stale-price warnings and the app window.
const { dir } = require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const imp = require('../lib/importer'), { _t } = imp;
const store = require('../lib/store'), core = require('../lib/core');
const { paths, saveConfig, loadConfig } = require('../lib/config');
const { today, shiftDays } = require('../lib/dates');

test.beforeEach(() => { store.saveTxs({}); store.saveAccounts({}); saveConfig({ ...loadConfig(), base: 'EUR', holdings: [], cash: [] }); fs.writeFileSync(paths.prices, ''); });
const preview = (csv, mapping = {}) => { const d = imp.upload(Buffer.from(csv), 'f.csv'); return imp.preview(d.importId, { ...d.mapping, ...mapping }, { name: 'Check', currency: 'EUR' }, {}); };
const BAL = 'Date,Payee,Amount,Balance\n2024-01-01,A,-10.00,90.00\n2024-01-02,B,-20.00,70.00\n2024-01-03,C,50.00,120.00\n2024-01-04,D,-5.00,115.00\n2024-01-05,E,-15.00,100.00\n';

test('balance cross-check: matching file passes; swapped signs and wrong decimals get a targeted hint', () => {
  assert.equal(preview(BAL).balanceCheck.ok, true);
  const flipped = preview(BAL, { invert: true }).balanceCheck;
  assert.equal(flipped.ok, false); assert.equal(flipped.hint, 'flip');
  assert.equal(_t.balanceCheck([10, 20, 30, 40, 50].map((b, i) => ({ amount: 10000, balance: b + i * 0 }))).hint, 'decimal');
  assert.equal(_t.balanceCheck([{ amount: 1, balance: 1 }, { amount: 1, balance: 2 }]), null, 'too few rows to judge');
});
test('ambiguity: 3-decimal-only amounts and dates no day decides are flagged; a confirmed choice is not', () => {
  const csv = 'Date,Payee,Amount\n03/04/2024,A,-12.500\n05/04/2024,B,250.000\n';
  const p = preview(csv);
  assert.deepEqual(p.ambiguous, { decimal: true, date: true });
  assert.deepEqual(preview(csv, { decimal: ',', dateFormat: 'DMY' }).ambiguous, { decimal: false, date: false });
  assert.deepEqual(preview('Date,Payee,Amount\n13/04/2024,A,-12.50\n').ambiguous, { decimal: false, date: false });
});
test('stale prices: a week-old stock price and the currency it is quoted in are flagged, fresh ones are not', async () => {
  const old = shiftDays(today(), -20);
  saveConfig({ ...loadConfig(), holdings: [{ symbol: 'AAPL', qty: 1, since: '2024-01-01' }, { symbol: 'MSFT', qty: 1, since: '2024-01-01' }] });
  fs.writeFileSync(paths.prices, `P ${old} AAPL 200 USD\nP ${today()} MSFT 400 USD\nP ${old} USD 0.9 EUR\n`);
  assert.deepEqual((await core.wealth()).stalePrices.map((x) => x.commodity).sort(), ['AAPL', 'USD']);
  fs.writeFileSync(paths.prices, `P ${today()} AAPL 200 USD\nP ${today()} MSFT 400 USD\nP ${today()} USD 0.9 EUR\n`);
  assert.deepEqual((await core.wealth()).stalePrices, []);
});
test('app window: finds an installed Chromium-family browser and opens the URL with --app', { skip: process.platform === 'win32' || process.platform === 'darwin' }, () => {
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin, { recursive: true }); fs.writeFileSync(path.join(bin, 'chromium'), '#!/bin/sh\n', { mode: 0o755 });
  const saved = process.env.PATH; process.env.PATH = bin;
  try {
    const w = require('../lib/window');
    assert.equal(w.find().name, 'Chromium');
    assert.deepEqual(w.appCommand('http://localhost:3456'), [path.join(bin, 'chromium'), ['--app=http://localhost:3456', '--new-window']]);
    process.env.PATH = path.join(dir, 'empty'); assert.equal(w.appCommand('http://x'), null, 'no browser: the default browser is used instead');
  } finally { process.env.PATH = saved; }
});

test('category suggestions learn from merchants you categorized, and stay quiet without real evidence', () => {
  const S = require('../lib/suggest'), A = require('../lib/analysis');
  const tx = (desc, category) => ({ desc, category, merchant: A.merchantKey(desc), amount: -20 });
  const m = S.train([tx('LIDL HELSINKI', 'expenses:food:groceries'), tx('NESTE HELSINKI', 'expenses:transport:fuel'), tx('MOTONET ESPOO', 'expenses:transport'), tx('ACME SALARY', 'income:salary')]);
  const lidl = S.suggest(m, 'LIDL 1234 VANTAA', -15);
  assert.equal(lidl.category, 'expenses:food:groceries'); assert.ok(lidl.confidence >= 0.8); assert.equal(lidl.because, 'LIDL HELSINKI');
  assert.equal(S.suggest(m, 'HELSINKI HOUSING LTD', -900), null, '"helsinki" points at two categories: not evidence');
  assert.equal(S.suggest(m, 'TOTALLY NEW SHOP', -9), null, 'no shared words: no guess');
  assert.equal(S.suggest(m, 'ACME BONUS', -50), null, 'money out is never given an income category');
  assert.equal(S.suggest(m, 'MOTONET VANTAA', -30).category, 'expenses:transport');
});
test('Review: suggestions on the sample data, and "accept all" creates the rules in one go', async () => {
  store.saveTxs({}); require('../lib/demo').generate();
  const r = await core.review(), moto = r.merchants.find((m) => m.name === 'MOTONET VANTAA');
  assert.equal(moto.suggestion.category, 'expenses:transport');
  core.assignMerchants([{ merchant: moto.merchant, category: moto.suggestion.category }]);
  assert.ok(!(await core.review()).merchants.some((m) => m.name === 'MOTONET VANTAA'));
  assert.throws(() => core.assignMerchants([{ merchant: 'x', category: 'not a category' }]), /Category must look like/);
  require('../lib/demo').clear();
});

test('goals: needed monthly amount matches the savings formula, with and without growth', () => {
  const G = require('../lib/goals');
  assert.equal(G.needed(0, 1200, 12, 0), 100);
  const n = G.needed(4400.88, 250000, 159, 0.005); // 6% a year
  let v = 4400.88; for (let k = 0; k < 159; k++) v = v * 1.005 + n;
  assert.ok(Math.abs(v - 250000) < 0.01, `ends at ${v}`);
});
test('goals: progress from the real balance, projection at your pace, status and chart points', async () => {
  const G = require('../lib/goals');
  store.saveTxs({}); store.saveAccounts({}); require('../lib/demo').clear();
  const t = today(), m = (k) => shiftDays(t, -30 * k);
  store.saveAccounts({ a: { name: 'savings', label: 'Savings', currency: 'EUR', imported: true, opening: { date: m(8), amount: 1000, cur: 'EUR' } } });
  store.saveTxs(Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((k) => ['s' + k, { acct: 'assets:bank:savings', date: m(k), amount: 500, cur: 'EUR', desc: 'TRANSFER IN', text: 'TRANSFER IN' }])));
  const far = `${+t.slice(0, 4) + 3}-12-31`;
  const g = G.create({ name: 'Trip', target: 10000, by: far, source: 'acct:assets:bank:savings' });
  const r = G.list().goals.find((x) => x.id === g.id);
  assert.equal(r.current, 4500); assert.equal(r.pct, 45); assert.ok(r.pace > 400 && r.pace <= 500, `pace ${r.pace}`);
  assert.equal(r.status, 'on_track'); assert.ok(r.reachDate < far.slice(0, 7));
  assert.ok(r.points.some((p) => p.actual != null) && r.points.some((p) => p.projected != null && p.actual == null) && r.points.some((p) => p.needed != null));
  G.update(g.id, { monthly: 0 }); assert.equal(G.list().goals.find((x) => x.id === g.id).status, 'not_reachable');
  G.update(g.id, { target: 3000 }); assert.equal(G.list().goals.find((x) => x.id === g.id).status, 'reached');
  assert.throws(() => G.update(g.id, { by: '2001-01-01' }), /future/); assert.throws(() => G.create({ name: 'x', target: -5 }), /above 0/); assert.throws(() => G.update(g.id, { source: 'nope' }), /Unknown balance/);
  G.remove(g.id); assert.ok(!G.list().goals.some((x) => x.id === g.id));
});

test('monthly goal check: once per month, records status and change since the last check, can be dismissed or turned off', () => {
  const G = require('../lib/goals'), C = require('../lib/goalchecks');
  store.saveTxs({}); store.saveAccounts({}); fs.rmSync(paths.goalChecks, { force: true });
  saveConfig({ ...loadConfig(), goals: [], goalChecks: 'monthly' });
  assert.equal(C.run(), null, 'no goals: nothing to check');
  store.saveAccounts({ a: { name: 'pot', label: 'Pot', currency: 'EUR', imported: true, opening: { date: shiftDays(today(), -400), amount: 1000, cur: 'EUR' } } });
  const g = G.create({ name: 'Pot', target: 5000, source: 'acct:assets:bank:pot' });
  const first = C.run();
  assert.equal(first.month, today().slice(0, 7)); assert.equal(first.goals[0].current, 1000); assert.equal(first.goals[0].change, null, 'nothing to compare with yet');
  assert.equal(C.run(), null, 'already checked this month');
  assert.equal(C.unseen().month, first.month);
  // Pretend that check was last month, add savings, check again: the change and the earlier status are recorded.
  const prevMonth = shiftDays(today().slice(0, 7) + '-01', -1).slice(0, 7);
  fs.writeFileSync(paths.goalChecks, JSON.stringify([{ ...first, month: prevMonth, goals: [{ ...first.goals[0], status: 'behind' }] }]));
  store.saveTxs({ x: { acct: 'assets:bank:pot', date: today(), amount: 600, cur: 'EUR', desc: 'SAVE', text: 'SAVE' } });
  const second = C.run();
  assert.equal(second.goals[0].change, 600); assert.equal(second.goals[0].statusBefore, 'behind');
  assert.equal(C.history(g.id).length, 2);
  C.markSeen(second.month); assert.equal(C.unseen(), null);
  saveConfig({ ...loadConfig(), goalChecks: 'off' }); fs.rmSync(paths.goalChecks, { force: true });
  assert.equal(C.run(), null, 'turned off'); assert.ok(C.run({ force: true }), '"Check now" still works');
  G.remove(g.id);
});
