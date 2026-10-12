const { fixture } = require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const { _t: t, upload, preview } = require('../lib/importer');
const { readXlsx } = require('../lib/xlsx');

test('numbers', () => {
  for (const [v, d, want] of [['1,234.56', '.', 1234.56], ['1.234,56', ',', 1234.56], ['-12,50', ',', -12.5], ['(12.50)', '.', -12.5], ['12.50-', '.', -12.5], ['€ 1 234,50', ',', 1234.5], ['+3,400.00', '.', 3400], ['−45,10', ',', -45.1], ['abc', '.', null], ['', ',', null], [12.5, '.', 12.5], ['1 234,56', ',', 1234.56], ['USD 99.99', '.', 99.99]])
    assert.equal(t.parseNumber(v, d), want, String(v));
});
test('decimal separator detection', () => {
  assert.equal(t.detectDecimal(['12,50', '1.234,56', '-3,00', '100']), ','); assert.equal(t.detectDecimal(['12.50', '1,234.56', '-3.00']), '.');
  assert.equal(t.detectDecimal(['100', '2000', '35']), '.'); assert.equal(t.detectDecimal(['1,234', '2,500', '12.50']), '.'); assert.equal(t.detectDecimal(['1.234', '2.500', '12,50']), ',');
});
test('dates', () => {
  for (const [v, o, want] of [['2025-03-04', 'DMY', '2025-03-04'], ['04.03.2025', 'DMY', '2025-03-04'], ['03/04/2025', 'MDY', '2025-03-04'], ['3/4/25', 'MDY', '2025-03-04'], ['4 Mar 2025', 'DMY', '2025-03-04'], ['March 4, 2025', 'DMY', '2025-03-04'], ['20250304', 'DMY', '2025-03-04'], ['2025-03-04T10:22:00Z', 'DMY', '2025-03-04'], ['31.02.2025', 'DMY', null], ['garbage', 'DMY', null], [45720, 'DMY', '2025-03-04'], ['04-Mar-25', 'DMY', '2025-03-04'], ['2025/03/04 12:00', 'DMY', '2025-03-04']])
    assert.equal(t.parseDate(v, o), want, String(v));
  assert.equal(t.detectDateOrder(['13/01/2025', '02/02/2025']), 'DMY'); assert.equal(t.detectDateOrder(['01/13/2025', '02/02/2025']), 'MDY');
});
test('delimiters, quoting and encodings', () => {
  assert.equal(t.detectDelimiter('a;b;c\n1;2,5;3\n4;5,5;6'), ';'); assert.equal(t.detectDelimiter('a,b,c\n1,2.5,3'), ','); assert.equal(t.detectDelimiter('a\tb\tc\n1\t2\t3'), '\t');
  assert.equal(t.detectDelimiter('Date;Desc;Amt\n1;"Shop, Inc.";5,00\n2;"A, B, C";7,00'), ';');
  assert.deepEqual(t.parseCsv('a,"b,""x""",c\n1,"two\nlines",3\r\n4,5,6', ','), [['a', 'b,"x"', 'c'], ['1', 'two\nlines', '3'], ['4', '5', '6']]);
  assert.equal(t.decode(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Päivä')])).text, 'Päivä');
  assert.equal(t.decode(Buffer.from([0x4d, 0xe4, 0x6e, 0x74, 0x74, 0xe4])).text, 'Mänttä'); assert.equal(t.decode(Buffer.from([0xe4])).encoding, 'Windows-1252');
  assert.equal(t.decode(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Date;Amount', 'utf16le')])).text, 'Date;Amount');
});

// Each real-world export style must map itself and produce these exact totals with no manual help.
const CASES = { 'fi.csv': { in: 3400, out: 1291.6, end: 8765.5, n: 4 }, 'us.csv': { in: 3400, out: 182.13, n: 4 }, 'uk.csv': { in: 2500, out: 973.4, end: 2750, n: 3, mode: 'split' }, 'dir.csv': { in: 3400, out: 35.49, n: 3, err: 1, mode: 'dir' }, 'excel.xlsx': { in: 3400, out: 192.79, n: 4 }, 'excel_text.xlsx': { in: 3400, out: 31.2, n: 2 } };
for (const [file, w] of Object.entries(CASES)) test(`auto-mapping: ${file}`, () => {
  const d = upload(fixture(file), file), p = preview(d.importId, d.mapping, { name: 'T ' + file, currency: 'EUR' }, { useCategory: true });
  assert.equal(p.totals.in, w.in); assert.equal(p.totals.out, w.out); assert.equal(p.counts.toImport, w.n); assert.equal(p.counts.errors, w.err || 0);
  if (w.end !== undefined) assert.equal(p.endBalance, w.end); if (w.mode) assert.equal(d.mapping.mode, w.mode);
});
test('preamble above the header, decimal comma, Windows-1252 accents (Finnish export)', () => {
  const d = upload(fixture('fi.csv'), 'fi.csv');
  assert.equal(d.encoding, 'Windows-1252'); assert.equal(d.delimiter, ';'); assert.equal(d.headerRow, 4); assert.equal(d.headers[d.mapping.date], 'Kirjauspäivä');
  assert.ok(preview(d.importId, d.mapping, { name: 'x', currency: 'EUR' }, {}).sample.some((r) => r.desc === 'Kahvila Äpy'));
});
test('a "Type" column that is not a direction (Sale/Payment) is not mistaken for one', () => { const d = upload(fixture('us.csv'), 'us.csv'); assert.equal(d.mapping.mode, 'single'); assert.equal(d.mapping.direction, null); });
test('Excel reader: sheets, date cells, text cells', () => {
  const b = readXlsx(fixture('excel.xlsx')); assert.deepEqual(b.sheets.map((s) => s.name), ['Transactions', 'Summary']);
  const rows = b.sheets[0].rows; assert.equal(rows[3][0], 'Date'); assert.equal(rows[4][0], '2024-04-10'); assert.equal(rows[4][2], -54.3);
});
test('bad input is rejected with a helpful message', () => {
  const bad = (buf, name, re) => assert.throws(() => upload(buf, name), re);
  bad(Buffer.alloc(0), 'x.csv', /empty/); bad(Buffer.from('Date,Payee,Amount\n'), 'x.csv', /No data rows/); bad(Buffer.from('PK-not-really'), 'x.xlsx', /xlsx|zip|valid/i);
  bad(Buffer.from('not a spreadsheet'), 'old.xls', /\.xls/); bad(require('node:crypto').randomBytes(500), 'x.csv', /binary/);
  assert.equal(upload(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Date\tPayee\tAmount\n2024-05-01\tShop\t-5.00\n', 'utf16le')]), 'u16.csv').delimiter, '\t');
});
