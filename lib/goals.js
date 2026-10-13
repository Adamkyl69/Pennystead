// Savings goals: a target amount, optionally by a date, tracked against either a whole-picture balance (liquid net
// worth or net worth) or specific accounts. Accounts can be shared between goals by earmarking: each goal takes
// "up to an amount", "a percentage" or "what is left" of an account, so the same money is never counted twice.
// A goal can count everything already there, or only what is added after it was set up.
// Progress comes from the real balance history; the projection continues your actual saving pace of the last
// 6 months (or a monthly amount you set), optionally with an expected yearly return.
const crypto = require('crypto');
const ledger = require('./ledger');
const manual = require('./manual');
const store = require('./store');
const { loadConfig, saveConfig } = require('./config');
const { today } = require('./dates');

const r2 = (n) => Math.round(n * 100) / 100 + 0;
const LIQUID = ['assets:bank', 'assets:cash', 'assets:investments', 'assets:manual:liquid', 'liabilities:unsecured'];
const WHOLE = { liquid: { label: 'Liquid net worth (cash, investments, liquid assets, minus card debt)', prefixes: LIQUID }, net: { label: 'Net worth (everything)', prefixes: ['assets', 'liabilities'] } };
const SHARES = ['rest', 'amount', 'percent'];
const MAX_MONTHS = 600; // 50 years: beyond that a goal is "not reachable at this pace"

const monthStart = (d) => d.slice(0, 7) + '-01';
const addMonths = (d, n) => { const [y, m] = d.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1 + n, 1)); return t.toISOString().slice(0, 10); };
const monthsBetween = (a, b) => (+b.slice(0, 4) - +a.slice(0, 4)) * 12 + (+b.slice(5, 7) - +a.slice(5, 7));

/** Accounts a goal can use: { account, label }. "All investments" is one entry covering every holding. */
function accountChoices(L = ledger.build()) {
  const names = Object.fromEntries(Object.values(store.accounts()).map((a) => ['assets:bank:' + a.name, a.label || a.name]));
  const man = Object.fromEntries(manual.summarize([]).map((a) => [a.account, a.name]));
  const accts = [...new Set(L.postings.map((p) => p.account))].filter((a) => a.startsWith('assets:')).sort();
  const out = [];
  for (const a of accts) if (a.startsWith('assets:bank') || a.startsWith('assets:cash') || a.startsWith('assets:manual')) out.push({ account: a, label: names[a] || man[a] || (a.startsWith('assets:cash:') ? `Cash (${a.split(':').pop().toUpperCase()})` : a.split(':').pop()) });
  if (accts.some((a) => a.startsWith('assets:investments'))) out.push({ account: 'assets:investments', label: 'All investments' });
  return out;
}

/** Older goals tracked one "acct:<account>"; they become a single "what is left" link to that account. */
function normalize(g) {
  if (g.source?.startsWith('acct:')) return { ...g, source: 'accounts', accounts: [{ account: g.source.slice(5), share: 'rest' }] };
  return { start: 'all', baseline: 0, accounts: [], ...g };
}

/** Monthly amount needed to go from `v` to `target` in `n` months at monthly growth `g` (end-of-month saving). */
function needed(v, target, n, g) {
  if (n <= 0) return null;
  if (!g) return (target - v) / n;
  const f = (1 + g) ** n;
  return ((target - v * f) * g) / (f - 1);
}

/**
 * Split one account balance between the goals that use it. Percentages are taken first (of the whole balance),
 * then fixed amounts in goal order, then whatever is left is shared equally by the "what is left" goals.
 * links: [{ goal, share, value }]. Returns Map(goal -> amount) and the unallocated remainder.
 */
function split(balance, links) {
  const out = new Map(links.map((l) => [l.goal, 0]));
  if (balance <= 0) { const rest = links.filter((l) => l.share === 'rest'); if (rest.length) for (const l of rest) out.set(l.goal, balance / rest.length); return { parts: out, left: rest.length ? 0 : balance }; }
  let left = balance;
  for (const l of links.filter((x) => x.share === 'percent')) { const a = Math.min(left, (balance * l.value) / 100); out.set(l.goal, a); left -= a; }
  for (const l of links.filter((x) => x.share === 'amount')) { const a = Math.min(left, l.value); out.set(l.goal, a); left -= a; }
  const rest = links.filter((l) => l.share === 'rest');
  for (const l of rest) out.set(l.goal, left / rest.length);
  return { parts: out, left: rest.length ? 0 : left };
}

/** Month-end history (last 12 months to today) for every goal, after earmarking. Map(goalId -> [{month, value}]). */
function histories(goals, L, base, from, to) {
  const out = new Map();
  for (const g of goals.filter((x) => x.source !== 'accounts')) {
    const s = ledger.series(L, [{ prefixes: (WHOLE[g.source] || WHOLE.liquid).prefixes }], 'month', from, to, base)[0];
    out.set(g.id, s.map((p) => ({ month: p.date.slice(0, 7), value: p.value })));
  }
  const used = [...new Set(goals.filter((x) => x.source === 'accounts').flatMap((g) => g.accounts.map((a) => a.account)))];
  if (!used.length) return { hist: out, accountSeries: new Map() };
  const series = ledger.series(L, used.map((a) => ({ prefixes: [a] })), 'month', from, to, base);
  const accountSeries = new Map(used.map((a, i) => [a, series[i]]));
  const months = series[0].map((p) => p.date.slice(0, 7));
  for (const g of goals.filter((x) => x.source === 'accounts')) out.set(g.id, months.map((month) => ({ month, value: 0 })));
  for (const a of used) {
    const links = goals.filter((g) => g.source === 'accounts').flatMap((g) => g.accounts.filter((x) => x.account === a).map((x) => ({ goal: g.id, share: x.share, value: +x.value || 0 })));
    accountSeries.get(a).forEach((p, i) => { for (const [goal, amt] of split(p.value, links).parts) out.get(goal)[i].value += amt; });
  }
  return { hist: out, accountSeries, months };
}

/** Everything the Goals page and the chart need for one goal, from its (earmarked) balance history. */
function compute(goal, rawHist) {
  const t = today(), hist = rawHist.map((h) => ({ month: h.month, value: r2(h.value) }));
  const raw = hist.length ? hist[hist.length - 1].value : 0;
  // "Only what I add from now on": progress is measured from the balance the goal had when it was set up.
  const base0 = goal.start === 'new' ? +goal.baseline || 0 : 0, startMonth = goal.start === 'new' && goal.startDate ? goal.startDate.slice(0, 7) : null;
  const current = r2(raw - base0);
  const look = Math.min(6, hist.length - 1), pace = look > 0 ? (raw - hist[hist.length - 1 - look].value) / look : null;
  const monthly = goal.monthly != null ? +goal.monthly : pace, g = (+goal.growth || 0) / 1200;
  const target = +goal.target, reached = current >= target;

  let v = current, reachIn = reached ? 0 : null;
  const proj = [];
  for (let k = 1; k <= MAX_MONTHS && monthly != null; k++) {
    v = v * (1 + g) + monthly;
    proj.push(v);
    if (reachIn == null && v >= target) { reachIn = k; if (!goal.by) break; }
    if (goal.by && k >= monthsBetween(t, goal.by) && reachIn != null) break;
  }
  const byIn = goal.by ? Math.max(1, monthsBetween(t, goal.by)) : null;
  const need = goal.by && !reached ? needed(current, target, byIn, g) : null;
  const status = reached ? 'reached' : monthly == null ? 'no_history' : reachIn == null ? 'not_reachable' : !goal.by ? 'projected' : reachIn <= byIn ? 'on_track' : 'behind';

  // Chart: 12 months of history (from the start month for "only new" goals), then the future through the deadline.
  const horizon = Math.min(300, Math.max(6, byIn ? byIn + 1 : 0, reachIn != null ? reachIn + 2 : 24));
  const points = hist.map((h, i) => {
    const last = i === hist.length - 1, shown = !startMonth || h.month >= startMonth;
    return { month: h.month, actual: shown ? r2(h.value - base0) : null, projected: last ? current : null, needed: last && need != null ? current : null };
  });
  let nv = current;
  for (let k = 1; k <= horizon; k++) {
    if (need != null && k <= byIn) nv = nv * (1 + g) + need;
    points.push({ month: addMonths(monthStart(t), k).slice(0, 7), actual: null, projected: proj[k - 1] != null ? r2(proj[k - 1]) : null, needed: need != null && k <= byIn ? r2(nv) : null });
  }
  return {
    ...goal, current, target, remaining: r2(Math.max(0, target - current)),
    pct: target ? Math.max(0, Math.min(100, Math.round((current / target) * 100))) : 100, pace: pace == null ? null : r2(pace), monthlyUsed: monthly == null ? null : r2(monthly),
    reachDate: reachIn == null ? null : addMonths(monthStart(t), reachIn).slice(0, 7), neededMonthly: need == null ? null : r2(Math.max(0, need)),
    status, points, deadlineMonth: goal.by ? goal.by.slice(0, 7) : null,
  };
}

const label = (g, choices) => (g.source === 'accounts' ? g.accounts.map((a) => choices.find((c) => c.account === a.account)?.label || a.account.split(':').pop()).join(' + ') || 'No accounts' : (WHOLE[g.source] || WHOLE.liquid).label);

function list() {
  const L = ledger.build(), base = loadConfig().base, t = today(), choices = accountChoices(L);
  const gs = (loadConfig().goals || []).map(normalize);
  const { hist, accountSeries } = histories(gs, L, base, addMonths(monthStart(t), -12), ledger.addDays(t, 1));
  const goals = gs.map((g) => ({ ...compute(g, hist.get(g.id)), sourceLabel: label(g, choices) }));
  // How each shared account is divided today: the "Where your savings sit" table.
  const allocations = [...accountSeries].map(([account, s]) => {
    const links = gs.filter((g) => g.source === 'accounts').flatMap((g) => g.accounts.filter((x) => x.account === account).map((x) => ({ goal: g.id, name: g.name, share: x.share, value: +x.value || 0 })));
    const balance = s.at(-1).value, { parts, left } = split(balance, links);
    const asked = links.reduce((sum, l) => sum + (l.share === 'amount' ? l.value : l.share === 'percent' ? (balance * l.value) / 100 : 0), 0);
    return { account, label: choices.find((c) => c.account === account)?.label || account, balance: r2(balance), parts: links.map((l) => ({ goal: l.goal, name: l.name, share: l.share, value: l.value, amount: r2(parts.get(l.goal)) })), unallocated: r2(left), short: r2(Math.max(0, asked - Math.max(balance, 0))) };
  });
  return { base, goals, accounts: choices, allocations, sources: [{ id: 'liquid', label: WHOLE.liquid.label }, { id: 'net', label: WHOLE.net.label }, { id: 'accounts', label: 'Specific accounts' }] };
}

/** The goal's balance right now (after earmarking), used as the starting point for "only what I add from now on". */
function balanceNow(goal) {
  const L = ledger.build(), base = loadConfig().base, t = today();
  const others = (loadConfig().goals || []).map(normalize).filter((g) => g.id !== goal.id);
  const { hist } = histories([...others, { ...goal, id: goal.id || '__new' }], L, base, monthStart(t), ledger.addDays(t, 1));
  return r2(hist.get(goal.id || '__new').at(-1).value);
}

function clean(input, old = {}) {
  const g = normalize({ ...old });
  if (input.name !== undefined) { g.name = String(input.name).trim().slice(0, 60); if (!g.name) throw new Error('Give the goal a name.'); }
  if (input.target !== undefined) { g.target = +input.target; if (!(g.target > 0)) throw new Error('The target must be an amount above 0.'); }
  if (input.by !== undefined) { g.by = input.by || null; if (g.by && (!/^\d{4}-\d{2}-\d{2}$/.test(g.by) || g.by <= today())) throw new Error('The target date must be in the future.'); }
  if (input.source !== undefined) {
    if (input.source.startsWith?.('acct:')) { input = { ...input, source: 'accounts', accounts: [{ account: input.source.slice(5), share: 'rest' }] }; }
    if (!['liquid', 'net', 'accounts'].includes(input.source)) throw new Error('Unknown balance to track.');
    g.source = input.source;
  }
  if (input.accounts !== undefined) {
    const known = new Set(accountChoices().map((c) => c.account)), seen = new Set();
    if (!Array.isArray(input.accounts)) throw new Error('Choose the accounts this goal uses.');
    g.accounts = input.accounts.map((a) => {
      if (!known.has(a.account)) throw new Error('Unknown account: ' + a.account);
      if (seen.has(a.account)) throw new Error('Each account can be added once per goal.'); seen.add(a.account);
      const share = SHARES.includes(a.share) ? a.share : 'rest', value = share === 'rest' ? null : +a.value;
      if (share !== 'rest' && !(value > 0)) throw new Error('Enter how much of the account goes to this goal.');
      if (share === 'percent' && value > 100) throw new Error('A percentage can be at most 100.');
      return { account: a.account, share, value };
    });
  }
  if (g.source === 'accounts' && !g.accounts.length) throw new Error('Choose at least one account for this goal.');
  if (input.monthly !== undefined) { g.monthly = input.monthly === '' || input.monthly == null ? null : +input.monthly; if (g.monthly != null && !Number.isFinite(g.monthly)) throw new Error('Monthly saving must be a number.'); }
  if (input.growth !== undefined) { g.growth = input.growth === '' || input.growth == null ? 0 : +input.growth; if (!Number.isFinite(g.growth) || g.growth < -50 || g.growth > 50) throw new Error('Expected yearly return must be between -50% and 50%.'); }
  // Starting point: set (or reset) when chosen, using the balance this goal has right now.
  if (input.start !== undefined || input.resetStart) {
    g.start = (input.start ?? g.start) === 'new' ? 'new' : 'all';
    // Only when asked, when switching to it, or when what the goal tracks changes; editing the name or target keeps it.
    const prev = normalize(old), tracked = (x) => JSON.stringify([x.source, x.source === 'accounts' ? x.accounts : null]);
    if (g.start === 'new' && (input.resetStart || prev.start !== 'new' || tracked(prev) !== tracked(g))) { g.startDate = today(); g.baseline = balanceNow(g); }
    if (g.start === 'all') { g.baseline = 0; delete g.startDate; }
  }
  return g;
}
function create(input) {
  const cfg = loadConfig(), id = crypto.randomBytes(4).toString('hex');
  const g = clean({ source: 'liquid', by: null, monthly: null, growth: 0, ...input }, { id });
  if (!g.name || !g.target) throw new Error('A goal needs a name and a target amount.');
  g.created = today();
  cfg.goals = [...(cfg.goals || []), g]; saveConfig(cfg);
  return g;
}
function update(id, input) {
  const cfg = loadConfig(), i = (cfg.goals || []).findIndex((g) => g.id === id);
  if (i < 0) throw Object.assign(new Error('Unknown goal'), { status: 404 });
  cfg.goals[i] = clean(input, cfg.goals[i]); saveConfig(cfg);
  return cfg.goals[i];
}
function remove(id) { const cfg = loadConfig(); cfg.goals = (cfg.goals || []).filter((g) => g.id !== id); saveConfig(cfg); }
const sources = () => list().sources;

module.exports = { list, create, update, remove, compute, needed, split, sources, accountChoices };
