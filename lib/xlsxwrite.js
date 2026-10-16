// Minimal, dependency-free .xlsx writer: a zip of a few XML files. Text, numbers, dates and money; a bold header row
// that stays visible while scrolling, filter buttons, column widths. Text is stored as text, never as a formula.
const zlib = require('zlib');

const esc = (s) => String(s).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').slice(0, 32767);
const col = (i) => { let s = ''; for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };
const serial = (iso) => (Date.parse(iso.slice(0, 10) + 'T00:00:00Z') - Date.UTC(1899, 11, 30)) / 864e5;
const STYLE = { text: 0, date: 1, money: 2, header: 3, number: 0 };

function cell(v, type, ref) {
  if (v == null || v === '') return '';
  if (type === 'date' && /^\d{4}-\d{2}-\d{2}/.test(v)) return `<c r="${ref}" s="${STYLE.date}"><v>${serial(v)}</v></c>`;
  if ((type === 'money' || type === 'number') && Number.isFinite(+v)) return `<c r="${ref}" s="${STYLE[type]}"><v>${+v}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
}

function sheetXml({ columns, rows }) {
  const head = `<row r="1">${columns.map((c, i) => `<c r="${col(i)}1" t="inlineStr" s="${STYLE.header}"><is><t>${esc(c.header)}</t></is></c>`).join('')}</row>`;
  const body = rows.map((r, y) => `<row r="${y + 2}">${columns.map((c, x) => cell(r[x], c.type, col(x) + (y + 2))).join('')}</row>`).join('');
  const last = `${col(columns.length - 1)}${rows.length + 1}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || (c.type === 'date' ? 12 : c.type === 'money' ? 14 : 24)}" customWidth="1"/>`).join('')}</cols>
<sheetData>${head}${body}</sheetData>${rows.length ? `<autoFilter ref="A1:${last}"/>` : ''}</worksheet>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

/** sheets: [{ name, columns: [{ header, type: text|date|money|number, width? }], rows: [[...]] }] → Buffer (.xlsx) */
function writeXlsx(sheets) {
  const names = sheets.map((s, i) => esc(String(s.name).replace(/[[\]:*?/\\]/g, ' ').slice(0, 31) || `Sheet${i + 1}`));
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`,
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>${(() => { const d = sheets.map((s, i) => (s.rows.length ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${names[i].replace(/'/g, "''")}'!$A$1:$${col(s.columns.length - 1)}$${s.rows.length + 1}</definedName>` : '')).join(''); return d ? `<definedNames>${d}</definedNames>` : ''; })()}</workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': STYLES,
  };
  sheets.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(s); });
  return zip(files);
}

function zip(files) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8'), packed = zlib.deflateRawSync(data), nameBuf = Buffer.from(name, 'utf8'), crc = zlib.crc32(data);
    const h = Buffer.alloc(30); // local file header
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8); h.writeUInt16LE(0, 10); h.writeUInt16LE(0x21, 12);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(packed.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nameBuf.length, 26); h.writeUInt16LE(0, 28);
    const c = Buffer.alloc(46); // central directory entry
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10); c.writeUInt16LE(0, 12); c.writeUInt16LE(0x21, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(packed.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE(offset, 42);
    local.push(h, nameBuf, packed); central.push(c, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

module.exports = { writeXlsx };
