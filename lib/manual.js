// Manual assets & liabilities (house, car, pension, crypto wallet, investments, mortgage...).
// Source of truth: data/manual-assets.json. Each asset is its own commodity whose value history is written as
// hledger price directives (data/valuations.journal), so hledger does the valuation. Most assets are 1 unit whose
// price is the value. An asset tracked in units (shares, fund units, grams, coins: `perUnit`) holds that many units,
// and each valuation records the units held and the price of one unit on that date; its value is units × price.
const fs = require('fs');
const { paths, writeAtomic } = require('./config');

const TYPES = {
  property: 'Property', vehicle: 'Vehicle', pension: 'Pension / retirement', investment: 'Investments (stocks, funds)', crypto: 'Crypto', commodity: 'Precious metals / commodities', savings: 'Savings / cash outside bank sync',
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
const LIQUID_TYPES = new Set(['crypto', 'savings', 'investment']);
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

const r6 = (n) => Math.round(n * 1e6) / 1e6;
/** Units held on a date: from the latest valuation on or before it (0 before the first one). */
const unitsAt = (a, date) => { let u = 0; for (const v of a.valuations) if (v.date <= date) u = v.units ?? u; return u; };

/**
 * Records the value on a date (one entry per date: the same date again replaces it). For an asset tracked in units,
 * give the price of one unit and, when the number held changed, the units; otherwise the units held stay as they were.
 * A total value without a price works too (the price is then value ÷ units).
 */
function setValuation(a, { date = today(), value, units, price, note }) {
  if (!isDate(date)) throw new Error('Date must be YYYY-MM-DD');
  const e = { date };
  if (a.perUnit) {
    const u = units !== '' && units != null ? num(units) : unitsAt(a, date);
    if (price !== '' && price != null) e.price = num(price);
    else if (value !== '' && value != null) { if (!u) throw new Error('Enter the number of units, or the price of one unit.'); e.price = r6(num(value) / u); }
    else throw new Error('Enter the price of one unit.');
    e.units = u; e.value = r6(u * e.price);
  } else e.value = num(value);
  if (note) e.note = String(note).slice(0, 200);
  a.valuations = a.valuations.filter((x) => x.date !== date);
  a.valuations.push(e);
  a.valuations.sort((x, y) => x.date.localeCompare(y.date));
  return e;
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
  const kind = type === 'loan' || type === 'credit' || input.kind === 'liability' ? 'liability' : 'asset';
  const perUnit = kind === 'asset' && (!!input.perUnit || (input.units !== '' && input.units != null));
  const a = {
    id, name, type, kind, currency, ...(perUnit ? { perUnit: true, unit: String(input.unit || 'units').replace(/["\r\n]/g, '').trim().slice(0, 20) || 'units' } : {}),
    ...(input.symbol ? { symbol: String(input.symbol).replace(/["\r\n]/g, '').trim().toUpperCase().slice(0, 24) } : {}),
    ...(input.liquid != null ? { liquid: !!input.liquid } : {}), ...(input.secured != null ? { secured: !!input.secured } : {}),
    ...(input.cost !== '' && input.cost != null ? { cost: num(input.cost) } : {}),
    ...(input.acquired ? { acquired: isDate(input.acquired) ? input.acquired : (() => { throw new Error('Acquired must be YYYY-MM-DD'); })() } : {}),
    ...(input.notes ? { notes: String(input.notes).slice(0, 300) } : {}), valuations: [],
  };
  const has = (v) => v !== '' && v != null;
  if (has(input.value) || (perUnit && has(input.price))) setValuation(a, { date: input.date || a.acquired || today(), value: input.value, units: input.units, price: input.price, note: input.note || 'initial' });
  d.assets.push(a); save(d); return a;
}

function update(id, patch) {
  const d = load(), a = find(d, id);
  if (patch.name != null) a.name = String(patch.name).replace(/["\r\n]/g, '').trim().slice(0, 60) || a.name;
  if (patch.notes != null) a.notes = String(patch.notes).slice(0, 300);
  if (patch.symbol != null) { const v = String(patch.symbol).replace(/["\r\n]/g, '').trim().toUpperCase().slice(0, 24); if (v) a.symbol = v; else delete a.symbol; }
  if (patch.unit != null && a.perUnit) a.unit = String(patch.unit).replace(/["\r\n]/g, '').trim().slice(0, 20) || a.unit;
  if (patch.cost !== undefined) { if (patch.cost === '' || patch.cost === null) delete a.cost; else a.cost = num(patch.cost); }
  if (patch.acquired !== undefined) { if (!patch.acquired) delete a.acquired; else if (isDate(patch.acquired)) a.acquired = patch.acquired; else throw new Error('Acquired must be YYYY-MM-DD'); }
  if (patch.liquid != null) a.liquid = !!patch.liquid;
  if (patch.secured != null) a.secured = !!patch.secured;
  save(d); return a;
}
function record(id, v) { const d = load(), a = find(d, id); setValuation(a, v); save(d); return a; }
/** Several valuations in one save (an investment import). items: [{ id, ...valuation }] */
function recordMany(items) { const d = load(); for (const { id, ...v } of items) setValuation(find(d, id), v); save(d); }
function removeValuation(id, date) { const d = load(), a = find(d, id); a.valuations = a.valuations.filter((x) => x.date !== date); save(d); return a; }
/** Sold / repaid: records a zero value on `date` and hides it from the active list; history stays intact. */
function close(id, date = today()) { const d = load(), a = find(d, id); setValuation(a, a.perUnit ? { date, units: 0, price: a.valuations[a.valuations.length - 1]?.price ?? 0, note: 'sold / closed' } : { date, value: 0, note: a.kind === 'liability' ? 'repaid' : 'sold / closed' }); a.closed = date; save(d); return a; }
function reopen(id) { const d = load(), a = find(d, id); delete a.closed; save(d); return a; }
function remove(id) { const d = load(); find(d, id); d.assets = d.assets.filter((x) => x.id !== id); save(d); }

/**
 * The ledger facts of one asset: when it starts, the quantity changes (dated postings) and its prices.
 * 1-unit assets: one posting of ±1 at the start and the values as prices (the cost on the acquired date when no value
 * was recorded then). Assets in units: a posting whenever the units held change, and the unit prices.
 */
function facts(a) {
  const start = [a.acquired, a.valuations[0]?.date].filter(Boolean).sort()[0];
  if (!start) return null;
  const sign = a.kind === 'liability' ? -1 : 1, moves = [], prices = new Map();
  if (!a.perUnit) {
    moves.push({ date: start, qty: sign });
    for (const v of a.valuations) prices.set(v.date, v.value);
    if (a.cost != null && a.acquired && !prices.has(a.acquired)) prices.set(a.acquired, a.cost);
  } else {
    let held = 0;
    for (const v of a.valuations) { const u = v.units ?? held; if (u !== held) moves.push({ date: v.date, qty: r6(u - held) }); held = u; prices.set(v.date, v.price ?? (u ? v.value / u : 0)); }
    // Bought before the first recorded value: the units count from the purchase date, priced at what they cost.
    const first = a.valuations.find((v) => v.units);
    if (first && a.acquired && a.acquired < first.date && moves[0]) { moves[0].date = a.acquired; if (a.cost != null && !prices.has(a.acquired)) prices.set(a.acquired, r6(a.cost / first.units)); }
  }
  return { start, moves, prices: [...prices].sort((x, y) => x[0].localeCompare(y[0])) };
}

function writeJournal() {
  let j = '; Generated from manual-assets.json. Do not edit.\n', p = '';
  for (const a of load().assets) {
    const f = facts(a);
    if (!f) continue;
    f.moves.forEach((m, i) => {
      const cost = i === 0 && a.kind === 'asset' && a.cost != null && a.acquired ? ` @@ ${fmt(a.cost)} ${a.currency}` : '';
      j += `${m.date} ${a.kind === 'liability' ? 'Liability' : 'Asset'} ${ascii(a.name)}${i ? ' (units)' : ''}  ; manual:${a.id}\n    ${account(a)}  ${fmt(m.qty)} ${sym(a)}${cost}\n    equity:manual\n\n`;
    });
    for (const [d, v] of f.prices) p += `P ${d} ${sym(a)} ${fmt(v)} ${a.currency}\n`;
  }
  writeAtomic(paths.valuations, j + p);
}

/** The same facts writeJournal() emits, as data: positions (units of a commodity per asset) and price points (the value history). */
function entries() {
  const postings = [], prices = [];
  for (const a of load().assets) {
    const f = facts(a);
    if (!f) continue;
    for (const m of f.moves) postings.push({ date: m.date, account: account(a), cur: commodity(a), qty: m.qty });
    for (const [date, price] of f.prices) prices.push({ date, from: commodity(a), to: a.currency, rate: price });
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
      id: a.id, account: account(a), perUnit: !!a.perUnit, unit: a.unit || null, symbol: a.symbol || null, units: a.perUnit ? (last?.units ?? 0) : null, price: a.perUnit ? (last?.price ?? null) : null, liquid: a.kind === 'asset' ? isLiquid(a) : null, secured: a.kind === 'liability' ? isSecured(a) : null, name: a.name, type: a.type, typeLabel: TYPES[a.type], kind: a.kind, currency: a.currency, notes: a.notes, closed: a.closed || null,
      acquired: a.acquired || null, cost: a.cost ?? null, latest: last || null,
      change: last && prev ? { amount: last.value - prev.value, pct: prev.value ? ((last.value - prev.value) / prev.value) * 100 : null, since: prev.date } : null,
      priceChange: a.perUnit && last?.price != null && prev?.price != null ? { amount: last.price - prev.price, pct: prev.price ? ((last.price - prev.price) / prev.price) * 100 : null, since: prev.date } : null,
      gain: a.kind === 'asset' && a.cost != null && last ? { amount: last.value - a.cost, pct: a.cost ? ((last.value - a.cost) / a.cost) * 100 : null } : null,
      staleDays: last ? Math.round((Date.parse(today_) - Date.parse(last.date)) / 864e5) : null,
      valueBase: valueBy[account(a)] ?? null, valuations: [...vs].reverse(),
    };
  });
}

module.exports = { TYPES, account, entries, load, create, update, record, recordMany, removeValuation, close, reopen, remove, writeJournal, currencies, summarize };
