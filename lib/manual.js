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

function setValuation(a, { date = today(), value, note }) {
  if (!isDate(date)) throw new Error('Date must be YYYY-MM-DD');
  const v = num(value);
  a.valuations = a.valuations.filter((x) => x.date !== date);
  a.valuations.push({ date, value: v, ...(note ? { note: String(note).slice(0, 200) } : {}) });
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
    ...(input.cost !== '' && input.cost != null ? { cost: num(input.cost) } : {}),
    ...(input.acquired ? { acquired: isDate(input.acquired) ? input.acquired : (() => { throw new Error('Acquired must be YYYY-MM-DD'); })() } : {}),
    ...(input.notes ? { notes: String(input.notes).slice(0, 300) } : {}), valuations: [],
  };
  if (input.value !== '' && input.value != null) setValuation(a, { date: input.date || a.acquired || today(), value: input.value, note: 'initial' });
  d.assets.push(a); save(d); return a;
}

function update(id, patch) {
  const d = load(), a = find(d, id);
  if (patch.name != null) a.name = String(patch.name).replace(/["\r\n]/g, '').trim().slice(0, 60) || a.name;
  if (patch.notes != null) a.notes = String(patch.notes).slice(0, 300);
  if (patch.cost !== undefined) { if (patch.cost === '' || patch.cost === null) delete a.cost; else a.cost = num(patch.cost); }
  if (patch.acquired !== undefined) { if (!patch.acquired) delete a.acquired; else if (isDate(patch.acquired)) a.acquired = patch.acquired; else throw new Error('Acquired must be YYYY-MM-DD'); }
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

function writeJournal() {
  let j = '; Generated from manual-assets.json. Do not edit.\n', p = '';
  for (const a of load().assets) {
    const first = a.valuations[0]?.date;
    const start = [a.acquired, first].filter(Boolean).sort()[0];
    if (!start) continue;
    const qty = a.kind === 'liability' ? -1 : 1;
    const cost = a.kind === 'asset' && a.cost != null && a.acquired ? ` @@ ${fmt(a.cost)} ${a.currency}` : '';
    j += `${start} ${a.kind === 'liability' ? 'Liability' : 'Asset'} ${ascii(a.name)}  ; manual:${a.id}\n    ${account(a)}  ${qty} ${sym(a)}${cost}\n    equity:manual\n\n`;
    const vals = new Map(a.valuations.map((v) => [v.date, v.value]));
    if (a.cost != null && a.acquired && !vals.has(a.acquired)) vals.set(a.acquired, a.cost);
    for (const [d, v] of [...vals].sort()) p += `P ${d} ${sym(a)} ${fmt(v)} ${a.currency}\n`;
  }
  writeAtomic(paths.valuations, j + p);
}

/** The same facts writeJournal() emits, as data: positions (1 unit of a commodity per asset) and price points (the value history). */
function entries() {
  const postings = [], prices = [];
  for (const a of load().assets) {
    const start = [a.acquired, a.valuations[0]?.date].filter(Boolean).sort()[0];
    if (!start) continue;
    postings.push({ date: start, account: account(a), cur: commodity(a), qty: a.kind === 'liability' ? -1 : 1 });
    const vals = new Map(a.valuations.map((v) => [v.date, v.value]));
    if (a.cost != null && a.acquired && !vals.has(a.acquired)) vals.set(a.acquired, a.cost);
    for (const [date, price] of vals) prices.push({ date, from: commodity(a), to: a.currency, rate: price });
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
      acquired: a.acquired || null, cost: a.cost ?? null, latest: last || null,
      change: last && prev ? { amount: last.value - prev.value, pct: prev.value ? ((last.value - prev.value) / prev.value) * 100 : null, since: prev.date } : null,
      gain: a.kind === 'asset' && a.cost != null && last ? { amount: last.value - a.cost, pct: a.cost ? ((last.value - a.cost) / a.cost) * 100 : null } : null,
      staleDays: last ? Math.round((Date.parse(today_) - Date.parse(last.date)) / 864e5) : null,
      valueBase: valueBy[account(a)] ?? null, valuations: [...vs].reverse(),
    };
  });
}

module.exports = { TYPES, entries, load, create, update, record, removeValuation, close, reopen, remove, writeJournal, currencies, summarize };
