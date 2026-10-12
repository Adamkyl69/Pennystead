// Savings goals: a target amount, optionally by a date, tracked against one balance (liquid net worth, net worth,
// or a single account or asset). Progress comes from the real balance history; the projection continues your
// actual saving pace of the last 6 months (or a monthly amount you set), optionally with an expected yearly return.
const crypto = require('crypto');
const ledger = require('./ledger');
const manual = require('./manual');
const store = require('./store');
const { loadConfig, saveConfig } = require('./config');
const { today } = require('./dates');

const r2 = (n) => Math.round(n * 100) / 100 + 0;
const LIQUID = ['assets:bank', 'assets:cash', 'assets:investments', 'assets:manual:liquid', 'liabilities:unsecured'];
const MAX_MONTHS = 600; // 50 years: beyond that a goal is "not reachable at this pace"

/** What a goal can track: { id, label, prefixes }. */
function sources(L = ledger.build()) {
  const out = [{ id: 'liquid', label: 'Liquid net worth (cash, investments, liquid assets, minus card debt)', prefixes: LIQUID }, { id: 'net', label: 'Net worth (everything)', prefixes: ['assets', 'liabilities'] }];
  const names = Object.fromEntries(Object.values(store.accounts()).map((a) => ['assets:bank:' + a.name, a.label || a.name]));
  const man = Object.fromEntries(manual.summarize([]).map((a) => [a.account, a.name]));
  const accts = [...new Set(L.postings.map((p) => p.account))].filter((a) => a.startsWith('assets:')).sort();
  if (accts.some((a) => a.startsWith('assets:investments'))) out.push({ id: 'acct:assets:investments', label: 'All investments', prefixes: ['assets:investments'] });
  for (const a of accts) if (a.startsWith('assets:bank') || a.startsWith('assets:manual') || a.startsWith('assets:cash')) out.push({ id: 'acct:' + a, label: names[a] || man[a] || a.split(':').pop(), prefixes: [a] });
  return out;
}

const monthStart = (d) => d.slice(0, 7) + '-01';
const addMonths = (d, n) => { const [y, m] = d.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1 + n, 1)); return t.toISOString().slice(0, 10); };
const monthsBetween = (a, b) => (+b.slice(0, 4) - +a.slice(0, 4)) * 12 + (+b.slice(5, 7) - +a.slice(5, 7));

/** Monthly amount needed to go from `v` to `target` in `n` months at monthly growth `g` (end-of-month saving). */
function needed(v, target, n, g) {
  if (n <= 0) return null;
  if (!g) return (target - v) / n;
  const f = (1 + g) ** n;
  return ((target - v * f) * g) / (f - 1);
}

/** Everything the Goals page and the chart need for one goal. */
function compute(goal, L, base) {
  const t = today(), src = sources(L).find((s) => s.id === goal.source) || sources(L)[0];
  const from = addMonths(monthStart(t), -12), to = ledger.addDays(t, 1);
  const hist = ledger.series(L, [{ prefixes: src.prefixes }], 'month', from, to, base)[0].map((p) => ({ month: p.date.slice(0, 7), value: r2(p.value) }));
  const current = hist.length ? hist[hist.length - 1].value : 0;
  // Your real pace: the average monthly change over (up to) the last 6 months of history.
  const look = Math.min(6, hist.length - 1), pace = look > 0 ? (current - hist[hist.length - 1 - look].value) / look : null;
  const monthly = goal.monthly != null ? +goal.monthly : pace, g = (+goal.growth || 0) / 1200;
  const target = +goal.target, reached = current >= target;

  // Projection, month by month, until the target is reached (or 50 years pass).
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

  // Chart: 12 months of history, then the future through the deadline and the projected date (6 months to 25 years).
  const horizon = Math.min(300, Math.max(6, byIn ? byIn + 1 : 0, reachIn != null ? reachIn + 2 : 24));
  const points = hist.map((h, i) => ({ month: h.month, actual: h.value, projected: i === hist.length - 1 ? h.value : null, needed: i === hist.length - 1 && need != null ? h.value : null }));
  let nv = current;
  for (let k = 1; k <= horizon; k++) {
    if (need != null && k <= byIn) nv = nv * (1 + g) + need;
    points.push({ month: addMonths(monthStart(t), k).slice(0, 7), actual: null, projected: proj[k - 1] != null ? r2(proj[k - 1]) : null, needed: need != null && k <= byIn ? r2(nv) : null });
  }
  return {
    ...goal, source: src.id, sourceLabel: src.label, current: r2(current), target, remaining: r2(Math.max(0, target - current)),
    pct: target ? Math.min(100, Math.round((current / target) * 100)) : 100, pace: pace == null ? null : r2(pace), monthlyUsed: monthly == null ? null : r2(monthly),
    reachDate: reachIn == null ? null : addMonths(monthStart(t), reachIn).slice(0, 7), neededMonthly: need == null ? null : r2(Math.max(0, need)),
    status, points, deadlineMonth: goal.by ? goal.by.slice(0, 7) : null,
  };
}

function list() {
  const L = ledger.build(), base = loadConfig().base;
  return { base, goals: (loadConfig().goals || []).map((g) => compute(g, L, base)), sources: sources(L).map(({ id, label }) => ({ id, label })) };
}

function clean(input, old = {}) {
  const g = { ...old };
  if (input.name !== undefined) { g.name = String(input.name).trim().slice(0, 60); if (!g.name) throw new Error('Give the goal a name.'); }
  if (input.target !== undefined) { g.target = +input.target; if (!(g.target > 0)) throw new Error('The target must be an amount above 0.'); }
  if (input.by !== undefined) { g.by = input.by || null; if (g.by && (!/^\d{4}-\d{2}-\d{2}$/.test(g.by) || g.by <= today())) throw new Error('The target date must be in the future.'); }
  if (input.source !== undefined) { if (!sources().some((s) => s.id === input.source)) throw new Error('Unknown balance to track.'); g.source = input.source; }
  if (input.monthly !== undefined) { g.monthly = input.monthly === '' || input.monthly == null ? null : +input.monthly; if (g.monthly != null && !Number.isFinite(g.monthly)) throw new Error('Monthly saving must be a number.'); }
  if (input.growth !== undefined) { g.growth = input.growth === '' || input.growth == null ? 0 : +input.growth; if (!Number.isFinite(g.growth) || g.growth < -50 || g.growth > 50) throw new Error('Expected yearly return must be between -50% and 50%.'); }
  return g;
}
function create(input) {
  const cfg = loadConfig(), g = clean({ source: 'liquid', by: null, monthly: null, growth: 0, ...input });
  if (!g.name || !g.target) throw new Error('A goal needs a name and a target amount.');
  g.id = crypto.randomBytes(4).toString('hex'); g.created = today();
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

module.exports = { list, create, update, remove, compute, needed, sources };
