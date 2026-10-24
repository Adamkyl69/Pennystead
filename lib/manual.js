// Manual assets & liabilities (house, car, pension, crypto wallet, mortgage...).
// Source of truth: data/manual-assets.json. Each asset is 1 unit of a commodity whose value history
// is written as hledger price directives (data/valuations.journal), so hledger does the valuation.
const fs = require('fs');
const { paths, writeAtomic } = require('./config');

const TYPES = {
  property: 'Property', vehicle: 'Vehicle', pension: 'Pension / retirement', crypto: 'Crypto', savings: 'Savings / cash outside bank sync',
  business: 'Business / private equity', collectible: 'Collectibles', loan: 'Mortgage / secured loan', credit: 'Credit / unsecured debt', other: 'Other',
};
const { ascii } = require('./journal-text');
const slug = (s) => ascii(String(s)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const num = (v) => { const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.')); if (!Number.isFinite(n) || n < 0) throw new Error('Value must be a number ≥ 0'); return n; };
const fmt = (n) => (+n.toFixed(8)).toString().includes('e') ? n.toFixed(8) : String(+n.toFixed(8));
// Each asset is its own commodity. The prefix keeps an asset named "USD", "BTC" or "AAPL" from merging with the real
// currency or ticker (its valuations would otherwise become that currency's exchange rate).
const commodity = (a) => 'MANUAL_' + a.id.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
const sym = (a) => `"${commodity(a)}"`;
const LIQUID_TYPES = new Set(['crypto', 'savings']);
const isLiquid = (a) => (a.liquid ?? LIQUID_TYPES.has(a.type));
const isSecured = (a) => (a.secured ?? a.type !== 'credit');
const account = (a) => (a.kind === 'liability' ? `liabilities:${isSecured(a) ? 'secured' : 'unsecured'}:${a.id}` : `assets:manual:${isLiquid(a) ? 'liquid' : 'illiquid'}:${a.id}`);

const load = () => (fs.existsSync(paths.manualAssets) ? JSON.parse(fs.readFileSync(paths.manualAssets, 'utf8')) : { assets: [] });
function save(d) {
  fs.writeFileSync(paths.manualAssets + '.tmp', JSON.stringify(d, null, 2));
  fs.renameSync(paths.manualAssets + '.tmp', paths.manualAssets);
}
const find = (d, id) => { const a = d.assets.find((x) => x.id === id); if (!a) throw Object.assign(new Error('Unknown asset'), { status: 404 }); return a; };
const { today } = require('./dates');

const blank = (v) => v === '' || v == null;
const pos = (v, what) => { const n = num(v); if (!n) throw new Error(`${what} must be above 0`); return n; };

/**
 * A value is either a total ("the flat is worth 250 000") or units × price per unit ("12.5 shares at 80"),
 * for assets that come in units (shares, grams, coins, ...). Units carry over from the last entry when only a price is given.
 */
function setValuation(a, { date = today(), value, units, price, note }) {
  if (!isDate(date)) throw new Error('Date must be YYYY-MM-DD');
  const prior = [...a.valuations].reverse().find((x) => x.date <= date && x.units != null) || [...a.valuations].reverse().find((x) => x.units != null);
  let entry;
  if (!blank(units) || !blank(price)) {
    const u = blank(units) ? prior?.units ?? a.units : pos(units, 'Units');
    if (u == null) throw new Error('Enter how many units you hold.');
    const p = blank(price) ? (blank(value) ? null : num(value) / u) : num(price);
    if (p == null) throw new Error('Enter the price per unit.');
    entry = { date, value: Math.round(u * p * 100) / 100, units: u, price: p };
  } else {
    const v = num(value);
    // An asset that is held in units keeps its units when you only type a new total.
    const u = prior?.units ?? a.units;
    entry = u != null ? { date, value: v, units: u, price: v / u } : { date, value: v };
  }
  if (note) entry.note = String(note).slice(0, 200);
  a.valuations = a.valuations.filter((x) => x.date !== date);
  a.valuations.push(entry);
  a.valuations.sort((x, y) => x.date.localeCompare(y.date));
}

function create(input, base) {
  const name = String(input.name || '').replace(/["\r\n]/g, '').trim().slice(0, 60);
  if (!name) throw new Error('Name is required');
  const type = input.type in TYPES ? input.type : 'other';
  const currency = String(input.currency || base || '').toUpperCase();
  if (!/^[A-Z]{3,5}$/.test(currency)) throw new Error('Enter the currency as its code (3 to 5 letters).');
  const d = load();
  let id = slug(name) || 'asset';
  for (let i = 2; d.assets.some((x) => x.id === id); i++) id = `${slug(name)}-${i}`;
  const a = {
    id, name, type, kind: type === 'loan' || type === 'credit' || input.kind === 'liability' ? 'liability' : 'asset', currency,
    ...(input.liquid != null ? { liquid: !!input.liquid } : {}), ...(input.secured != null ? { secured: !!input.secured } : {}),
    ...(!blank(input.units) ? { units: pos(input.units, 'Units') } : {}),
    ...(input.unit ? { unit: String(input.unit).replace(/["\r\n]/g, '').trim().slice(0, 20) } : {}),
    ...(input.cost !== '' && input.cost != null ? { cost: num(input.cost) } : {}),
    ...(input.acquired ? { acquired: isDate(input.acquired) ? input.acquired : (() => { throw new Error('Acquired must be YYYY-MM-DD'); })() } : {}),
    ...(input.notes ? { notes: String(input.notes).slice(0, 300) } : {}), valuations: [],
  };
  if (!blank(input.units) && blank(input.value) && blank(input.price)) throw new Error('Enter the price per unit (or the total value).');
  if (!blank(input.value) || !blank(input.price)) setValuation(a, { date: input.date || a.acquired || today(), value: input.value, units: input.units, price: input.price, note: 'initial' });
  d.assets.push(a); save(d); return a;
}

function update(id, patch) {
  const d = load(), a = find(d, id);
  if (patch.name != null) a.name = String(patch.name).replace(/["\r\n]/g, '').trim().slice(0, 60) || a.name;
  if (patch.notes != null) a.notes = String(patch.notes).slice(0, 300);
  if (patch.cost !== undefined) { if (patch.cost === '' || patch.cost === null) delete a.cost; else a.cost = num(patch.cost); }
  if (patch.acquired !== undefined) { if (!patch.acquired) delete a.acquired; else if (isDate(patch.acquired)) a.acquired = patch.acquired; else throw new Error('Acquired must be YYYY-MM-DD'); }
  if (patch.unit !== undefined) { if (!patch.unit) delete a.unit; else a.unit = String(patch.unit).replace(/["\r\n]/g, '').trim().slice(0, 20); }
  if (patch.liquid != null) a.liquid = !!patch.liquid;
  if (patch.secured != null) a.secured = !!patch.secured;
  save(d); return a;
}
function record(id, v) { const d = load(), a = find(d, id); setValuation(a, v); save(d); return a; }
function removeValuation(id, date) { const d = load(), a = find(d, id); a.valuations = a.valuations.filter((x) => x.date !== date); save(d); return a; }
/** Sold / repaid: records a zero value on `date` and hides it from the active list; history stays intact. */
function close(id, date = today()) { const d = load(), a = find(d, id); setValuation(a, { date, value: 0, note: a.kind === 'liability' ? 'repaid' : 'sold / closed' }); a.closed = date; save(d); return a; }
function reopen(id) { const d = load(), a = find(d, id); delete a.closed; save(d); return a; }
function remove(id) { const d = load(); find(d, id); d.assets = d.assets.filter((x) => x.id !== id); save(d); }

/** What an asset holds over time: opening units, later changes in units, and its price per unit on each date. */
function legs(a) {
  const start = [a.acquired, a.valuations[0]?.date].filter(Boolean).sort()[0];
  if (!start) return null;
  const sign = a.kind === 'liability' ? -1 : 1;
  let units = a.valuations.find((v) => v.units != null)?.units ?? a.units ?? 1;
  const opening = units, posts = [{ date: start, qty: sign * units }], prices = new Map();
  for (const v of a.valuations) {
    if (v.units != null && Math.abs(v.units - units) > 1e-9) { posts.push({ date: v.date, qty: sign * (v.units - units) }); units = v.units; }
    prices.set(v.date, v.price ?? (units ? v.value / units : v.value));
  }
  if (a.cost != null && a.acquired && !prices.has(a.acquired)) prices.set(a.acquired, a.cost / opening);
  return { start, sign, opening, posts, prices };
}

function writeJournal() {
  let j = '; Generated from manual-assets.json. Do not edit.\n', p = '';
  for (const a of load().assets) {
    const l = legs(a);
    if (!l) continue;
    const cost = a.kind === 'asset' && a.cost != null && a.acquired ? ` @@ ${fmt(a.cost)} ${a.currency}` : '';
    const head = `${a.kind === 'liability' ? 'Liability' : 'Asset'} ${ascii(a.name)}  ; manual:${a.id}`;
    l.posts.forEach((x, i) => { j += `${x.date} ${head}\n    ${account(a)}  ${fmt(x.qty)} ${sym(a)}${i === 0 ? cost : ''}\n    equity:manual\n\n`; });
    for (const [d, v] of [...l.prices].sort()) p += `P ${d} ${sym(a)} ${fmt(v)} ${a.currency}\n`;
  }
  writeAtomic(paths.valuations, j + p);
}

/** The same facts writeJournal() emits, as data: positions (units of a commodity per asset) and price points (price per unit over time). */
function entries() {
  const postings = [], prices = [];
  for (const a of load().assets) {
    const l = legs(a);
    if (!l) continue;
    for (const x of l.posts) postings.push({ date: x.date, account: account(a), cur: commodity(a), qty: x.qty });
    for (const [date, price] of l.prices) prices.push({ date, from: commodity(a), to: a.currency, rate: price });
  }
  return { postings, prices };
}

const currencies = () => [...new Set(load().assets.map((a) => a.currency))];

/** Join stored assets with hledger account values (in base currency) for the UI. */
function summarize(wealthAccounts, today_ = today()) {
  const valueBy = Object.fromEntries(wealthAccounts.map((w) => [w.account, w.value]));
  return load().assets.map((a) => {
    const vs = a.valuations, last = vs[vs.length - 1], prev = vs[vs.length - 2];
    return {
      id: a.id, account: account(a), liquid: a.kind === 'asset' ? isLiquid(a) : null, secured: a.kind === 'liability' ? isSecured(a) : null, name: a.name, type: a.type, typeLabel: TYPES[a.type], kind: a.kind, currency: a.currency, notes: a.notes, closed: a.closed || null,
      acquired: a.acquired || null, cost: a.cost ?? null, latest: last || null, unit: a.unit || null, units: last?.units ?? a.units ?? null, unitPrice: last?.units != null ? last.price : null,
      change: last && prev ? { amount: last.value - prev.value, pct: prev.value ? ((last.value - prev.value) / prev.value) * 100 : null, since: prev.date } : null,
      gain: a.kind === 'asset' && a.cost != null && last ? { amount: last.value - a.cost, pct: a.cost ? ((last.value - a.cost) / a.cost) * 100 : null } : null,
      staleDays: last ? Math.round((Date.parse(today_) - Date.parse(last.date)) / 864e5) : null,
      valueBase: valueBy[account(a)] ?? null, valuations: [...vs].reverse(),
    };
  });
}

module.exports = { TYPES, entries, load, create, update, record, removeValuation, close, reopen, remove, writeJournal, currencies, summarize };
