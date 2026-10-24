// Investments imported from a file (broker export, spreadsheet). Every import adds a dated snapshot per holding
// (units and price per unit), so the history of both is kept and a later file never overwrites an earlier one.
// Source of truth: data/investments.json. The ledger reads positions and prices from entries().
const crypto = require('crypto');
const fs = require('fs');
const { paths, writeAtomic } = require('./config');
const { ascii } = require('./journal-text');
const slug = (s) => ascii(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); // same as journal.js (not imported: journal.js uses this module)

const load = () => { try { return { symbols: {}, imports: [], ...JSON.parse(fs.readFileSync(paths.investments, 'utf8')) }; } catch { return { symbols: {}, imports: [] }; } };
const save = (d) => writeAtomic(paths.investments, JSON.stringify(d, null, 2));
const r8 = (n) => Math.round(n * 1e8) / 1e8;
const same = (a, b) => Math.abs(a - b) < 1e-9;
const account = (symbol) => 'assets:investments:' + slug(symbol);
const symbols = () => new Set(Object.keys(load().symbols));

/** Rows from the file (importer.investmentRows) merged per holding and date: several lots of one holding add up. */
function merge(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = `${r.symbol}|${r.date}`, e = by.get(k) || by.set(k, { symbol: r.symbol, name: r.name, cur: r.cur, date: r.date, qty: 0, value: 0, cost: null, line: r.line }).get(k);
    e.qty += r.qty; e.value += r.qty * r.price; if (r.cost != null) e.cost = (e.cost || 0) + r.cost; if (r.name && !e.name) e.name = r.name;
  }
  return [...by.values()].map((e) => ({ symbol: e.symbol, name: e.name || '', cur: e.cur, date: e.date, qty: r8(e.qty), price: e.qty ? r8(e.value / e.qty) : null, cost: e.cost, line: e.line }));
}

const before = (h, date) => [...h].reverse().find((x) => x.date < date) || null;

/**
 * What an import would do: new holdings, changed ones (units or price differ from the entry before), unchanged ones
 * (nothing new, skipped), and an entry on a date that already has one (replaced). With closeMissing, held holdings the file no longer lists
 * are closed at the file's date (units 0).
 */
function plan(rows, { closeMissing = false } = {}) {
  const d = load(), items = merge(rows).map((e) => {
    const h = d.symbols[e.symbol]?.history || [], same_day = h.find((x) => x.date === e.date), prev = before(h, e.date);
    if (e.price == null) e.price = (same_day || prev)?.price ?? null; // a closed position may come without a price
    const ref = prev;
    let status = 'new';
    if (same_day) status = same(same_day.qty, e.qty) && same(same_day.price, e.price) ? 'unchanged' : 'replaced';
    else if (ref) status = same(ref.qty, e.qty) && same(ref.price, e.price) ? 'unchanged' : 'changed';
    return { ...e, status, prev: ref ? { date: ref.date, qty: ref.qty, price: ref.price } : null, isNewHolding: !d.symbols[e.symbol] };
  });
  const bad = items.filter((x) => x.price == null);
  if (closeMissing && items.length) {
    const date = items.map((x) => x.date).sort().pop(), listed = new Set(items.map((x) => x.symbol));
    for (const [symbol, s] of Object.entries(d.symbols)) {
      const last = s.history[s.history.length - 1];
      if (!listed.has(symbol) && last && last.qty > 0 && last.date < date) items.push({ symbol, name: s.name, cur: s.currency, date, qty: 0, price: last.price, cost: null, status: 'closed', prev: { date: last.date, qty: last.qty, price: last.price }, isNewHolding: false });
    }
  }
  return { items: items.filter((x) => x.price != null), skipped: bad.length, counts: items.reduce((c, x) => ((c[x.status] = (c[x.status] || 0) + 1), c), {}) };
}

function commit(rows, { closeMissing = false, file = '' } = {}) {
  const p = plan(rows, { closeMissing }), d = load(), id = crypto.randomBytes(5).toString('hex'), changes = [];
  for (const e of p.items) {
    if (e.status === 'unchanged') continue;
    const s = (d.symbols[e.symbol] ??= { symbol: e.symbol, name: e.name || '', currency: e.cur, history: [] });
    if (e.name) s.name = e.name;
    if (s.currency !== e.cur) throw new Error(`${e.symbol} is tracked in ${s.currency}, but this file has it in ${e.cur}.`);
    const replaced = s.history.find((x) => x.date === e.date) || null;
    s.history = s.history.filter((x) => x.date !== e.date);
    const entry = { date: e.date, qty: e.qty, price: e.price, ...(e.cost != null ? { cost: r8(e.cost) } : {}), ...(e.status === 'closed' ? { note: 'not in the file' } : {}), batch: id };
    s.history.push(entry); s.history.sort((a, b) => a.date.localeCompare(b.date));
    changes.push({ symbol: e.symbol, date: e.date, created: e.isNewHolding, replaced });
  }
  if (!changes.length) return { id: null, added: 0, unchanged: p.counts.unchanged || 0 };
  const dates = changes.map((c) => c.date).sort();
  d.imports.unshift({ id, file: String(file).slice(0, 120), at: new Date().toISOString(), added: changes.length, from: dates[0], to: dates[dates.length - 1], changes });
  d.imports = d.imports.slice(0, 100);
  save(d);
  return { id, added: changes.length, unchanged: p.counts.unchanged || 0, counts: p.counts };
}

function undo(id) {
  const d = load(), imp = d.imports.find((x) => x.id === id);
  if (!imp || imp.undoneAt) throw new Error('Import not found or already undone.');
  for (const c of imp.changes) {
    const s = d.symbols[c.symbol]; if (!s) continue;
    s.history = s.history.filter((x) => !(x.date === c.date && x.batch === id));
    if (c.replaced) { s.history.push(c.replaced); s.history.sort((a, b) => a.date.localeCompare(b.date)); }
    if (!s.history.length) delete d.symbols[c.symbol];
  }
  imp.undoneAt = new Date().toISOString();
  save(d);
  return { removed: imp.added };
}

/** For the Assets page: each holding with its full history and the latest change. */
function list() {
  const d = load();
  const items = Object.values(d.symbols).map((s) => {
    const h = s.history, last = h[h.length - 1], prev = h[h.length - 2];
    return { symbol: s.symbol, name: s.name, currency: s.currency, qty: last?.qty ?? 0, price: last?.price ?? null, date: last?.date || null, value: last ? Math.round(last.qty * last.price * 100) / 100 : 0, cost: last?.cost ?? null,
      change: prev ? { qty: r8(last.qty - prev.qty), price: r8(last.price - prev.price), pricePct: prev.price ? Math.round(((last.price - prev.price) / prev.price) * 1000) / 10 : null, since: prev.date } : null,
      history: [...h].reverse().map(({ batch, ...e }) => e) };
  }).sort((a, b) => b.value - a.value);
  return { items, imports: d.imports.map(({ changes, ...x }) => x) };
}

/** Positions, price points and cost bases for the ledger. */
function entries() {
  const postings = [], prices = [], costs = {};
  for (const s of Object.values(load().symbols)) {
    const acct = account(s.symbol);
    let units = 0;
    for (const e of s.history) {
      if (!same(e.qty, units)) postings.push({ date: e.date, account: acct, cur: s.symbol, qty: r8(e.qty - units) });
      units = e.qty;
      prices.push({ date: e.date, from: s.symbol, to: s.currency, rate: e.price });
    }
    const last = s.history[s.history.length - 1];
    costs[acct] = { lots: last?.cost != null ? [{ amount: last.cost, cur: s.currency }] : [], uncosted: last?.cost != null ? 0 : last?.qty || 0, symbol: s.symbol };
  }
  return { postings, prices, costs };
}

const currencies = () => [...new Set(Object.values(load().symbols).map((s) => s.currency))];

module.exports = { plan, commit, undo, list, entries, symbols, currencies, account };
