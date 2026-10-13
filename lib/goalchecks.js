// Monthly goal checks: once a month (the first time Pennystead runs in a new month), every savings goal is checked
// and the result is kept, so you get a clear "on track / behind" verdict each month and a track record over time.
const fs = require('fs');
const { paths, writeAtomic, loadConfig } = require('./config');
const { today } = require('./dates');
const goals = require('./goals');

const r2 = (n) => Math.round(n * 100) / 100 + 0;
const read = () => { try { return JSON.parse(fs.readFileSync(paths.goalChecks, 'utf8')); } catch { return []; } };
const write = (checks) => writeAtomic(paths.goalChecks, JSON.stringify(checks, null, 2));
const enabled = () => loadConfig().goalChecks !== 'off';

/**
 * Check every goal now and record it as this month's check. Without `force`, does nothing when this month is
 * already checked (or there are no goals, or checks are off). Returns the check, or null.
 */
function run({ force = false } = {}) {
  const month = today().slice(0, 7), checks = read();
  if (!force && (!enabled() || checks.some((c) => c.month === month))) return null;
  const list = goals.list().goals;
  if (!list.length) return null;
  const prev = [...checks].reverse().find((c) => c.month < month);
  const results = list.map((g) => {
    const before = prev?.goals.find((x) => x.id === g.id);
    return {
      id: g.id, name: g.name, status: g.status, current: g.current, target: g.target, pct: g.pct, pace: g.pace, monthlyUsed: g.monthlyUsed,
      neededMonthly: g.neededMonthly, reachDate: g.reachDate, deadlineMonth: g.deadlineMonth,
      // Since the last check: money added (or lost) and whether the verdict changed.
      change: before ? r2(g.current - before.current) : null, statusBefore: before?.status ?? null,
    };
  });
  const check = { month, at: new Date().toISOString(), seen: false, goals: results };
  write([...checks.filter((c) => c.month !== month), check].sort((a, b) => a.month.localeCompare(b.month)).slice(-60));
  return check;
}

const all = () => read();
/** The latest check, if you have not dismissed it yet: what the Overview banner shows. */
const unseen = () => { const last = read().at(-1); return last && !last.seen ? last : null; };
function markSeen(month) {
  const checks = read(), c = checks.find((x) => x.month === month);
  if (!c) throw Object.assign(new Error('No check for that month'), { status: 404 });
  c.seen = true; write(checks);
}
/** Month-by-month results for one goal, oldest first. */
const history = (id) => read().flatMap((c) => c.goals.filter((g) => g.id === id).map((g) => ({ month: c.month, ...g })));

module.exports = { run, all, unseen, markSeen, history };
