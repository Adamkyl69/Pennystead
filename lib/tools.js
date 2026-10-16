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
function build({ write = false } = {}) {
const tools = {
  net_worth: { d: 'Net worth, liquid vs illiquid split, secured/unsecured debt, per-account values and investment gain/loss (stocks and foreign currencies converted at latest prices).', s: {}, f: () => core.wealth() },
  overview: { d: 'Full snapshot: this month, 12-month trend, budgets, subscriptions, anomalies, wealth.', s: {}, f: async () => { const o = await core.overview(); delete o.recent; delete o.wealth.manual; return o; } },
  net_worth_history: { d: 'Net worth and liquid net worth over time. range: 1M (daily), 3M, YTD, 1Y (weekly, default), All (monthly).', s: { range: str }, f: ({ range = '1Y' }) => core.wealthHistory(range) },
  manual_assets: { d: 'Manually tracked assets and liabilities (property, vehicles, pension, loans...) with latest value, change, gain vs cost and full valuation history.', s: {}, f: async () => manual.summarize((await core.wealth()).accounts, core.today()) },
  monthly_summary: { d: 'Income, spending and savings per month.', s: { months: num }, f: async ({ months = 12 }) => A.monthly(await core.transactions(), months) },
  spending_by_category: { d: 'Spending per category between two dates (YYYY-MM-DD). Defaults to last 30 days.', s: { from: str, to: str, depth: num }, f: async ({ from, to, depth }) => A.spendByCategory(await core.transactions(), from || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10), to, depth || 2) },
  budget_status: { d: 'Budget vs actual per category for a month (YYYY-MM, default current), with projection. Monthly budgets compare against that month; yearly budgets (period "year") compare year-to-date spend against the annual amount, with pace and year-end projection.', s: { month: str }, f: async ({ month }) => A.budgets(await core.transactions(), loadConfig().budgets, core.today(), month) },
  search_transactions: {
    d: 'Search transactions. Filters: text (substring of description), category (prefix), from/to dates, min/max absolute amount, limit (default 50). Amounts: negative = money out.',
    s: { text: str, category: str, from: str, to: str, min: num, max: num, limit: num },
    f: async (a) => {
      const t = (await core.transactions()).filter((x) => (!a.text || x.desc.toLowerCase().includes(a.text.toLowerCase())) && (!a.category || x.category.startsWith(a.category)) && (!a.from || x.date >= a.from) && (!a.to || x.date <= a.to) && (a.min == null || Math.abs(x.amount) >= a.min) && (a.max == null || Math.abs(x.amount) <= a.max));
      return { total: t.length, transactions: t.reverse().slice(0, a.limit || 50).map(({ date, desc, category, amount, cur, account }) => ({ date, desc, category, amount, cur, account })) };
    },
  },
  subscriptions: { d: 'Detected recurring subscriptions and bills with price increases, duplicates, overlaps, lapsed ones and yearly cost.', s: {}, f: async () => A.subscriptions(await core.transactions(), core.today()) },
  goals: { d: 'Savings goals: target, deadline, what they track, current amount, saving pace, projected date, monthly amount needed to hit the deadline, and status (on_track, behind, reached...).', s: {}, f: async () => require('./goals').list().goals.map(({ points, ...g }) => g) },
  goal_checks: { d: 'Monthly goal check history: for each month, every goal\'s status (on_track, behind, reached...), amount, change since the previous check, pace and the monthly amount needed.', s: {}, f: async () => require('./goalchecks').all().map(({ seen, ...c }) => c) },
  review_queue: { d: 'Merchants that are still uncategorized, with totals, Pennystead\'s suggested category and confidence, plus the list of existing categories.', s: {}, f: async () => { const r = await core.review(); return { merchants: r.merchants.map(({ name, count, total, dir, last, suggestion }) => ({ name, count, total, direction: dir, last, suggestion })), categories: r.categories.map((c) => c.account) }; } },
  anomalies: { d: 'Unusual charges: outsized amounts, first-time big merchants, duplicate charges, category spikes, price hikes.', s: {}, f: async () => { const t = await core.transactions(), td = core.today(); return A.anomalies(t, A.subscriptions(t, td), td, loadConfig().anomalyMin); } },
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
  d: 'Record a new value for a manual asset or liability (by id or name). Writes to the local manual-assets.json only.', s: { asset: str, value: num, date: str, note: str }, write: true,
  f: async ({ asset, value, date, note }) => {
    const a = manual.load().assets.find((x) => x.id === asset || x.name.toLowerCase() === String(asset).toLowerCase());
    if (!a) throw new Error('Unknown asset. Known: ' + manual.load().assets.map((x) => x.name).join(', '));
    manual.record(a.id, { date, value, note: note || 'via MCP' }); J.writeDerived();
    return { ok: true, asset: a.name, value, date: date || core.today() };
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

module.exports = { list, call };
