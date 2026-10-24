// Native ledger engine: net worth, valuation at market prices, history, and normalized transactions,
// computed directly from Pennystead's own data. No external program is needed (hledger is optional; see hl.js).
//
// Model (same as the generated journals): every holding is a quantity of a commodity in an account; prices are
// dated "1 FROM = rate TO" points. A balance is valued with the latest price on or before the valuation date,
// following price chains (e.g. AAPL → USD → EUR) and reversed prices, exactly like hledger's --value.
const fs = require('fs');
const store = require('./store');
const { today } = require('./dates');
const manual = require('./manual');
const investments = require('./investments');
const A = require('./analysis');
const J = require('./journal');
const { paths, loadConfig } = require('./config');

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => iso(new Date(Date.parse(s) + n * 864e5));
const round = (n) => Math.round(n * 1e6) / 1e6;

/** Everything the engine needs, derived from the stores. */
function build() {
  const cfg = loadConfig(), txs = store.txs(), ov = store.overrides(), accts = store.accounts();
  const postings = [], norm = [], costs = {};
  for (const m of Object.values(accts)) if (m.opening) postings.push({ date: m.opening.date, account: 'assets:bank:' + m.name, cur: m.opening.cur, qty: m.opening.amount });
  const sorted = Object.entries(txs).map(([id, t], i) => ({ id, t, i })).sort((a, b) => a.t.date.localeCompare(b.t.date) || a.i - b.i);
  for (const { id, t } of sorted) {
    postings.push({ date: t.date, account: t.acct, cur: t.cur, qty: t.amount });
    const category = ov[id] || J.categorize(t.text, t.amount < 0 ? 'out' : 'in', cfg.rules);
    if (/^(expenses|income|transfers)(:|$)/.test(category)) norm.push({ id, date: t.date, desc: t.desc, merchant: A.merchantKey(t.desc), account: t.acct, category, amount: t.amount, cur: t.cur });
  }
  const dflt = postings.map((p) => p.date).sort()[0] || today();
  const imported = investments.entries(), importedSymbols = investments.symbols();
  postings.push(...imported.postings); Object.assign(costs, imported.costs);
  for (const x of cfg.holdings) {
    if (importedSymbols.has(x.symbol)) continue; // the imported history is the truth for that holding
    const account = 'assets:investments:' + J.slug(x.symbol);
    postings.push({ date: x.since || dflt, account, cur: x.symbol, qty: x.qty });
    // Several lots of one holding add up (like hledger's @@ costs); a lot without a cost is valued at market.
    const c = (costs[account] ??= { lots: [], uncosted: 0, symbol: x.symbol });
    if (x.cost != null) c.lots.push({ amount: x.cost, cur: x.currency || 'USD' }); else c.uncosted += x.qty;
  }
  for (const c of cfg.cash) postings.push({ date: c.since || dflt, account: c.account || 'assets:cash:' + J.slug(c.currency), cur: c.currency, qty: c.amount });
  const m = manual.entries();
  postings.push(...m.postings);

  const prices = [...m.prices, ...imported.prices];
  if (fs.existsSync(paths.prices)) for (const l of fs.readFileSync(paths.prices, 'utf8').split('\n')) {
    const x = l.match(/^P\s+(\d{4}-\d{2}-\d{2})\s+("[^"]+"|\S+)\s+(-?[\d.]+)\s+("[^"]+"|\S+)/);
    if (x) prices.push({ date: x[1], from: x[2].replace(/"/g, ''), to: x[4].replace(/"/g, ''), rate: parseFloat(x[3]) });
  }
  return { postings, prices, costs, txs: norm, base: cfg.base };
}

/** Price lookup: latest price on or before a date; chains and reversed prices are followed (shortest path). */
function priceBook(prices) {
  const series = new Map(); // "FROM>TO" -> [{date, rate}] sorted
  for (const p of prices) { const k = `${p.from}>${p.to}`; (series.get(k) || series.set(k, []).get(k)).push(p); }
  for (const v of series.values()) v.sort((a, b) => a.date.localeCompare(b.date));
  const edges = new Map(); // commodity -> [{to, key, inv}]
  const add = (a, b, key, inv) => (edges.get(a) || edges.set(a, []).get(a)).push({ to: b, key, inv });
  for (const k of series.keys()) { const [a, b] = k.split('>'); add(a, b, k, false); add(b, a, k, true); }
  // A declared price beats a reversed one for the same pair, whatever order the prices were written in (as in hledger).
  for (const list of edges.values()) list.sort((x, y) => x.inv - y.inv);
  const rateAt = (key, date) => { const v = series.get(key); let r = null; for (let i = 0; i < v.length && v[i].date <= date; i++) r = v[i].rate; return r; };
  return function convert(qty, from, to, date) {
    if (from === to) return qty;
    const seen = new Map([[from, qty]]);
    let frontier = [from];
    for (let depth = 0; depth < 4 && frontier.length; depth++) {
      const next = [];
      for (const c of frontier) for (const e of edges.get(c) || []) {
        if (seen.has(e.to)) continue;
        const r = rateAt(e.key, date);
        if (r == null || (r === 0 && e.inv)) continue; // a price of 0 is valid (a sold asset is worth 0), but cannot be inverted
        seen.set(e.to, seen.get(c) * (e.inv ? 1 / r : r));
        if (e.to === to) return seen.get(to);
        next.push(e.to);
      }
      frontier = next;
    }
    return null; // no price path: the amount stays in its own commodity
  };
}

const under = (account, prefixes) => prefixes.some((p) => account === p || account.startsWith(p));

/**
 * Balances per account for accounts starting with any prefix.
 * value: { target, date } converts every commodity that has a price path; the rest stays in its own commodity.
 * until: only postings dated on or before this day (omit for everything).
 */
function balances(L, prefixes, { value, until } = {}) {
  const by = new Map();
  for (const p of L.postings) {
    if (!under(p.account, prefixes) || (until && p.date > until)) continue;
    const m = by.get(p.account) || by.set(p.account, new Map()).get(p.account);
    m.set(p.cur, (m.get(p.cur) || 0) + p.qty);
  }
  const convert = value ? priceBook(L.prices) : null;
  const rows = [];
  for (const [account, m] of [...by].sort((a, b) => a[0].localeCompare(b[0]))) {
    const amounts = {};
    for (const [cur, q] of m) {
      if (Math.abs(q) < 1e-9) continue;
      const v = convert ? convert(q, cur, value.target, value.date) : null;
      if (v == null) amounts[cur] = (amounts[cur] || 0) + q; else amounts[value.target] = (amounts[value.target] || 0) + v;
    }
    for (const c of Object.keys(amounts)) if (Math.abs(amounts[c]) < 1e-9) delete amounts[c]; // zero balances are not listed
    if (Object.keys(amounts).length) rows.push({ account, amounts: Object.fromEntries(Object.entries(amounts).map(([c, v]) => [c, round(v)])) });
  }
  return rows;
}

/** Cost basis of each investment account in the target currency, valued at the given date (market value when no cost is recorded). */
function costBasis(L, target, date) {
  const convert = priceBook(L.prices), out = {};
  for (const r of balances(L, ['assets:investments'])) {
    const c = L.costs[r.account];
    if (c?.lots.length) { let v = 0; for (const l of c.lots) v += convert(l.amount, l.cur, target, date) ?? 0; if (c.uncosted) v += convert(c.uncosted, c.symbol, target, date) ?? 0; out[r.account] = round(v); }
    else { const [cur, q] = Object.entries(r.amounts)[0]; const v = convert(q, cur, target, date); out[r.account] = round(v ?? 0); }
  }
  return out;
}

/** Total of the given account groups, valued at the end of each period (cumulative balances, like hledger --historical). */
function series(L, groups, step, from, to, target) {
  const starts = [];
  if (step === 'month') { for (let d = new Date(from + 'T00:00:00Z'); iso(d) < to; d.setUTCMonth(d.getUTCMonth() + 1)) starts.push(iso(d)); }
  else { const n = step === 'week' ? 7 : 1; for (let d = from; d < to; d = addDays(d, n)) starts.push(d); }
  const convert = priceBook(L.prices);
  const posts = L.postings.filter((p) => groups.some((g) => under(p.account, g.prefixes)));
  const out = groups.map(() => []);
  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : to, last = addDays(end, -1);
    groups.forEach((g, gi) => {
      const q = new Map(); // cumulative quantity per commodity across the group's accounts
      for (const p of posts) if (p.date <= last && under(p.account, g.prefixes)) q.set(p.cur, (q.get(p.cur) || 0) + p.qty);
      let total = 0;
      for (const [cur, v] of q) { const x = convert(v, cur, target, last); if (x != null) total += x; }
      out[gi].push({ date: start, value: round(total) });
    });
  });
  return out;
}

module.exports = { build, balances, costBasis, series, priceBook, iso, addDays };
