const { dir } = require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const demo = require('../lib/demo'), core = require('../lib/core'), b = require('../lib/backup'), imp = require('../lib/importer');
const { workbook } = require('../lib/export');
const { writeXlsx } = require('../lib/xlsxwrite');
const { readXlsx } = require('../lib/xlsx');
const { loadConfig, saveConfig } = require('../lib/config');

test.before(() => demo.generate());

test('writer: text stays text (no formulas), numbers and dates are real values, odd characters survive', () => {
  const buf = writeXlsx([{ name: 'A/B:C', columns: [{ header: 'Date', type: 'date' }, { header: 'Text' }, { header: 'Money', type: 'money' }], rows: [['2026-03-01', '=HYPERLINK("x")', -12.5], ['2026-03-02', 'Café & <Ünïcode> "q"', 1e6]] }]);
  const s = readXlsx(buf).sheets[0];
  assert.equal(s.name, 'A B C');
  assert.deepEqual(s.rows[1], ['2026-03-01', '=HYPERLINK("x")', -12.5]);
  assert.deepEqual(s.rows[2], ['2026-03-02', 'Café & <Ünïcode> "q"', 1e6]);
});

test('the Excel copy has every transaction, the balances and spending by month, and matches the app', async () => {
  const txs = await core.transactions(), w = await core.wealth();
  const { sheets } = readXlsx(await workbook());
  assert.deepEqual(sheets.map((s) => s.name), ['Transactions', 'Balances', 'Spending by month']);
  const [t, bal, sp] = sheets;
  assert.equal(t.rows.length - 1, txs.length);
  assert.equal(Math.round(t.rows.slice(1).reduce((s, r) => s + r[4], 0) * 100), Math.round(txs.reduce((s, x) => s + x.amount, 0) * 100));
  assert.equal(bal.rows.find((r) => r[0] === 'Net worth')[1], w.netWorth);
  const spent = txs.filter((x) => x.category.startsWith('expenses') && x.date.slice(0, 7) === sp.rows[0][1]).reduce((s, x) => s - (x.value ?? x.amount), 0);
  assert.equal(sp.rows.at(-1)[0], 'All spending');
  assert.equal(Math.round(sp.rows.at(-1)[1] * 100), Math.round(spent * 100), 'newest month total matches');
});

test('the Excel copy can be imported back (its columns are recognised)', async () => {
  const d = imp.upload(await workbook(), 'pennystead.xlsx');
  assert.ok(d.mapping.date != null && d.mapping.amount != null, 'date and amount columns found');
});

test('backups can also write an Excel copy beside each .bak, keeping the same number', async () => {
  const bk = path.join(dir, 'bk-excel'), c = loadConfig();
  c.backup.local.dir = bk; c.backup.keep = 2; c.backup.local.excel = true; saveConfig(c);
  for (let i = 0; i < 3; i++) { await b.runBackup({ force: true }); await new Promise((r) => setTimeout(r, 15)); }
  const files = fs.readdirSync(bk);
  assert.equal(files.filter((f) => f.endsWith('.xlsx')).length, 2);
  assert.equal(files.filter((f) => /\.bak/.test(f)).length, 2);
  const newest = files.filter((f) => f.endsWith('.xlsx')).sort().pop();
  assert.ok(files.includes(newest.replace('.xlsx', '.bak')), 'named like its backup');
  assert.equal(readXlsx(fs.readFileSync(path.join(bk, newest))).sheets[0].name, 'Transactions');
  assert.ok(!b.listLocal().some((x) => x.name.endsWith('.xlsx')), 'not offered as something to restore');
});
