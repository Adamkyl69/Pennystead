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
