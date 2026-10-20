// The data tools an AI can call: shared by the MCP server (Claude Desktop / Claude Code) and the in-app chat.
// All read-only, except record_valuation, which exists only when write access was asked for.
const hl = require('./hl');
const core = require('./core');
const A = require('./analysis');
const { loadConfig } = require('./config');
const manual = require('./manual');
const J = require('./journal');
const { redact, mode } = require('./redact');

// Subcommands allowed through hledger_query (read-only) and flags that could read other files.
const ALLOWED = new Set(['balance', 'bal', 'register', 'reg', 'incomestatement', 'is', 'balancesheet', 'bs', 'cashflow', 'cf', 'accounts', 'commodities', 'prices', 'stats', 'activity', 'print', 'aregister', 'areg']);
const BLOCKED_FLAG = /^(--file|--rules-file|--alias|--ignore-assertions)(=|$)|^-[A-Za-z]*f[A-Za-z]*$/;

// hledger is optional now (Pennystead computes everything itself); offer raw ledger queries only when it is installed.
function hledgerInstalled() { try { require('child_process').execFileSync('hledger', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } }

const num = { type: 'number' }, str = { type: 'string' };

// ---------- shared helpers for the transaction tools ----------
const { ascii } = require('./journal-text');
const r2 = (n) => Math.round(n * 100) / 100;
const val = (t) => t.value ?? t.amount; // base currency
const isOut = (t) => t.category.startsWith('expenses');
const isIn = (t) => t.category.startsWith('income');
const fold = (s) => ascii(String(s || '')).toLowerCase();
const words = (s) => fold(s).split(/[^a-z0-9]+/).filter((w) => w.length > 1);
// Loose match: each query word found in the name (prefix or a small typo), scored by how many match.
const near = (a, b) => { if (a === b) return true; if (Math.abs(a.length - b.length) > 1 || a.length < 4) return false; let i = 0, j = 0, e = 0; while (i < a.length && j < b.length) { if (a[i] === b[j]) { i++; j++; } else { if (++e > 1) return false; if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; } } } return e + (a.length - i) + (b.length - j) <= 1; };
const score = (q, w) => q.reduce((s, x) => s + (w.some((y) => y === x) ? 2 : w.some((y) => y.startsWith(x) || x.startsWith(y) && y.length >= 3 || near(x, y)) ? 1 : 0), 0);
function filterTx(txs, a) {
  const terms = a.text ? words(a.text) : [];
  return txs.filter((x) => {
    if (terms.length) { const hay = fold(x.desc + ' ' + x.merchant); if (!terms.every((w) => hay.includes(w))) return false; }
    return (!a.merchant || x.merchant === a.merchant) && (!a.category || x.category === a.category || x.category.startsWith(a.category + ':') || x.category.startsWith(a.category)) && (!a.account || x.account === a.account || x.account.endsWith(':' + a.account)) && (!a.from || x.date >= a.from) && (!a.to || x.date <= a.to) && (a.min == null || Math.abs(x.amount) >= a.min) && (a.max == null || Math.abs(x.amount) <= a.max);
  });
}

// One answer often needs several tools; inside shared() they read the transactions once instead of each loading them again.
let sharedLoad = null, sharing = 0;
const loadTx = () => (sharing ? (sharedLoad ??= core.transactions()) : core.transactions());
async function shared(fn) { sharing++; try { return await fn(); } finally { if (--sharing === 0) sharedLoad = null; } }

function build({ write = false } = {}) {
const tools = {
  net_worth: { d: 'Net worth, liquid vs illiquid split, secured/unsecured debt, per-account values and investment gain/loss (stocks and foreign currencies converted at latest prices).', s: {}, f: () => core.wealth() },
  overview: { d: 'Full snapshot: this month, 12-month trend, budgets, subscriptions, anomalies, wealth.', s: {}, f: async () => { const o = await core.overview(); delete o.recent; delete o.wealth.manual; return o; } },
  net_worth_history: { d: 'Net worth and liquid net worth over time. range: 1M (daily), 3M, YTD, 1Y (weekly, default), All (monthly).', s: { range: str }, f: ({ range = '1Y' }) => core.wealthHistory(range) },
  manual_assets: { d: 'Manually tracked assets and liabilities (property, vehicles, pension, loans...) with latest value, change, gain vs cost and full valuation history.', s: {}, f: async () => manual.summarize((await core.wealth()).accounts, core.today()) },
  monthly_summary: { d: 'Income, spending and savings per month.', s: { months: num }, f: async ({ months = 12 }) => A.monthly(await loadTx(), months) },
  spending_by_category: { d: 'Spending per category between two dates (YYYY-MM-DD). Defaults to last 30 days.', s: { from: str, to: str, depth: num }, f: async ({ from, to, depth }) => A.spendByCategory(await loadTx(), from || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10), to, depth || 2) },
  budget_status: { d: 'Budget vs actual per category for a month (YYYY-MM, default current), with projection. Monthly budgets compare against that month; yearly budgets (period "year") compare year-to-date spend against the annual amount, with pace and year-end projection.', s: { month: str }, f: async ({ month }) => A.budgets(await loadTx(), loadConfig().budgets, core.today(), month) },
  search_transactions: {
    d: 'List individual transactions, newest first. Filters: text (words that must all appear in the description or merchant; accents and case ignored), merchant (exact merchant key from the merchants tool), category (prefix, e.g. expenses:food), account, from/to dates (YYYY-MM-DD), min/max absolute amount. Paging: limit (default 50, max 200) and offset; has_more tells you to fetch the next page. For totals use aggregate instead of adding up rows. Amounts: negative = money out.',
    s: { text: str, merchant: str, category: str, account: str, from: str, to: str, min: num, max: num, limit: num, offset: num },
    f: async (a) => {
      const t = filterTx(await loadTx(), a).reverse(), limit = Math.min(Math.max(+a.limit || 50, 1), 200), offset = Math.max(+a.offset || 0, 0);
      const page = t.slice(offset, offset + limit);
      return { total: t.length, offset, returned: page.length, has_more: offset + page.length < t.length, next_offset: offset + page.length < t.length ? offset + page.length : null, transactions: page.map(({ date, desc, merchant, category, amount, cur, account }) => ({ date, desc, merchant, category, amount, cur, account })) };
    },
  },
  aggregate: {
    d: 'Exact totals grouped by merchant, category, month, year or account, in the base currency. Use this for "how much", "how often", "biggest", "per month" questions instead of listing transactions. Filters as in search_transactions (text, merchant, category, account, from, to) plus direction: "out" (spending, default), "in" (income) or "all". depth: category levels to group by (default 2, e.g. expenses:food). sort: "total" (default) or "count". limit: groups returned (default 25, max 200). Totals for out are positive amounts spent.',
    s: { group_by: str, text: str, merchant: str, category: str, account: str, from: str, to: str, direction: str, depth: num, sort: str, limit: num },
    f: async (a) => {
      const by = ['merchant', 'category', 'month', 'year', 'account', 'day'].includes(a.group_by) ? a.group_by : 'category';
      const dir = ['in', 'all'].includes(a.direction) ? a.direction : 'out', depth = Math.min(Math.max(+a.depth || 2, 1), 5);
      const rows = filterTx(await loadTx(), a).filter((t) => (dir === 'all' ? true : dir === 'out' ? isOut(t) : isIn(t)));
      const key = (t) => (by === 'merchant' ? t.merchant : by === 'category' ? t.category.split(':').slice(0, depth).join(':') : by === 'month' ? t.date.slice(0, 7) : by === 'year' ? t.date.slice(0, 4) : by === 'day' ? t.date : t.account);
      const g = new Map();
      for (const t of rows) {
        const k = key(t), v = val(t), x = g.get(k) || { key: k, label: by === 'merchant' ? t.desc : k, total: 0, count: 0, first: t.date, last: t.date };
        x.total += dir === 'out' ? -v : v; x.count++; if (t.date < x.first) x.first = t.date; if (t.date > x.last) { x.last = t.date; if (by === 'merchant') x.label = t.desc; }
        g.set(k, x);
      }
      const list = [...g.values()].map((x) => ({ ...x, total: r2(x.total), average: r2(x.total / x.count) }));
      const chrono = ['month', 'year', 'day'].includes(by) && a.sort !== 'total' && a.sort !== 'count';
      list.sort(chrono ? (p, q) => p.key.localeCompare(q.key) : a.sort === 'count' ? (p, q) => q.count - p.count : (p, q) => Math.abs(q.total) - Math.abs(p.total));
      const limit = Math.min(Math.max(+a.limit || (chrono ? 200 : 25), 1), 200);
      return { group_by: by, direction: dir, currency: loadConfig().base, groups_total: list.length, total: r2(list.reduce((s, x) => s + x.total, 0)), count: rows.length, groups: list.slice(0, limit), more_groups: Math.max(list.length - limit, 0) };
    },
  },
  compare_periods: {
    d: 'Compare two periods exactly, e.g. this quarter vs the same quarter last year: a_from/a_to and b_from/b_to (YYYY-MM-DD; a is usually the earlier one). group_by "category" (default, depth 2) or "merchant". Returns money in, money out and saved for each period, and per group the amount in each period and the change, biggest changes first.',
    s: { a_from: str, a_to: str, b_from: str, b_to: str, group_by: str, depth: num, limit: num },
    f: async (a) => {
      for (const k of ['a_from', 'a_to', 'b_from', 'b_to']) if (!/^\d{4}-\d{2}-\d{2}$/.test(a[k] || '')) throw new Error(`${k} must be a date like 2026-01-31.`);
      const txs = await loadTx(), by = a.group_by === 'merchant' ? 'merchant' : 'category', depth = Math.min(Math.max(+a.depth || 2, 1), 5);
      const pick = (from, to) => txs.filter((t) => t.date >= from && t.date <= to);
      const A_ = pick(a.a_from, a.a_to), B_ = pick(a.b_from, a.b_to);
      const sums = (rows) => { const out = r2(rows.filter(isOut).reduce((s, t) => s - val(t), 0)), inn = r2(rows.filter(isIn).reduce((s, t) => s + val(t), 0)); return { money_in: inn, money_out: out, saved: r2(inn - out), transactions: rows.length }; };
      const key = (t) => (by === 'merchant' ? t.merchant : t.category.split(':').slice(0, depth).join(':'));
      const g = new Map(), add = (rows, side) => { for (const t of rows.filter(isOut)) { const k = key(t), x = g.get(k) || { key: k, label: by === 'merchant' ? t.desc : k, a: 0, b: 0 }; x[side] -= val(t); g.set(k, x); } };
      add(A_, 'a'); add(B_, 'b');
      const groups = [...g.values()].map((x) => ({ ...x, a: r2(x.a), b: r2(x.b), change: r2(x.b - x.a), change_pct: x.a ? Math.round(((x.b - x.a) / x.a) * 100) : null })).sort((p, q) => Math.abs(q.change) - Math.abs(p.change));
      return { currency: loadConfig().base, a: { from: a.a_from, to: a.a_to, ...sums(A_) }, b: { from: a.b_from, to: a.b_to, ...sums(B_) }, spending_by_group: groups.slice(0, Math.min(+a.limit || 20, 100)), note: 'Spending per group: a and b are amounts spent; change = b - a.' };
    },
  },
  merchants: {
    d: 'Find merchants by meaning or spelling when you do not know how the bank writes them: query matches merchant names loosely (accents, case, word order and small typos ignored); without a query, lists the merchants you pay most. Use the merchant key in search_transactions or aggregate. Returns key, name, category, total spent, count, first and last date.',
    s: { query: str, limit: num },
    f: async (a) => {
      const g = new Map();
      for (const t of await loadTx()) {
        const x = g.get(t.merchant) || { key: t.merchant, name: t.desc, category: t.category, total: 0, count: 0, first: t.date, last: t.date };
        x.total -= val(t); x.count++; if (t.date < x.first) x.first = t.date; if (t.date >= x.last) { x.last = t.date; x.name = t.desc; x.category = t.category; }
        g.set(t.merchant, x);
      }
      let list = [...g.values()].map((x) => ({ ...x, total: r2(x.total) }));
      if (a.query) { const q = words(a.query); list = list.map((x) => ({ x, s: score(q, words(x.name + ' ' + x.key)) })).filter((r) => r.s > 0).sort((p, q2) => q2.s - p.s || Math.abs(q2.x.total) - Math.abs(p.x.total)).map((r) => r.x); }
      else list.sort((p, q) => q.total - p.total);
      const limit = Math.min(Math.max(+a.limit || 30, 1), 200);
      return { merchants_total: list.length, merchants: list.slice(0, limit) };
    },
  },
  subscriptions: { d: 'Detected recurring subscriptions and bills with price increases, duplicates, overlaps, lapsed ones and yearly cost.', s: {}, f: async () => A.subscriptions(await loadTx(), core.today()) },
  goals: { d: 'Savings goals: target, deadline, what they track, current amount, saving pace, projected date, monthly amount needed to hit the deadline, and status (on_track, behind, reached...).', s: {}, f: async () => require('./goals').list().goals.map(({ points, ...g }) => g) },
  goal_checks: { d: 'Monthly goal check history: for each month, every goal\'s status (on_track, behind, reached...), amount, change since the previous check, pace and the monthly amount needed.', s: {}, f: async () => require('./goalchecks').all().map(({ seen, ...c }) => c) },
  review_queue: { d: 'Merchants that are still uncategorized, with totals, Pennystead\'s suggested category and confidence, plus the list of existing categories.', s: {}, f: async () => { const r = await core.review(); return { merchants: r.merchants.map(({ name, count, total, dir, last, suggestion }) => ({ name, count, total, direction: dir, last, suggestion })), categories: r.categories.map((c) => c.account) }; } },
  anomalies: { d: 'Unusual charges: outsized amounts, first-time big merchants, duplicate charges, category spikes, price hikes.', s: {}, f: async () => { const t = await loadTx(), td = core.today(); return A.anomalies(t, A.subscriptions(t, td), td, loadConfig().anomalyMin); } },
  ...(hledgerInstalled() ? { hledger_query: {
    d: 'Run a read-only hledger report, e.g. ["bal","expenses","-M","-X","EUR"] or ["reg","groceries","-p","last month"]. Disabled when REDACT=full.',
    s: { args: { type: 'array', items: str } },
    f: async ({ args = [] }) => {
      if (mode === 'full') throw new Error('hledger_query is disabled when REDACT=full.');
      if (!args.length || !ALLOWED.has(args[0])) throw new Error('Allowed subcommands: ' + [...ALLOWED].join(', '));
      if (args.some((x) => BLOCKED_FLAG.test(x))) throw new Error('That flag is not allowed.');
      return { output: await hl.run(args) };
    },
  },
} : {}),
};

if (write) tools.record_valuation = {
  d: 'Record a new value for a manual asset, investment or liability (by id, name or ticker). For an investment or other asset held in units, give price (one unit) and units when the number held changed; otherwise give value. Adds a dated point to its history (the same date replaces that day). Writes to the local manual-assets.json only.', s: { asset: str, value: num, units: num, price: num, date: str, note: str }, write: true,
  f: async ({ asset, value, units, price, date, note }) => {
    const a = manual.load().assets.find((x) => x.id === asset || x.name.toLowerCase() === String(asset).toLowerCase() || (x.symbol && x.symbol === String(asset).toUpperCase()));
    if (!a) throw new Error('Unknown asset. Known: ' + manual.load().assets.map((x) => x.name).join(', '));
    const saved = manual.record(a.id, { date, value, units, price, note: note || 'via MCP' }).valuations.find((v) => v.date === (date || core.today()));
    J.writeDerived();
    return { ok: true, asset: a.name, ...saved };
  },
};

return tools;
}

let cache = {};
const get = (write) => (cache[write] ??= build({ write }));
/** Tool list in the JSON-schema shape both MCP and OpenAI-style function calling use. */
const list = ({ write = false } = {}) => Object.entries(get(write)).map(([name, t]) => ({ name, description: t.d, inputSchema: { type: 'object', properties: t.s }, write: !!t.write }));
/** Runs a tool; the result is redacted (IBANs, card numbers, and names when REDACT=full). */
async function call(name, args = {}, { write = false } = {}) {
  const t = get(write)[name];
  if (!t) throw new Error('Unknown tool ' + name);
  return redact(await t.f(args || {}));
}

module.exports = { list, call, shared };
