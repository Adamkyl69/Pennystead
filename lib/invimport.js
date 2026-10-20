// Import investments (stocks, funds, ETFs, crypto...) from a CSV / Excel file: a holdings statement or a price list.
// Each row is one investment on one date: its name or ticker, how many units you hold and the price of one unit.
// An import never overwrites history: every row adds a dated value point (units and unit price) to the investment,
// so you can see what each holding was worth before and after. Investments not yet in Pennystead are added.
const fs = require('fs');
const crypto = require('crypto');
const { paths, loadConfig, writeAtomic } = require('./config');
const importer = require('./importer');
const manual = require('./manual');
const J = require('./journal');
const { today } = require('./dates');

const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const r6 = (n) => Math.round(n * 1e6) / 1e6;
const str = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const key = (s) => str(s).toLowerCase();

const HINT = {
  symbol: [/^(symbol|ticker|isin|code|tunnus|kod|sembol)$/i, /symbol|ticker|isin|wkn|valor|sedol|cusip/i],
  name: [/^(name|security|instrument|holding|asset|fund|product|nimi|arvopaperi|menkul|varlık|titel|wertpapier)$/i, /name|security|instrument|holding|description|fund|product|nimi|wertpapier|menkul/i],
  units: [/^(units|quantity|qty|shares|amount|kpl|määrä|adet|lot|pieces|stück|anzahl|antal|nominal)$/i, /unit(?!.*price)|quantit|qty|shares|kpl|määrä|adet|stück|anzahl|antal|holding\s*amount/i],
  price: [/^(price|unit price|last price|close|nav|kurssi|hinta|fiyat|kurs|cours)$/i, /price|kurs|nav|close|hinta|fiyat|cours|rate/i],
  value: [/^(value|market value|total value|total|worth|arvo|markkina-arvo|değer|tutar|wert|marktwert)$/i, /value|worth|arvo|değer|tutar|wert|total/i],
  cost: [/cost|purchase value|book value|hankinta|maliyet|einstand|kaufwert/i],
  currency: [/currency|valuutta|valuta|währung|ccy|para birimi|devise|^cur$/i],
  date: [/^(date|as of|valuation date|price date|päivä|päivämäärä|tarih|datum)$/i, /date|as of|päivä|tarih|datum/i],
};

function suggest(t) {
  const used = new Set(), m = { symbol: null, name: null, units: null, price: null, value: null, cost: null, currency: null, date: null, decimal: 'auto', dateFormat: 'auto' };
  for (const k of ['symbol', 'currency', 'date', 'cost', 'price', 'value', 'units', 'name'])
    for (const re of HINT[k]) { const i = t.headers.findIndex((h, j) => !used.has(j) && re.test(h)); if (i >= 0) { m[k] = i; used.add(i); break; } }
  return m;
}

function describe(importId) {
  const { filename, table } = importer.table(importId);
  const cfg = loadConfig();
  return { importId, filename, headers: table.headers, sample: table.data.slice(0, 8).map((r) => r.cells.map((c) => String(c ?? ''))), rowCount: table.data.length, mapping: suggest(table), base: cfg.base, today: today() };
}

/** Investments already in Pennystead, matched by ticker first, then by name. */
function existing() {
  const list = manual.load().assets.filter((a) => a.kind === 'asset' && (a.type === 'investment' || a.perUnit));
  const bySym = new Map(), byName = new Map();
  for (const a of list) { if (a.symbol) bySym.set(key(a.symbol), a); byName.set(key(a.name), a); }
  return { list, find: (sym, name) => (sym && bySym.get(key(sym))) || (name && byName.get(key(name))) || (sym && byName.get(key(sym))) || null };
}

/**
 * Read the file with a mapping and compare it with what you already have.
 * options: { date (as-of date when the file has no date column), currency (when it has no currency column) }
 */
function plan(importId, mapping = {}, options = {}) {
  const { table, filename } = importer.table(importId), m = { ...suggest(table), ...mapping };
  if (m.symbol == null && m.name == null) throw new Error('Choose the column with the investment name or ticker.');
  if (m.price == null && m.value == null) throw new Error('Choose the column with the price of one unit (or the total value).');
  const cfg = loadConfig(), asOf = /^\d{4}-\d{2}-\d{2}$/.test(options.date || '') ? options.date : today();
  const defCur = String(options.currency || cfg.base || '').toUpperCase();
  const col = (...ix) => ix.filter((i) => i != null).flatMap((i) => table.data.slice(0, 300).map((r) => r.cells[i]));
  const decimal = m.decimal === '.' || m.decimal === ',' ? m.decimal : importer.detectDecimalInfo(col(m.units, m.price, m.value, m.cost)).decimal;
  const order = m.dateFormat === 'MDY' || m.dateFormat === 'DMY' ? m.dateFormat : importer.detectDateOrderInfo(col(m.date)).order;
  const cell = (r, i) => (i == null ? '' : r.cells[i] ?? '');
  const ex = existing(), rows = [], errors = [], seen = new Map();
  let blank = 0;
  for (const r of table.data) {
    const symbol = m.symbol != null ? str(cell(r, m.symbol)).toUpperCase().slice(0, 24) : '', name = (m.name != null ? str(cell(r, m.name)) : '') || symbol;
    const num = (i) => (i == null ? null : importer.parseNumber(cell(r, i), decimal));
    let units = num(m.units), price = num(m.price);
    const value = num(m.value), cost = num(m.cost);
    if (!name && units == null && price == null && value == null) { blank++; continue; }
    const fail = (error) => errors.push({ line: r.line, error, values: r.cells.slice(0, 6).map(str).join(' | ').slice(0, 120) });
    if (!name) { fail('No name or ticker'); continue; }
    const date = m.date != null ? importer.parseDate(cell(r, m.date), order, table.date1904) : asOf;
    if (!date) { fail(`Unreadable date "${str(cell(r, m.date))}"`); continue; }
    if (date > today()) { fail(`Date ${date} is in the future`); continue; }
    const cur = (m.currency != null && str(cell(r, m.currency)).toUpperCase()) || defCur;
    if (!/^[A-Z]{3,5}$/.test(cur)) { fail(cur ? `Unknown currency "${cur}"` : 'No currency: choose one below'); continue; }
    const match = ex.find(symbol, name);
    const prev = match ? [...match.valuations].filter((v) => v.date <= date).pop() || null : null;
    if (units == null) units = prev?.units ?? null; // a price list: you still hold what you held
    if (units == null) { fail('No number of units (this investment is new, so the file must say how many you hold)'); continue; }
    if (units < 0 || (price != null && price < 0) || (value != null && value < 0)) { fail('Negative numbers are not allowed here'); continue; }
    if (price == null) { if (!units) { fail('No price, and 0 units to work it out from'); continue; } price = r6(value / units); }
    if (match && match.currency !== cur) { fail(`${match.name} is kept in ${match.currency}, this row is in ${cur}`); continue; }
    const k = `${match?.id || key(symbol || name)}|${date}`;
    if (seen.has(k)) { fail(`${name} appears twice for ${date}; only the first row is used`); continue; }
    seen.set(k, true);
    const same = prev && prev.date === date && prev.units === units && Math.abs((prev.price ?? 0) - price) < 1e-9;
    rows.push({
      line: r.line, name: match?.name || name, symbol: symbol || match?.symbol || null, date, units, price: r6(price), value: r6(units * price), currency: cur, cost,
      status: !match ? 'new' : same ? 'same' : 'update', assetId: match?.id || null,
      previous: prev ? { date: prev.date, units: prev.units ?? null, price: prev.price ?? null, value: prev.value } : null,
    });
  }
  // A new investment that appears on several dates is created once.
  const firstNew = new Set();
  for (const x of rows) if (x.status === 'new') { const k = key(x.symbol || x.name); x.createsAsset = !firstNew.has(k); firstNew.add(k); }
  const named = new Set(rows.map((x) => x.assetId).filter(Boolean));
  return { filename, mapping: m, decimal, dateOrder: order, asOf, currency: defCur, rows, errors, blank, missing: ex.list.filter((a) => a.type === 'investment' && !a.closed && !named.has(a.id)).map((a) => a.name) };
}

function preview(importId, mapping, options) {
  const p = plan(importId, mapping, options);
  const c = { new: 0, update: 0, same: 0 };
  for (const r of p.rows) c[r.status]++;
  return { ...p, counts: { ...c, errors: p.errors.length, blank: p.blank, assets: new Set(p.rows.map((r) => r.assetId || key(r.symbol || r.name))).size }, rows: p.rows.slice(0, 500), errors: p.errors.slice(0, 100), more: Math.max(0, p.rows.length - 500) };
}

/** Saves the rows: new investments are created, every other row adds a dated value point. Undo puts things back as they were. */
function commit(importId, mapping, options) {
  const p = plan(importId, mapping, options), todo = p.rows.filter((r) => r.status !== 'same');
  if (!todo.length) throw new Error('Nothing new in this file: every value is already recorded.');
  const batch = crypto.randomBytes(5).toString('hex'), created = [], before = [], ids = new Map();
  const assets = manual.load().assets;
  for (const r of [...todo].sort((a, b) => a.date.localeCompare(b.date))) {
    let id = r.assetId || ids.get(key(r.symbol || r.name));
    if (!id) {
      const a = manual.create({ name: r.name, type: 'investment', kind: 'asset', currency: r.currency, perUnit: true, unit: 'units', symbol: r.symbol || undefined, units: r.units, price: r.price, date: r.date, note: `import: ${p.filename}`.slice(0, 200), ...(r.cost != null ? { cost: r.cost, acquired: r.date } : {}) });
      ids.set(key(r.symbol || r.name), a.id); created.push(a.id);
      continue;
    }
    if (!created.includes(id)) before.push({ id, date: r.date, entry: assets.find((a) => a.id === id)?.valuations.find((v) => v.date === r.date) || null });
    manual.record(id, { date: r.date, units: r.units, price: r.price, note: `import: ${p.filename}`.slice(0, 200) });
  }
  const log = readJSON(paths.invImports, []);
  log.push({ id: batch, at: new Date().toISOString(), file: p.filename, created, updated: before.length, before, investments: new Set(todo.map((r) => key(r.symbol || r.name))).size, rows: todo.length, from: todo.map((r) => r.date).sort()[0], to: todo.map((r) => r.date).sort().pop() });
  writeAtomic(paths.invImports, JSON.stringify(log.slice(-100), null, 2));
  J.writeDerived();
  return { batch, added: created.length, updated: before.length, rows: todo.length };
}

const history = () => readJSON(paths.invImports, []).reverse().map(({ before, ...x }) => ({ ...x, created: x.created.length }));

/** Removes what one import added: the investments it created, and the values it recorded (an older value on the same date comes back). */
function undo(batch) {
  const log = readJSON(paths.invImports, []), e = log.find((x) => x.id === batch);
  if (!e) throw new Error('Unknown import.');
  if (e.undoneAt) throw new Error('This import was already undone.');
  const d = manual.load();
  d.assets = d.assets.filter((a) => !e.created.includes(a.id));
  for (const b of [...e.before].reverse()) {
    const a = d.assets.find((x) => x.id === b.id);
    if (!a) continue;
    a.valuations = a.valuations.filter((v) => v.date !== b.date);
    if (b.entry) a.valuations.push(b.entry);
    a.valuations.sort((x, y) => x.date.localeCompare(y.date));
  }
  writeAtomic(paths.manualAssets, JSON.stringify(d, null, 2));
  e.undoneAt = new Date().toISOString();
  writeAtomic(paths.invImports, JSON.stringify(log, null, 2));
  J.writeDerived();
  return { removed: e.created.length, restored: e.before.length };
}

module.exports = { describe, preview, commit, history, undo, _t: { suggest, plan } };
