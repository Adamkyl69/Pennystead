// Import historical transactions from CSV / Excel: parse, auto-map columns, preview, commit, undo.
const fs = require('fs');
const crypto = require('crypto');
const { paths, loadConfig, writeAtomic } = require('./config');
const { readXlsx, serialToISO } = require('./xlsx');
const store = require('./store');
const J = require('./journal');

const MAX_BYTES = 30 * 1024 * 1024, MAX_ROWS = 300000, TTL = 30 * 60 * 1000;
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');
const r2 = (n) => Math.round(n * 100) / 100;
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => iso(new Date(Date.parse(s) + n * 864e5));
const readJSON = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d);

// ---------- CSV ----------
function decode(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: buf.toString('utf8', 3), encoding: 'UTF-8' };
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: buf.toString('utf16le', 2), encoding: 'UTF-16' };
  if (buf[0] === 0xfe && buf[1] === 0xff) { const b = Buffer.from(buf.subarray(2, buf.length - ((buf.length - 2) % 2))); b.swap16(); return { text: b.toString('utf16le'), encoding: 'UTF-16' }; }
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'UTF-8' }; }
  catch { return { text: new TextDecoder('windows-1252').decode(buf), encoding: 'Windows-1252' }; }
}
function detectDelimiter(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 30);
  let best = ',', bestScore = -1;
  for (const d of [',', ';', '\t', '|']) {
    const counts = lines.map((l) => { let n = 0, q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === d && !q) n++; } return n; });
    const freq = {}; counts.forEach((c) => (freq[c] = (freq[c] || 0) + 1));
    const [mode, times] = Object.entries(freq).sort((a, b) => b[1] - a[1] || b[0] - a[0])[0] || [0, 0];
    let score = +mode > 0 ? times * Math.min(+mode, 6) : 0;
    // The header decides when data rows disagree: "Datum;Betrag;Text" with "Rewe, Berlin, DE" in the text is
    // semicolon-separated, even though the unquoted commas outnumber the semicolons.
    const first = counts.findIndex((_, i) => /[,;\t|]/.test(lines[i]));
    if (first >= 0 && counts[first] !== +mode) score /= 2;
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}
function parseCsv(text, delim) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"' && f === '') q = true;
    else if (c === delim) { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; if (rows.length > MAX_ROWS) throw new Error('File has too many rows.'); }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}

// ---------- table: header row + data rows ----------
const isNum = (s) => s !== '' && s != null && /^[\s\d.,+\-()€$£]+$/.test(String(s)) && /\d/.test(String(s));
const isDateLike = (s) => /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/.test(String(s).trim());
function detectHeaderRow(rows) {
  const lim = Math.min(rows.length, 40), cnt = (r) => (r || []).filter((c) => c !== '' && c != null).length;
  const width = Math.max(0, ...rows.slice(0, lim).map(cnt));
  for (let i = 0; i < lim; i++) {
    const r = rows[i] || [], n = cnt(r);
    if (n < Math.min(2, width) || n < width * 0.6) continue;
    const textual = r.filter((c) => c !== '' && c != null && !isNum(c) && !isDateLike(c) && typeof c !== 'number').length;
    if (textual >= n * 0.6 && cnt(rows[i + 1]) >= width * 0.5) return i;
  }
  // A lone all-text row (a header with no data under it) is still a header, not a transaction.
  for (let i = 0; i < lim; i++) { const r = rows[i] || [], n = cnt(r); if (n >= Math.min(2, width) && r.every((c) => c === '' || c == null || (!isNum(c) && !isDateLike(c) && typeof c !== 'number'))) return i; }
  return -1; // no header row: every row is data (columns are named "Column 1", "Column 2"...)
}
function buildTable(rows, headerRow) {
  const hdr = rows[headerRow] || [], width = Math.max(hdr.length, ...rows.slice(headerRow + 1, headerRow + 200).map((r) => (r || []).length), 1);
  const seen = {}, headers = Array.from({ length: width }, (_, i) => {
    let h = String(hdr[i] ?? '').trim() || `Column ${i + 1}`;
    if (seen[h]) h = `${h} (${++seen[h]})`; else seen[h] = 1;
    return h;
  });
  const data = [];
  for (let i = headerRow + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    if (!r.some((c) => c !== '' && c != null)) continue;
    data.push({ line: i + 1, cells: Array.from({ length: width }, (_, j) => (r[j] == null ? '' : typeof r[j] === 'string' ? r[j].trim() : r[j])) });
  }
  return { headers, data };
}

// ---------- values ----------
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
// Currencies with 3 minor digits, where "12.500" is twelve and a half, not twelve thousand five hundred.
const THREE_DECIMALS = new Set(['KWD', 'BHD', 'OMR', 'JOD', 'TND', 'LYD', 'IQD']);
function detectDecimal(samples, cur = '') { return detectDecimalInfo(samples, cur).decimal; }
/** { decimal, ambiguous }: ambiguous when the only evidence was values like "12.500" (twelve and a half, or 12,500?). */
function detectDecimalInfo(samples, cur = '') {
  let dot = 0, comma = 0, weak = 0;
  for (const v of samples) {
    if (typeof v === 'number' || v === '') continue;
    const s = String(v).replace(/[^\d.,]/g, '');
    const ld = s.lastIndexOf('.'), lc = s.lastIndexOf(',');
    if (ld >= 0 && lc >= 0) { if (ld > lc) dot++; else comma++; }
    else if (lc >= 0) { // only commas: 1,234,567 or 1,234 → thousands (dot is the decimal); 12,5 / 12,50 → decimal comma
      if ((s.match(/,/g) || []).length > 1 || s.length - lc - 1 === 3) dot++; else comma++;
    } else if (ld >= 0) { // only dots: 1.234.567 or 1.234 → thousands (comma is the decimal); 12.5 / 12.50 → decimal dot
      // "0.125" and "1234.567" cannot be thousands groups; "12.500" can, unless the currency has 3 decimals.
      const lead = s.slice(0, ld), threeDec = s.length - ld - 1 === 3 && lead !== '' && !/^0+$/.test(lead) && lead.length <= 3 && !THREE_DECIMALS.has(cur);
      if ((s.match(/\./g) || []).length > 1) comma++; else if (threeDec) { comma++; weak++; } else dot++;
    }
  }
  return { decimal: comma > dot ? ',' : '.', ambiguous: weak > 0 && comma === weak && dot === 0 };
}
function parseNumber(v, dec = '.') {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v == null) return null;
  let s = String(v).trim();
  if (!s) return null;
  let neg = false;
  // A trailing DR/DB means money out; CR means money in.
  const dc = s.match(/\s*\b(DR|DB|CR)\.?$/i);
  if (dc) { neg = /^d/i.test(dc[1]); s = s.slice(0, dc.index).trim(); }
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  // Drop currency symbols and codes first ("€-12.50", "EUR -12,50", "$-1,234.10"), then read the sign at either end.
  s = s.replace(/[^\d.,'\s+\-−–]/g, '').trim();
  if (/^[-−–]/.test(s) || /[-−–]$/.test(s)) neg = true;
  s = s.replace(/[^\d.,]/g, '');
  if (!/\d/.test(s)) return null;
  s = dec === ',' ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}
function detectDateOrder(samples) { return detectDateOrderInfo(samples).order; }
/** { order, ambiguous }: ambiguous when no date had a day above 12, so both readings were possible. */
function detectDateOrderInfo(samples) {
  let dmy = 0, mdy = 0, either = 0;
  for (const v of samples) {
    const m = typeof v === 'string' && v.trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
    if (!m) continue;
    if (+m[1] > 12) dmy++; else if (+m[2] > 12) mdy++; else if (m[1] !== m[2]) either++;
  }
  if (mdy !== dmy) return { order: mdy > dmy ? 'MDY' : 'DMY', ambiguous: false };
  // Nothing decides it (every day is 12 or less, e.g. 10/01 … 10/09): choose the reading whose dates sit closest
  // together, since a statement covers a short, contiguous period.
  const span = (order) => { const t = samples.map((v) => parseDate(v, order)).filter(Boolean).map(Date.parse); return t.length ? Math.max(...t) - Math.min(...t) : Infinity; };
  return { order: span('MDY') < span('DMY') ? 'MDY' : 'DMY', ambiguous: either > 0 };
}
function parseDate(v, order = 'DMY', date1904 = false) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v > 18000 && v < 80000 ? serialToISO(v, date1904) : null;
  const s = String(v).trim();
  let y, m, d, x;
  if ((x = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/))) [y, m, d] = [+x[1], +x[2], +x[3]];
  else if ((x = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?!\d)/))) { const [a, b] = [+x[1], +x[2]]; [d, m] = order === 'MDY' ? [b, a] : [a, b]; y = +x[3]; if (x[3].length === 2) y += y < 70 ? 2000 : 1900; }
  else if ((x = s.match(/^(\d{1,2})[\s.-]+([A-Za-z]{3,9})\.?,?[\s.-]+(\d{2,4})/))) { m = MONTHS[x[2].slice(0, 3).toLowerCase()]; d = +x[1]; y = +x[3]; if (x[3].length === 2) y += y < 70 ? 2000 : 1900; }
  else if ((x = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/))) { m = MONTHS[x[1].slice(0, 3).toLowerCase()]; d = +x[2]; y = +x[3]; }
  else if ((x = s.match(/^(\d{4})(\d{2})(\d{2})$/))) [y, m, d] = [+x[1], +x[2], +x[3]];
  else return null;
  if (!m || m < 1 || m > 12 || d < 1 || d > 31 || y < 1950 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 ? iso(dt) : null;
}

// ---------- column auto-detection ----------
const HINT = {
  date: [/booking|posting|transaction.?date|kirjaus|buchungs|fecha|tarih|^date|datum|päivä|pvm|^data$/i, /date|datum/i],
  desc: [/payee|merchant|counterpart|beneficiary|recipient|saaja|maksaja|receiver|vendor|empf|mottagare|omschrijving|^name$|nimi|description|details|narrative|particulars|a[çc][ıi]klama|^text$|beskrivning/i],
  message: [/message|viesti|reference|remittance|purpose|verwendungszweck|memo|note|notes|use$/i],
  amount: [/^amount|^summa|määrä|belopp|betrag|tutar|importe|montant|bedrag|^sum$|^value$|transaction amount/i],
  debit: [/debit|withdraw|paid out|money out|outflow|soll|bor[çc]|debet|expense|uitgaven/i],
  credit: [/credit|deposit|paid in|money in|inflow|haben|alacak|kredit|income|inkomsten/i],
  direction: [/direction|dr\/cr|d\/c|cr\/dr|indicator|^type$|tyyppi|sign|debit\/credit|credit\/debit/i],
  balance: [/balance|saldo|bakiye|solde/i],
  currency: [/currency|valuutta|valuta|währung|curr|ccy|para birimi|devise/i],
  category: [/categor|kategori/i],
};
function suggestMapping(table) {
  const { headers, data } = table, sample = data.slice(0, 200), col = (i) => sample.map((r) => r.cells[i]);
  const used = new Set(), m = { date: null, desc: null, message: null, mode: 'single', amount: null, debit: null, credit: null, direction: null, currency: null, category: null, balance: null, invert: false, decimal: 'auto', dateFormat: 'auto' };
  const find = (key, skip = []) => { for (const re of HINT[key]) { const i = headers.findIndex((h, j) => re.test(h) && !used.has(j) && !skip.includes(j)); if (i >= 0) return i; } return null; };
  const claim = (key) => { const i = find(key); if (i != null) { m[key] = i; used.add(i); } };
  const frac = (i, fn) => { const v = col(i).filter((x) => x !== ''); return v.length ? v.filter(fn).length / v.length : 0; };
  for (const k of ['date', 'balance', 'currency', 'category', 'direction']) {
    claim(k);
    // a "direction" column must actually contain direction words (DBIT/CRDT, D/C, debit/credit...), not e.g. "Sale"/"Payment"
    if (k === 'direction' && m.direction != null && frac(m.direction, (x) => DIR_OUT.test(String(x)) || DIR_IN.test(String(x))) < 0.8) { used.delete(m.direction); m.direction = null; }
  }
  for (const k of ['debit', 'credit', 'amount', 'desc', 'message']) claim(k);
  // content fallbacks
  if (m.date == null) { const i = headers.findIndex((_, j) => !used.has(j) && frac(j, (x) => parseDate(x) != null) > 0.8); if (i >= 0) { m.date = i; used.add(i); } }
  if (m.amount == null && m.debit == null && m.credit == null) { const i = headers.findIndex((_, j) => !used.has(j) && frac(j, (x) => parseNumber(x) != null && !isDateLike(x)) > 0.8); if (i >= 0) { m.amount = i; used.add(i); } }
  if (m.desc == null) { let best = -1, bl = 0; headers.forEach((_, j) => { if (used.has(j)) return; const t = col(j).filter((x) => typeof x === 'string' && x && !isNum(x) && !isDateLike(x)); const avg = t.length ? t.reduce((s, x) => s + x.length, 0) / t.length : 0; if (t.length > sample.length * 0.5 && avg > bl) { best = j; bl = avg; } }); if (best >= 0) { m.desc = best; used.add(best); } }
  if (m.amount != null && m.direction != null) m.mode = 'dir';
  else if (m.amount == null && (m.debit != null || m.credit != null)) m.mode = 'split';
  else if (m.amount != null && m.debit != null && m.credit != null) m.amount = null, m.mode = 'split';
  return m;
}

// ---------- normalize ----------
// Whole words only: "Deposit" starts with "d" but is money in, and "Card" is not "c" (credit).
const DIR_OUT = /^(d|db|dr|dbit|debit|out|outgoing|withdrawal|expense|-|minus|soll|bor[çc])(?![\p{L}\p{N}])/iu, DIR_IN = /^(c|cr|crdt|credit|in|incoming|deposit|income|\+|plus|haben|alacak)(?![\p{L}\p{N}])/iu;
function resolve(table, map, cur) {
  const cols = (...ix) => ix.filter((i) => i != null).flatMap((i) => table.data.slice(0, 300).map((r) => r.cells[i]));
  const dec = map.decimal === '.' || map.decimal === ',' ? { decimal: map.decimal, ambiguous: false } : detectDecimalInfo(cols(map.amount, map.debit, map.credit, map.balance), cur);
  const date = map.dateFormat === 'MDY' || map.dateFormat === 'DMY' ? { order: map.dateFormat, ambiguous: false } : detectDateOrderInfo(cols(map.date));
  // Only a guess the user has not confirmed is "ambiguous": once they pick a format, it is saved with the bank's profile.
  return { decimal: dec.decimal, order: date.order, ambiguous: { decimal: dec.ambiguous, date: date.ambiguous } };
}
function normalize(table, map, accountCur) {
  const { decimal, order, ambiguous } = resolve(table, map, accountCur), rows = [], errors = [], skipped = { blank: 0 };
  const cell = (r, i) => (i == null ? '' : r.cells[i] ?? '');
  const str = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
  for (const r of table.data) {
    const dRaw = cell(r, map.date), date = parseDate(dRaw, order, table.date1904);
    let amount = null, err = null;
    if (map.mode === 'split') {
      const dv = parseNumber(cell(r, map.debit), decimal), cv = parseNumber(cell(r, map.credit), decimal);
      if (dv == null && cv == null) err = 'No amount';
      else amount = Math.abs(cv || 0) - Math.abs(dv || 0);
    } else {
      const a = parseNumber(cell(r, map.amount), decimal);
      if (a == null) err = 'No amount';
      else if (map.mode === 'dir') {
        const dir = str(cell(r, map.direction));
        if (DIR_OUT.test(dir)) amount = -Math.abs(a); else if (DIR_IN.test(dir)) amount = Math.abs(a); else err = `Unknown direction "${dir}"`;
      } else amount = a;
    }
    if (!err && map.invert) amount = -amount;
    const empty = !str(dRaw) && (err === 'No amount' || amount == null);
    if (empty) { skipped.blank++; continue; }
    if (!err && date == null) err = `Unreadable date "${str(dRaw)}"`;
    const cur = map.currency != null ? str(cell(r, map.currency)).toUpperCase() : '';
    if (!err && cur && accountCur && cur !== accountCur) err = `Currency ${cur} differs from the account currency ${accountCur}`;
    if (!err && amount === 0) err = 'Zero amount';
    if (err) { errors.push({ line: r.line, error: err, values: r.cells.slice(0, 6).map(str).join(' | ').slice(0, 120) }); continue; }
    const desc = (str(cell(r, map.desc)) || str(cell(r, map.message)) || 'Unknown').replace(/[;|]+/g, ' ').replace(/^[()!*\s]+/, '').slice(0, 70) || 'Unknown';
    rows.push({ line: r.line, date, amount: r2(amount), desc, text: [str(cell(r, map.desc)), str(cell(r, map.message))].filter(Boolean).join(' '), category: map.category != null ? str(cell(r, map.category)) : '', balance: map.balance != null ? parseNumber(cell(r, map.balance), decimal) : null });
  }
  return { rows, errors, skipped, decimal, order, ambiguous };
}

// ---------- sessions ----------
const sessions = new Map();
const sweep = () => { const now = Date.now(); for (const [k, v] of sessions) if (now - v.at > TTL) sessions.delete(k); while (sessions.size > 8) sessions.delete(sessions.keys().next().value); };
const getSession = (id) => { sweep(); const s = sessions.get(id); if (!s) throw new Error('This import session expired. Upload the file again.'); s.at = Date.now(); return s; };

function load(s, o = {}) {
  let rows;
  if (s.kind === 'xlsx') {
    s.sheetIdx = Math.min(Math.max(+o.sheet || 0, 0), s.book.sheets.length - 1);
    rows = s.book.sheets[s.sheetIdx].rows;
  } else {
    s.delimiter = o.delimiter || s.delimiter || detectDelimiter(s.text);
    rows = parseCsv(s.text, s.delimiter);
  }
  s.rows = rows;
  // headerRow from the UI counts from 1; 0 means "no header row".
  s.headerRow = o.headerRow != null ? (+o.headerRow > 0 ? +o.headerRow - 1 : -1) : detectHeaderRow(rows);
  s.table = buildTable(rows, s.headerRow);
  s.table.date1904 = !!s.book?.date1904;
}
const signature = (headers) => sha(headers.map((h) => h.toLowerCase()).join('|')).slice(0, 16);

function accountsList() {
  return Object.entries(store.accounts()).map(([uid, a]) => ({ uid, name: a.name, label: a.label || a.name, currency: a.currency || loadConfig().base, imported: !!a.imported, synced: !a.imported && !!a.lastSync }));
}
function describe(id, s) {
  const profile = readJSON(paths.importProfiles, {})[signature(s.table.headers)];
  return {
    importId: id, filename: s.filename, kind: s.kind, sheets: s.book ? s.book.sheets.map((x) => x.name) : null, sheet: s.sheetIdx ?? null,
    delimiter: s.delimiter ?? null, encoding: s.encoding ?? null, headerRow: s.headerRow + 1, headers: s.table.headers,
    sample: s.table.data.slice(0, 8).map((r) => r.cells.map((c) => String(c ?? ''))), rowCount: s.table.data.length,
    mapping: profile?.mapping || suggestMapping(s.table), fromProfile: !!profile, profileAccount: profile?.account || null,
    accounts: accountsList(), base: loadConfig().base,
  };
}

function upload(buf, filename) {
  if (!buf.length) throw new Error('The file is empty.');
  if (buf.length > MAX_BYTES) throw new Error('File is too large (limit 30 MB).');
  const ext = (filename.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
  const s = { at: Date.now(), filename, buf };
  if (ext === 'xls') throw new Error('Old .xls files are not supported. In Excel, use File → Save As → .xlsx or CSV.');
  const zip = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50; // a text file can start with "PK" ("PKO BP …")
  if (ext === 'xlsx' || ext === 'xlsm' || (zip && ext !== 'csv' && ext !== 'txt')) { s.kind = 'xlsx'; s.book = readXlsx(buf); }
  else {
    const utf16 = (buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff), head = buf.subarray(0, 4096);
    if (!utf16 && head.filter((b) => b === 0 || (b < 32 && b !== 9 && b !== 10 && b !== 13)).length > head.length * 0.02) throw new Error('This does not look like a CSV or Excel file (it contains binary data). Export your transactions as CSV or .xlsx and try again.');
    s.kind = 'csv'; const d = decode(buf); s.text = d.text; s.encoding = d.encoding; }
  load(s);
  if (!s.table.data.length) throw new Error('No data rows found in this file.');
  const id = crypto.randomUUID(); sessions.set(id, s); sweep();
  return describe(id, s);
}
function reparse(id, o) { const s = getSession(id); load(s, o); return describe(id, s); }

// ---------- AI help (Settings → Connections → AI) ----------
const letter = (i) => { let s = ''; for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };
const fromLetter = (v) => { if (v == null || v === '') return null; if (Number.isInteger(v)) return v; const m = String(v).trim().toUpperCase().match(/^[A-Z]{1,3}$/); return m ? [...m[0]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1 : null; };
function gridText(rows, max = 40) {
  const { redact } = require('./redact');
  return rows.slice(0, max).map((r, i) => `row ${i + 1}: ` + (r || []).slice(0, 26).map((c, j) => (c === '' || c == null ? null : `${letter(j)}=${String(redact(String(c))).replace(/\s+/g, ' ').slice(0, 60)}`)).filter(Boolean).join(' | ')).join('\n');
}

/** The AI reads the top of the file and says where the header is and which column is what. Nothing is imported. */
async function aiMapping(id) {
  const s = getSession(id), llm = require('./llm');
  const sheets = s.book ? s.book.sheets.slice(0, 6).map((sh, i) => `Sheet ${i} "${sh.name}" (${sh.rows.length} rows):\n${gridText(sh.rows, i === (s.sheetIdx ?? 0) ? 40 : 12)}`) : [`CSV file (delimiter "${s.delimiter === '\t' ? 'tab' : s.delimiter}"):\n${gridText(s.rows, 40)}`];
  const a = await llm.json(`This is the top of a bank or card statement export that a personal-finance app must import. Columns are letters, rows are numbered from 1.

${sheets.join('\n\n')}

Find the transaction table and reply with JSON:
{"sheet": <sheet number holding the transactions, or null for CSV>,
 "headerRow": <row number of the column titles above the transactions; 0 if there is none>,
 "date": "<column letter of the transaction/booking date>",
 "desc": "<column with the payee/merchant/description>", "message": "<column with an extra reference/memo, or null>",
 "mode": "single" (one signed amount column) | "split" (separate debit/out and credit/in columns) | "dir" (amount + a column saying debit/credit),
 "amount": "<column or null>", "debit": "<money out column or null>", "credit": "<money in column or null>", "direction": "<column or null>",
 "invert": <true if money going OUT is written as a POSITIVE number in a single amount column, else false>,
 "currency": "<column or null>", "category": "<column with a category, or null>", "balance": "<running balance column, or null>",
 "decimal": "." or "," (the decimal separator the amounts use), "dateFormat": "DMY" or "MDY" or "auto",
 "notes": "<one or two plain sentences for the user: what you found, anything to double-check>"}
Prefer the booking date over a value date. Ignore title rows, account details and totals rows.`);
  const sheet = s.book && Number.isInteger(a.sheet) && a.sheet >= 0 && a.sheet < s.book.sheets.length ? a.sheet : undefined;
  load(s, { sheet: sheet ?? s.sheetIdx, delimiter: s.delimiter, headerRow: Number.isInteger(a.headerRow) && a.headerRow >= 0 ? a.headerRow : undefined });
  const width = s.table.headers.length, colOf = (k) => { const i = fromLetter(a[k]); return i != null && i >= 0 && i < width ? i : null; };
  const m = { ...suggestMapping(s.table), date: colOf('date'), desc: colOf('desc'), message: colOf('message'), amount: colOf('amount'), debit: colOf('debit'), credit: colOf('credit'), direction: colOf('direction'), currency: colOf('currency'), category: colOf('category'), balance: colOf('balance'),
    mode: ['single', 'split', 'dir'].includes(a.mode) ? a.mode : 'single', invert: a.invert === true, decimal: ['.', ','].includes(a.decimal) ? a.decimal : 'auto', dateFormat: ['DMY', 'MDY'].includes(a.dateFormat) ? a.dateFormat : 'auto' };
  if (m.date == null) throw new Error('The AI could not find a date column in this file. Set the columns by hand.');
  return { ...describe(id, s), mapping: m, fromProfile: false, ai: { notes: String(a.notes || '').slice(0, 400) } };
}

/** The AI picks one of your categories for each merchant your rules do not cover. Applied in the preview; nothing is saved until you import. */
async function aiCategories(id, mapping, account, options = {}) {
  const s = getSession(id), llm = require('./llm');
  const p = plan(id, mapping, account, options);
  const todo = new Map();
  for (const r of p.include) if (/:uncategorized$/.test(r.category) && !r.ai) { const k = r.desc; const t = todo.get(k) || { name: k, n: 0, out: r.amount < 0, total: 0 }; t.n++; t.total += r.amount; todo.set(k, t); }
  const items = [...todo.values()].sort((x, y) => Math.abs(y.total) - Math.abs(x.total)).slice(0, 250);
  if (!items.length) { s.aiCats = s.aiCats || {}; return { categorized: 0, asked: 0 }; }
  const cats = [...new Set([...categoryIndex().values()])].filter((c) => /^(expenses|income|transfers)(:|$)/.test(c) && !/:uncategorized$/.test(c)).sort();
  const { redact } = require('./redact');
  const a = await llm.json(`Assign each bank transaction description below to one category from this list, or null when you cannot tell.
Money-out descriptions must get an "expenses:..." category, money-in ones an "income:..." category. A "transfers:..." category (either direction) is only for money moved between the person's own accounts.
Categories:\n${cats.join('\n')}

Descriptions (direction, number of transactions):
${items.map((t) => `${JSON.stringify(String(redact(t.name)))} (${t.out ? 'out' : 'in'}, ${t.n}x)`).join('\n')}

Reply with JSON: {"categories": {"<description exactly as given>": "<category or null>", ...}}`, { maxTokens: 8000 });
  const got = a.categories && typeof a.categories === 'object' ? a.categories : {}, valid = new Set(cats);
  s.aiCats = { ...(s.aiCats || {}) };
  let n = 0;
  for (const t of items) { const c = got[String(redact(t.name))] ?? got[t.name]; if (typeof c === 'string' && valid.has(c) && (c.startsWith('transfers') || c.startsWith('expenses') === t.out)) { s.aiCats[t.name] = c; n++; } }
  return { categorized: n, asked: items.length };
}

// ---------- preview / commit ----------
// Letters of every script count (Пятёрочка and Магнит are different merchants); accents are folded.
const normKey = (t) => String(t).normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const keyExact = (acct, d, a, desc) => `${acct}|${d}|${a.toFixed(2)}|${normKey(desc)}`;
const keyLoose = (acct, d, a) => `${acct}|${d}|${a.toFixed(2)}`;

function targetAccount(account) {
  const accts = store.accounts(), cfgBase = loadConfig().base;
  if (account?.uid) {
    const a = accts[account.uid];
    if (!a) throw new Error('Unknown account.');
    return { uid: account.uid, meta: a, name: a.name, cur: a.currency || cfgBase, existing: true, synced: !a.imported && !!a.lastSync };
  }
  const label = String(account?.name || '').trim().slice(0, 60);
  if (!label) throw new Error('Choose an account or enter a name for a new one.');
  // Importing monthly statements under the same name must land in the same account, not create "name-2".
  const same = Object.entries(accts).find(([, a]) => J.slug(a.label || a.name) === J.slug(label) || a.name === J.slug(label));
  if (same) return { uid: same[0], meta: same[1], name: same[1].name, cur: same[1].currency || cfgBase, existing: true, synced: !same[1].imported && !!same[1].lastSync };
  const cur = String(account.currency || cfgBase).toUpperCase();
  if (!/^[A-Z]{3}$/.test(cur)) throw new Error('Enter the account currency as its 3-letter ISO code.');
  let slug = J.slug(label) || 'imported', n = 2;
  const taken = new Set(Object.values(accts).map((a) => a.name));
  const base = slug; while (taken.has(slug)) slug = `${base}-${n++}`;
  return { uid: `import-${slug}`, meta: { name: slug, label, currency: cur, imported: true }, name: slug, cur, existing: false, synced: false };
}

function categoryIndex() {
  const cfg = loadConfig(), set = new Set([...cfg.rules.map((r) => r.account), ...(cfg.categories || []), ...Object.keys(cfg.budgets), 'expenses:uncategorized', 'income:uncategorized', 'transfers:internal']);
  const idx = new Map();
  for (const a of set) {
    const parts = a.split(':').slice(1), label = parts.map((p) => p.replace(/-/g, ' ')).join(' ');
    for (const k of [a, label, parts.join(':'), parts[parts.length - 1]?.replace(/-/g, ' ')]) if (k) idx.set(normKey(k), a);
  }
  return idx;
}

function plan(id, mapping, account, options = {}) {
  const s = getSession(id), tgt = targetAccount(account), cfg = loadConfig(), acctStr = 'assets:bank:' + tgt.name;
  const map = { ...suggestMapping(s.table), ...mapping };
  for (const k of ['date']) if (map[k] == null) throw new Error('Choose which column holds the date.');
  if (map.mode === 'split' ? map.debit == null && map.credit == null : map.amount == null) throw new Error('Choose which column holds the amount.');
  if (map.mode === 'dir' && map.direction == null) throw new Error('Choose which column says whether it is money in or out.');
  const n = normalize(s.table, map, tgt.cur);

  const existing = Object.entries(store.txs()).filter(([, t]) => t.acct === acctStr);
  const exact = new Map(), loose = new Map();
  for (const [, t] of existing) { const e = keyExact(acctStr, t.date, t.amount, t.desc), l = keyLoose(acctStr, t.date, t.amount); exact.set(e, (exact.get(e) || 0) + 1); loose.set(l, (loose.get(l) || 0) + 1); }
  const opening = tgt.meta.opening, catIdx = options.useCategory ? categoryIndex() : null;
  const counts = { new: 0, duplicate: 0, possible_duplicate: 0, overlap: 0 };
  let unmappedCats = 0;
  const rows = n.rows.map((r) => {
    const e = keyExact(acctStr, r.date, r.amount, r.desc), l = keyLoose(acctStr, r.date, r.amount);
    let status = 'new';
    if (exact.get(e) > 0) { status = 'duplicate'; exact.set(e, exact.get(e) - 1); loose.set(l, Math.max(0, (loose.get(l) || 1) - 1)); }
    else if (loose.get(l) > 0) { status = 'possible_duplicate'; loose.set(l, loose.get(l) - 1); }
    else if (tgt.synced && opening && r.date > opening.date) status = 'overlap';
    counts[status]++;
    let category = J.categorize(r.text || r.desc, r.amount < 0 ? 'out' : 'in', cfg.rules), fromColumn = false;
    if (catIdx && r.category) {
      const a = catIdx.get(normKey(r.category));
      if (a && (a.startsWith('transfers') || (r.amount < 0) === a.startsWith('expenses'))) { category = a; fromColumn = true; } else unmappedCats++;
    }
    // Categories the AI chose for merchants your rules do not know (Categorize with AI); saved like a category column.
    let ai = false;
    if (!fromColumn && /:uncategorized$/.test(category) && s.aiCats?.[r.desc] && (s.aiCats[r.desc].startsWith('transfers') || (r.amount < 0) === s.aiCats[r.desc].startsWith('expenses'))) { category = s.aiCats[r.desc]; fromColumn = true; ai = true; }
    return { ...r, status, category, fromColumn, ai, include: status === 'new' || (status === 'possible_duplicate' && !!options.includePossible) || (status === 'overlap' && !!options.includeOverlap) };
  });
  const inc = rows.filter((r) => r.include), dates = inc.map((r) => r.date).sort();
  const desc = newestFirst(n.rows);
  const withBal = n.rows.filter((r) => r.balance != null);
  let endBalance = null, endBalanceDate = null;
  if (withBal.length) { const latest = withBal.reduce((b, r) => (r.date > b.date || (r.date === b.date && (desc ? false : true)) ? r : b)); endBalance = latest.balance; endBalanceDate = latest.date; }
  return { s, tgt, acctStr, map, rows, counts, errors: n.errors, skipped: n.skipped, decimal: n.decimal, order: n.order, ambiguous: n.ambiguous, balanceCheck: balanceCheck(n.rows), unmappedCats, endBalance, endBalanceDate, lastRowDate: n.rows.reduce((m, r) => (r.date > m ? r.date : m), ''), include: inc, from: dates[0] || null, to: dates[dates.length - 1] || null };
}

/**
 * Is the file listed newest first? The running balance answers it even when every row has the same date:
 * reading oldest first, each balance is the previous one plus this row's amount.
 */
function newestFirst(rows) {
  const b = rows.filter((r) => r.balance != null);
  let fwd = 0, back = 0;
  for (let i = 1; i < b.length; i++) {
    if (Math.abs(b[i - 1].balance + b[i].amount - b[i].balance) < 0.005) fwd++;
    if (Math.abs(b[i].balance + b[i - 1].amount - b[i - 1].balance) < 0.005) back++;
  }
  if (fwd !== back) return back > fwd;
  return rows.length > 1 && rows[0].date > rows[rows.length - 1].date;
}

/**
 * Cross-check amounts against the file's own Balance column. Each balance should be the previous one plus the row's
 * amount; when most rows disagree, the sign, the decimal separator or the amount column is probably wrong, and a
 * targeted hint says which.
 */
function balanceCheck(rows) {
  const b = rows.filter((r) => r.balance != null);
  if (b.length < 4) return null;
  const agree = (f) => { let fwd = 0, back = 0; for (let i = 1; i < b.length; i++) { if (Math.abs(b[i - 1].balance + f(b[i].amount) - b[i].balance) < 0.011) fwd++; if (Math.abs(b[i].balance + f(b[i - 1].amount) - b[i - 1].balance) < 0.011) back++; } return Math.max(fwd, back); };
  const pairs = b.length - 1, matching = agree((a) => a), good = (n) => n / pairs >= 0.8;
  if (good(matching)) return { pairs, matching, ok: true, hint: null };
  const hint = good(agree((a) => -a)) ? 'flip' : good(agree((a) => a / 1000)) || good(agree((a) => a * 1000)) ? 'decimal' : 'check';
  return { pairs, matching, ok: false, hint };
}

/** Decide whether this file's balance (from the Balance column or typed in) should anchor the account balance. */
function decideAnchor(p, options) {
  if (!p.tgt.meta.imported) return null; // synced accounts take their balance from the bank
  const given = options.balance !== undefined && options.balance !== null && options.balance !== '';
  const value = given ? Number(options.balance) : p.endBalance, date = given ? p.lastRowDate : p.endBalanceDate;
  if (value == null || !Number.isFinite(value) || !date) return null;
  const latest = [...Object.values(store.txs()).filter((t) => t.acct === p.acctStr).map((t) => t.date), ...p.include.map((r) => r.date)].sort().pop() || '';
  return { value, date, source: given ? 'entered' : 'column', used: date >= latest };
}

function preview(id, mapping, account, options) {
  const p = plan(id, mapping, account, options), inc = p.include;
  return {
    account: { label: p.tgt.meta.label || p.tgt.name, currency: p.tgt.cur, isNew: !p.tgt.existing, synced: p.tgt.synced, openingDate: p.tgt.meta.opening?.date || null },
    counts: { ...p.counts, errors: p.errors.length, blank: p.skipped.blank, toImport: inc.length }, decimal: p.decimal, dateOrder: p.order, ambiguous: p.ambiguous, balanceCheck: p.balanceCheck, from: p.from, to: p.to, unmappedCategories: p.unmappedCats, aiCategorized: inc.filter((r) => r.ai).length, uncategorized: inc.filter((r) => /:uncategorized$/.test(r.category)).length, aiTried: !!p.s.aiCats,
    totals: { in: r2(inc.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0)), out: r2(-inc.filter((r) => r.amount < 0).reduce((s, r) => s + r.amount, 0)) },
    balance: decideAnchor(p, options), endBalance: p.endBalance, endBalanceDate: p.endBalanceDate,
    sample: p.rows.slice(0, 40).map(({ line, date, amount, desc, status, category, include, ai }) => ({ line, date, amount, desc, status, category, include, ai })),
    errors: p.errors.slice(0, 30),
  };
}

function commit(id, mapping, account, options = {}) {
  const p = plan(id, mapping, account, options);
  if (!p.include.length) throw new Error('Nothing to import: every row is a duplicate, outside the allowed range, or has an error.');
  const { tgt, acctStr } = p, accts = store.accounts(), txs = store.txs(), ov = store.overrides();
  const batch = crypto.randomBytes(5).toString('hex'), openingBefore = tgt.meta.opening ? { ...tgt.meta.opening } : null;
  const anchorBefore = tgt.meta.anchor ? { ...tgt.meta.anchor } : null;
  const meta = (accts[tgt.uid] ??= tgt.meta);
  const seen = {};
  for (const r of p.include) {
    const k = `${tgt.uid}|${r.date}|${r.amount}|${r.desc}`;
    let n = seen[k] || 0, tid;
    do tid = sha(`imp|${k}|${n++}`).slice(0, 12); while (txs[tid]);
    seen[k] = n;
    txs[tid] = { acct: acctStr, date: r.date, amount: r.amount, cur: tgt.cur, desc: r.desc, text: r.text || r.desc, batch, src: 'import' };
    if (r.fromColumn) ov[tid] = r.category;
  }
  // Keep the account balance consistent.
  const dates = p.include.map((r) => r.date).sort(), earliest = dates[0];
  const anchor = decideAnchor(p, options);
  if (anchor?.used) {
    // "The balance after the file's last row was <value>": solve for the opening balance so that holds.
    const mine = Object.values(txs).filter((t) => t.acct === acctStr);
    const first = mine.reduce((m, t) => (t.date < m ? t.date : m), '9999-12-31');
    meta.opening = { date: addDays(first, -1), amount: r2(anchor.value - mine.filter((t) => t.date <= anchor.date).reduce((s, t) => s + t.amount, 0)), cur: tgt.cur };
    meta.anchor = { date: anchor.date, value: anchor.value };
  } else if (meta.opening) {
    // Older history was added to an account that already has an opening balance (synced, or anchored earlier):
    // shift the opening back so today's balance stays correct.
    // Rows dated on or before the last known balance (the opening, or a statement balance anchored earlier) must not
    // change it: importing February after January and March keeps March's balance.
    const ref = meta.anchor?.date > meta.opening.date ? meta.anchor.date : meta.opening.date;
    const older = p.include.filter((r) => r.date <= ref).reduce((s, r) => s + r.amount, 0);
    if (older || earliest < meta.opening.date) meta.opening = { ...meta.opening, amount: r2(meta.opening.amount - older), date: earliest <= meta.opening.date ? addDays(earliest, -1) : meta.opening.date };
  }
  store.saveTxs(txs); store.saveOverrides(ov); store.saveAccounts(accts);
  const log = readJSON(paths.imports, []);
  log.push({ id: batch, at: new Date().toISOString(), file: p.s.filename, uid: tgt.uid, account: meta.label || meta.name, added: p.include.length, skipped: { duplicate: p.counts.duplicate, possible: p.counts.possible_duplicate - p.include.filter((r) => r.status === 'possible_duplicate').length, overlap: p.counts.overlap - p.include.filter((r) => r.status === 'overlap').length, errors: p.errors.length }, from: p.from, to: p.to, createdAccount: !tgt.existing, openingBefore, anchorBefore });
  writeAtomic(paths.imports, JSON.stringify(log, null, 2));
  const prof = readJSON(paths.importProfiles, {});
  prof[signature(p.s.table.headers)] = { mapping: p.map, account: { uid: tgt.uid } };
  writeAtomic(paths.importProfiles, JSON.stringify(prof, null, 2));
  J.rebuildBank(); J.writeDerived();
  sessions.delete(id);
  return { batch, added: p.include.length, account: meta.label || meta.name, from: p.from, to: p.to };
}

const history = () => readJSON(paths.imports, []).reverse().map(({ openingBefore, anchorBefore, ...x }) => x);

function undo(batch) {
  const log = readJSON(paths.imports, []), e = log.find((x) => x.id === batch);
  if (!e || e.undoneAt) throw new Error('Import not found or already undone.');
  if (log.slice(log.indexOf(e) + 1).some((x) => !x.undoneAt && (x.uid === e.uid || x.account === e.account))) throw new Error('A newer import into the same account exists. Undo that one first.'); // by position, not timestamp: two imports can share a millisecond
  const txs = store.txs(), ov = store.overrides(), accts = store.accounts();
  for (const [tid, t] of Object.entries(txs)) if (t.batch === batch) { delete txs[tid]; delete ov[tid]; }
  const meta = accts[e.uid] || Object.values(accts).find((a) => a.prevUids?.includes(e.uid)); // the bank account may have been reconnected since
  if (meta) {
    if (e.createdAccount) { if (!Object.values(txs).some((t) => t.acct === 'assets:bank:' + meta.name)) delete accts[e.uid]; else if (e.openingBefore) meta.opening = e.openingBefore; else delete meta.opening; }
    else if (e.openingBefore) meta.opening = e.openingBefore; else delete meta.opening;
    if (e.anchorBefore) meta.anchor = e.anchorBefore; else delete meta.anchor;
  }
  store.saveTxs(txs); store.saveOverrides(ov); store.saveAccounts(accts);
  e.undoneAt = new Date().toISOString();
  writeAtomic(paths.imports, JSON.stringify(log, null, 2));
  J.rebuildBank(); J.writeDerived();
  return { removed: e.added };
}

/** The parsed table of an uploaded file, for other importers (investments) that read the same files. */
const table = (id) => { const s = getSession(id); return { filename: s.filename, table: s.table }; };

module.exports = { upload, reparse, preview, commit, history, undo, accountsList, aiMapping, aiCategories, table, parseNumber, parseDate, detectDecimalInfo, detectDateOrderInfo, _t: { balanceCheck, detectDecimalInfo, detectDateOrderInfo, parseNumber, parseDate, detectDateOrder, detectDecimal, detectDelimiter, parseCsv, decode, suggestMapping, detectHeaderRow, buildTable, normalize } };
