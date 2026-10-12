// Regression tests for bugs found in the October 2026 bug hunt. Each test pins one confirmed bug.
const { dir } = require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const ledger = require('../lib/ledger'), core = require('../lib/core'), A = require('../lib/analysis');
const manual = require('../lib/manual'), store = require('../lib/store'), backup = require('../lib/backup');
const { paths, saveConfig, loadConfig } = require('../lib/config');
const { readXlsx } = require('../lib/xlsx');
const imp = require('../lib/importer'), { _t } = imp;

const config = (o) => saveConfig({ ...loadConfig(), base: 'EUR', holdings: [], cash: [], budgets: {}, ...o });
const setPrices = (...l) => fs.writeFileSync(paths.prices, l.join('\n') + '\n');
const tx = (o) => ({ id: o.id || Math.random().toString(36).slice(2), desc: 'X', merchant: 'x', account: 'assets:bank:a', category: 'expenses:shopping', cur: 'EUR', ...o });
test.beforeEach(() => { setPrices(); fs.writeFileSync(paths.manualAssets, JSON.stringify({ assets: [] })); config({}); store.saveTxs({}); store.saveAccounts({}); });

// ---------- money math ----------
test('two lots of one holding add up their costs', () => {
  config({ base: 'USD', holdings: [{ symbol: 'AAPL', qty: 10, cost: 1000, currency: 'USD', since: '2024-01-01' }, { symbol: 'AAPL', qty: 10, cost: 2000, currency: 'USD', since: '2025-01-01' }] });
  setPrices('P 2026-01-01 AAPL 200 USD');
  assert.deepEqual(ledger.costBasis(ledger.build(), 'USD', '2026-10-01'), { 'assets:investments:aapl': 3000 });
});
test('a declared price wins over an older reversed one, whatever the file order', () => {
  const conv = ledger.priceBook([{ date: '2024-01-01', from: 'EUR', to: 'USD', rate: 1.1 }, { date: '2026-01-01', from: 'USD', to: 'EUR', rate: 0.7 }]);
  assert.equal(conv(1000, 'USD', 'EUR', '2026-10-01'), 700);
});
test('a manual asset named like a currency does not become that currency', () => {
  config({ cash: [{ currency: 'USD', amount: 1500, since: '2026-01-01' }] });
  setPrices('P 2026-09-01 USD 0.86 EUR');
  manual.create({ name: 'USD', type: 'savings', currency: 'EUR', value: 1000, date: '2026-10-01' }, 'EUR');
  const rows = ledger.balances(ledger.build(), ['assets'], { value: { target: 'EUR', date: '2026-10-12' } });
  assert.deepEqual(rows.find((r) => r.account === 'assets:cash:usd').amounts, { EUR: 1290 });
});
test('spending in another currency is converted before it is added up', async () => {
  const m = core.today().slice(0, 7);
  setPrices(`P ${m}-01 JPY 0.0061 EUR`);
  store.saveTxs({ a: { acct: 'assets:bank:eur', date: `${m}-01`, amount: -50, cur: 'EUR', desc: 'ZALANDO', text: 'ZALANDO' }, b: { acct: 'assets:bank:jpy', date: `${m}-01`, amount: -15000, cur: 'JPY', desc: 'AMAZON JP', text: 'AMAZON JP' } });
  const txs = await core.transactions();
  assert.equal(A.monthly(txs).at(-1).spend, 141.5);
  assert.equal(txs.find((t) => t.cur === 'JPY').amount, -15000, 'the transaction itself keeps its own amount and currency');
});
test('budgets: spent exactly equals the budget is not "over"; zero budgets give no NaN; early month is not "on track to exceed"', () => {
  const b = (txs, map, today, month) => A.budgets(txs.map(tx), map, today, month);
  // A finished month, so nothing is projected: 0.01 + 64.15 + 35.84 is exactly the budget.
  const exact = b([{ date: '2026-10-05', amount: -0.01 }, { date: '2026-10-05', amount: -64.15 }, { date: '2026-10-05', amount: -35.84 }], { 'expenses:shopping': 100 }, '2026-11-05', '2026-10')[0];
  assert.equal(exact.status, 'warn'); assert.ok(Object.is(exact.remaining, 0));
  const zero = b([{ date: '2026-10-05', amount: -10 }], { 'expenses:shopping': 0, 'expenses:food': 0 }, '2026-10-20');
  for (const z of zero) assert.ok(Number.isFinite(z.pct), JSON.stringify(z));
  assert.equal(b([{ date: '2026-10-01', amount: -40 }], { 'expenses:shopping': 450 }, '2026-10-01')[0].status, 'ok');
});
test('a refunded purchase is not a spending spike', () => {
  const hist = ['2026-07', '2026-08', '2026-09'].map((mo, i) => tx({ date: `${mo}-10`, amount: -60, id: 'h' + i }));
  const old = tx({ date: '2026-01-02', amount: -5, category: 'expenses:food', id: 'o' });
  const now = [tx({ date: '2026-10-02', amount: -600 }), tx({ date: '2026-10-03', amount: 600 }), tx({ date: '2026-10-04', amount: -60 })];
  const all = [old, ...hist, ...now];
  assert.deepEqual(A.anomalies(all, A.subscriptions(all, '2026-10-12'), '2026-10-12').filter((a) => a.type === 'category_spike'), []);
});
test('subscriptions: next charge on the same day of the month; yearly cost is 12 × monthly', () => {
  const s = A.subscriptions(['2026-05-15', '2026-06-15', '2026-07-15', '2026-08-15'].map((date, i) => tx({ date, amount: -10, desc: 'NETFLIX', merchant: 'netflix', category: 'expenses:subscriptions:streaming', id: 'n' + i })), '2026-08-20').active[0];
  assert.equal(s.nextExpected, '2026-09-15'); assert.equal(s.perYear, 120); assert.equal(s.perMonth, 10);
});
test('"today" is the local calendar date', () => {
  const { localDate } = require('../lib/dates');
  assert.equal(localDate(new Date(2026, 10, 1, 0, 30)), '2026-11-01'); // 00:30 local on Nov 1, whatever the UTC date is
});

// ---------- import ----------
test('amount signs survive currency symbols, codes, Unicode minus and DR/CR', () => {
  assert.equal(_t.parseNumber('€-12.50'), -12.5); assert.equal(_t.parseNumber('EUR -12,50', ','), -12.5); assert.equal(_t.parseNumber('$-1,234.10'), -1234.1);
  assert.equal(_t.parseNumber('12.50−'), -12.5); assert.equal(_t.parseNumber('12.50 DR'), -12.5); assert.equal(_t.parseNumber('100.00 CR'), 100);
  assert.equal(_t.parseNumber('1 234,56', ','), 1234.56); assert.equal(_t.parseNumber('(12.50)'), -12.5);
});
test('three-decimal amounts are not read as thousands', () => {
  assert.equal(_t.detectDecimal(['0.125', '1234.567']), '.');
  assert.equal(_t.detectDecimal(['-12.500', '250.000', '-3.750'], 'KWD'), '.');
  assert.equal(_t.detectDecimal(['1.234', '12,50']), ',', 'a German file still reads 1.234 as one thousand');
});
test('dates no day decides: the reading that keeps the statement together wins', () => {
  assert.equal(_t.detectDateOrder(['10/01/2026', '10/02/2026', '10/05/2026', '10/09/2026']), 'MDY');
  assert.equal(_t.detectDateOrder(['01/10/2026', '02/10/2026', '05/10/2026']), 'DMY');
});
test('direction words are whole words: a Deposit is money in', () => {
  const d = imp.upload(Buffer.from('Date,Type,Amount,Payee\n2024-01-05,Deposit,1500.00,Paycheck\n2024-01-06,Debit,40.00,ATM\n'), 'dir.csv');
  const p = imp.preview(d.importId, d.mapping, { name: 'Dir test', currency: 'EUR' }, {});
  assert.deepEqual(p.sample.map((r) => r.amount), [1500, -40]);
});
test('a file without a header row keeps its first transaction; a header-only file is still "no data"', () => {
  const d = imp.upload(Buffer.from('"01/05/2024","-12.50","*","","SHOP ONE"\n"01/06/2024","-3.00","*","","SHOP TWO"\n"01/07/2024","-4.00","*","","SHOP THREE"\n'), 'wf.csv');
  assert.equal(d.rowCount, 3); assert.equal(d.headerRow, 0);
  assert.throws(() => imp.upload(Buffer.from('Date,Payee,Amount\n'), 'x.csv'), /No data rows/);
});
test('semicolon files with commas in the text, and text files that start with "PK"', () => {
  assert.equal(_t.detectDelimiter('Datum;Betrag;Text\n01.02.2024;-12,50;Rewe, Berlin, DE\n02.02.2024;-3,10;Aldi, Köln, DE\n'), ';');
  assert.equal(imp.upload(Buffer.from('PKO BP export\nDate,Amount,Payee\n2024-01-05,-1.00,Shop\n2024-01-06,-2.00,Shop\n'), 'pko.csv').kind, 'csv');
});
test('duplicates: different merchants in non-Latin scripts are not the same', () => {
  store.saveAccounts({ 'import-ru': { name: 'ru', label: 'RU', currency: 'RUB', imported: true } });
  store.saveTxs({ a: { acct: 'assets:bank:ru', date: '2024-02-01', amount: -12, cur: 'RUB', desc: 'Пятёрочка', text: 'Пятёрочка' } });
  const d = imp.upload(Buffer.from('Date,Payee,Amount\n2024-02-01,Магнит,-12.00\n2024-02-02,Магнит,-5.00\n'), 'ru.csv');
  assert.equal(imp.preview(d.importId, d.mapping, { uid: 'import-ru' }, {}).sample[0].status, 'possible_duplicate');
});
test('a month imported between two anchored statements keeps the anchored balance', () => {
  const up = (csv, name) => { const d = imp.upload(Buffer.from(csv), name); return imp.commit(d.importId, d.mapping, { name: 'Gap', currency: 'EUR' }, {}); };
  up('Date,Payee,Amount,Balance\n2024-01-05,A,-100,1150\n2024-01-20,B,-50,1100\n', 'jan.csv');
  up('Date,Payee,Amount,Balance\n2024-03-05,E,-25,1025\n2024-03-10,F,-25,1000\n', 'mar.csv');
  up('Date,Payee,Amount,Balance\n2024-02-05,C,-30,1070\n2024-02-20,D,-20,1050\n', 'feb.csv');
  const meta = Object.values(store.accounts()).find((a) => a.label === 'Gap');
  const bal = meta.opening.amount + Object.values(store.txs()).filter((t) => t.acct === 'assets:bank:' + meta.name).reduce((s, t) => s + t.amount, 0);
  assert.equal(Math.round(bal * 100) / 100, 1000);
});

// ---------- xlsx ----------
function zip(files) { // stored (uncompressed) zip, enough for the reader
  const parts = [], central = []; let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const n = Buffer.from(name), d = Buffer.from(text), h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt32LE(d.length, 18); h.writeUInt32LE(d.length, 22); h.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt32LE(d.length, 20); c.writeUInt32LE(d.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    parts.push(h, n, d); central.push(c, n); off += 30 + n.length + d.length;
  }
  const cd = Buffer.concat(central), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(Object.keys(files).length, 8); e.writeUInt16LE(Object.keys(files).length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, e]);
}
test('xlsx: namespace prefixes, single-quoted attributes, empty rich-text runs, _x000D_ escapes, 1904 dates', () => {
  const book = (sheet, wbExtra = '') => readXlsx(zip({ 'xl/workbook.xml': `<x:workbook xmlns:x="m"${wbExtra}><x:sheets><x:sheet name='S' r:id='r1'/></x:sheets></x:workbook>`, 'xl/_rels/workbook.xml.rels': `<Relationships><Relationship Id='r1' Target='worksheets/s.xml'/></Relationships>`, 'xl/worksheets/s.xml': sheet }));
  const r = book(`<x:worksheet><x:sheetData><x:row r='1'><x:c r='A1' t='inlineStr'><x:is><x:t>Date</x:t></x:is></x:c><x:c r='C1' t='inlineStr'><x:is><x:r><x:t xml:space="preserve"/></x:r><x:r><x:t>Shop_x000D_</x:t></x:r></x:is></x:c></x:row></x:sheetData></x:worksheet>`).sheets[0].rows;
  assert.equal(r[0][0], 'Date'); assert.equal(r[0][1], undefined, 'column B is empty: C1 lands in column C'); assert.equal(r[0][2], 'Shop\r');
  const b1904 = readXlsx(zip({ 'xl/workbook.xml': '<workbook><workbookPr date1904="1"/><sheets><sheet name="S" r:id="r1"/></sheets></workbook>', 'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Target="worksheets/s.xml"/></Relationships>', 'xl/worksheets/s.xml': '<worksheet><sheetData><row r="1"><c r="A1"><v>43831</v></c></row></sheetData></worksheet>' }));
  assert.equal(b1904.date1904, true); assert.equal(_t.parseDate(43831, 'DMY', true), '2024-01-02');
});

// ---------- backup ----------
test('restore refuses credential files in any letter case, folder names, and gzip bombs', () => {
  const bundle = (files) => zlib.gzipSync(Buffer.from(JSON.stringify({ app: 'pennystead', v: 1, files })));
  for (const n of ['AUTH.JSON', 'Auth.json', 'auth.json.', 'SECRETS.JSON', 'backups']) assert.throws(() => backup.unpack(bundle({ [n]: 'eA==' })), /unexpected file name/, n);
  const bomb = zlib.gzipSync(Buffer.alloc(600 * 1024 * 1024));
  assert.throws(() => backup.unpack(bomb), /Not a valid Pennystead backup/);
});
test('two backups started together run once', async () => {
  config({ backup: { ...loadConfig().backup, interval: 'on-change', local: { enabled: true, dir: path.join(dir, 'bk') } } });
  const [a, b] = await Promise.all([backup.runBackup(), backup.runBackup()]);
  assert.equal(a, b);
  assert.equal(fs.readdirSync(path.join(dir, 'bk')).filter((n) => n.endsWith('.bak')).length, 1);
});

// ---------- MCP privacy ----------
test('MCP redaction masks spaced and lowercase IBANs and grouped card numbers, but not dates or amounts', () => {
  const { execFileSync } = require('node:child_process');
  const out = execFileSync(process.execPath, ['-e', `const {redact}=require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'redact'))});console.log(JSON.stringify(['Ref DE89 3704 0044 0532 0130 00','from de89370400440532013000','Card 4111 1111 1111 1111','on 2024-03-05 paid 1 234,56'].map((d)=>redact({desc:d}).desc)))`], { env: { ...process.env, REDACT: 'light' } });
  const [a, b, c, d] = JSON.parse(out);
  assert.ok(!/0532|370400440532/.test(a + b), a + ' ' + b); assert.ok(!c.includes('4111 1111'), c); assert.equal(d, 'on 2024-03-05 paid 1 234,56');
});
