// Minimal, dependency-free .xlsx reader (a zip of XML files). Reads values only, no formulas or styles beyond date detection.
const zlib = require('zlib');

const MAX_ENTRY = 200 * 1024 * 1024;
const u16 = (b, o) => b.readUInt16LE(o), u32 = (b, o) => b.readUInt32LE(o);

function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (u32(buf, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a valid .xlsx file (zip structure not found).');
  const count = u16(buf, eocd + 10);
  let p = u32(buf, eocd + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    if (u32(buf, p) !== 0x02014b50) throw new Error('Corrupt .xlsx file.');
    const method = u16(buf, p + 10), csize = u32(buf, p + 20), usize = u32(buf, p + 24), nl = u16(buf, p + 28), el = u16(buf, p + 30), cl = u16(buf, p + 32), lho = u32(buf, p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    p += 46 + nl + el + cl;
    if (usize > MAX_ENTRY) throw new Error('File inside the spreadsheet is too large.');
    const ds = lho + 30 + u16(buf, lho + 26) + u16(buf, lho + 28), raw = buf.subarray(ds, ds + csize);
    files[name] = { method, raw };
  }
  return (name) => {
    const f = files[name];
    if (!f) return null;
    if (f.method === 0) return f.raw;
    if (f.method === 8) return zlib.inflateRawSync(f.raw, { maxOutputLength: MAX_ENTRY });
    throw new Error('Unsupported compression in .xlsx.');
  };
}

const ent = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()] ?? (e[1] === 'x' || e[1] === 'X' ? String.fromCodePoint(parseInt(e.slice(2), 16)) : String.fromCodePoint(+e.slice(1)))));
const attrs = (s) => Object.fromEntries([...s.matchAll(/([\w:]+)="([^"]*)"/g)].map((m) => [m[1], ent(m[2])]));
const texts = (xml) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => ent(m[1])).join('');
const colIndex = (ref) => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };

const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const isDateCode = (c) => /[yd]/i.test(c.replace(/"[^"]*"|\[[^\]]*\]|\\./g, ''));

function serialToISO(n, date1904) {
  const d = new Date(Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 30) + Math.floor(n) * 864e5);
  return d.toISOString().slice(0, 10);
}

/** Returns { sheets: [{ name, rows: (string|number|null)[][] }] }. Date-formatted cells come back as 'YYYY-MM-DD' strings. */
function readXlsx(buf) {
  const get = unzip(buf), text = (n) => { const b = get(n); return b ? b.toString('utf8') : null; };
  const wb = text('xl/workbook.xml');
  if (!wb) throw new Error('This does not look like an Excel (.xlsx) workbook.');
  const date1904 = /<workbookPr[^>]*date1904="(1|true)"/i.test(wb);
  const rels = Object.fromEntries([...(text('xl/_rels/workbook.xml.rels') || '').matchAll(/<Relationship\b([^>]*)\/?>/g)].map((m) => { const a = attrs(m[1]); return [a.Id, a.Target]; }));
  const shared = [...(text('xl/sharedStrings.xml') || '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]));

  const styles = text('xl/styles.xml') || '';
  const custom = Object.fromEntries([...styles.matchAll(/<numFmt\b([^>]*)\/?>/g)].map((m) => { const a = attrs(m[1]); return [a.numFmtId, a.formatCode]; }));
  const xfs = (styles.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/) || [, ''])[1];
  const dateStyle = [...xfs.matchAll(/<xf\b([^>]*)/g)].map((m) => { const id = attrs(m[1]).numFmtId; return BUILTIN_DATE.has(+id) || (custom[id] != null && isDateCode(custom[id])); });

  const sheets = [];
  for (const m of wb.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const a = attrs(m[1]); let target = rels[a['r:id']];
    if (!target) continue;
    target = target.startsWith('/') ? target.slice(1) : 'xl/' + target;
    const xml = text(target);
    if (!xml) continue;
    const rows = [];
    for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const ra = attrs(rm[1]), r = (+ra.r || rows.length + 1) - 1, row = (rows[r] ??= []);
      for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ca = attrs(cm[1]), body = cm[2] || '', v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        let val = null;
        if (ca.t === 's') val = v != null ? shared[+v] ?? null : null;
        else if (ca.t === 'inlineStr') val = texts(body);
        else if (ca.t === 'str' || ca.t === 'e') val = v != null ? ent(v) : null;
        else if (ca.t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
        else if (ca.t === 'd') val = v ? v.slice(0, 10) : null;
        else if (v != null && v !== '') { const n = parseFloat(v); val = dateStyle[+ca.s] && Number.isFinite(n) ? serialToISO(n, date1904) : n; }
        row[ca.r ? colIndex(ca.r) : row.length] = val;
      }
    }
    sheets.push({ name: a.name, rows: Array.from(rows, (r) => r || []) });
  }
  if (!sheets.length) throw new Error('No sheets found in the workbook.');
  return { sheets };
}

module.exports = { readXlsx, serialToISO };
