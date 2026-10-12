// Pure analysis over normalized transactions: budgets, subscriptions, anomalies.
// Tx shape: { id, date, desc, merchant, account, category, amount (bank posting; negative = money out), cur }

const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] || 0; };
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => iso(new Date(Date.parse(s) + n * 864e5));
const r2 = (n) => Math.round(n * 100) / 100;
const byDate = (a, b) => a.date.localeCompare(b.date);

const isSpend = (t) => t.category.startsWith('expenses:') || t.category === 'expenses';
const isIncome = (t) => t.category.startsWith('income');
const spend = (t) => (isSpend(t) ? -t.amount : 0); // refunds are negative spend

function merchantKey(desc) {
  return desc.toLowerCase().replace(/\d+/g, ' ').replace(/[^a-zäöüåşğıç ]+/g, ' ').split(/\s+/).filter(Boolean).slice(0, 3).join(' ') || 'unknown';
}

/** Convert hledger `print -O json` output to normalized txs. Skips transfers/equity/multi-leg. */
/** raw: optional { id: storedTx } so descriptions use the original (non-ASCII) text rather than the ASCII-safe journal copy. */
function normalize(printJson, raw = {}) {
  const out = [];
  for (const t of printJson) {
    const ps = t.tpostings.map((p) => ({ account: p.paccount, amount: p.pamount[0]?.aquantity.floatingPoint ?? 0, cur: p.pamount[0]?.acommodity }));
    const bank = ps.filter((p) => p.account.startsWith('assets:bank'));
    const cat = ps.filter((p) => /^(expenses|income)(:|$)/.test(p.account));
    if (bank.length !== 1 || cat.length !== 1) continue;
    const id = (t.ttags.find((x) => x[0] === 'eb') || [])[1], desc = raw[id]?.desc || t.tdescription;
    out.push({
      id, date: t.tdate, desc, merchant: merchantKey(desc),
      account: bank[0].account, category: cat[0].account, amount: bank[0].amount, cur: bank[0].cur,
    });
  }
  return out.sort(byDate);
}

function monthly(txs, n = 12) {
  const m = {};
  for (const t of txs) {
    const k = t.date.slice(0, 7);
    const e = (m[k] ??= { month: k, income: 0, spend: 0 });
    if (isIncome(t)) e.income += t.amount; else e.spend += spend(t);
  }
  return Object.values(m).sort((a, b) => a.month.localeCompare(b.month)).slice(-n).map((e) => ({ ...e, income: r2(e.income), spend: r2(e.spend), saved: r2(e.income - e.spend) }));
}

function spendByCategory(txs, from, to = '9999-12-31', depth = 2) {
  const m = {};
  for (const t of txs) if (t.date >= from && t.date <= to && isSpend(t)) {
    const k = t.category.split(':').slice(0, depth).join(':');
    m[k] = (m[k] || 0) + spend(t);
  }
  return Object.entries(m).map(([category, amount]) => ({ category, amount: r2(amount) })).sort((a, b) => b.amount - a.amount);
}

/** Budgets are stored as a number (monthly) or { amount, period: 'month' | 'year' }. Normalize to { amount, period }. */
function normBudgets(b = {}) {
  return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, typeof v === 'number' ? { amount: v, period: 'month' } : { amount: +v.amount, period: v.period === 'year' ? 'year' : 'month' }]));
}
const dayOfYear = (d) => Math.round((Date.parse(d) - Date.parse(d.slice(0, 4) + '-01-01')) / 864e5) + 1;
const daysInYear = (y) => ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365);
const statusOf = (spent, amount, projected, early) => (spent > amount ? 'over' : projected > amount * 1.05 && !early ? 'on_track_to_exceed' : spent >= amount * 0.8 ? 'warn' : 'ok');

/** Year-to-date progress of one budget (calendar year of `asOf`), with a linear year-end projection and the pro-rata pace. */
function yearStatus(txs, category, amount, asOf, account = null) {
  const y = asOf.slice(0, 4);
  const spent = txs.filter((t) => isSpend(t) && under(t.category, category) && t.date >= y + '-01-01' && t.date <= asOf && (!account || t.account === account)).reduce((s, t) => s + spend(t), 0);
  const elapsed = dayOfYear(asOf) / daysInYear(+y), projected = elapsed > 0 ? spent / elapsed : spent;
  return { category, period: 'year', budget: amount, spent: r2(spent), remaining: r2(amount - spent), pct: amount ? Math.round((spent / amount) * 100) : 0, pace: r2(amount * elapsed), projected: r2(projected), status: statusOf(spent, amount, projected, elapsed < 0.15) };
}

function budgets(txs, budgetMap, today, month = today.slice(0, 7)) {
  const defs = normBudgets(budgetMap);
  const [y, mo] = month.split('-').map(Number);
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const current = month === today.slice(0, 7);
  const elapsed = current ? Math.max(1, +today.slice(8, 10)) / dim : 1;
  const asOf = current ? today : `${month}-${String(dim).padStart(2, '0')}`;
  return Object.entries(defs).map(([category, d]) => {
    if (d.period === 'year') return yearStatus(txs, category, d.amount, asOf);
    const spent = txs.filter((t) => t.date.startsWith(month) && isSpend(t) && under(t.category, category)).reduce((s, t) => s + spend(t), 0);
    const projected = elapsed < 1 ? spent / elapsed : spent;
    return { category, period: 'month', budget: d.amount, spent: r2(spent), remaining: r2(d.amount - spent), pct: Math.round((spent / d.amount) * 100), projected: r2(projected), status: statusOf(spent, d.amount, projected, false) };
  }).sort((a, b) => b.pct - a.pct);
}

const BILL = /rent|mortgage|utilit|insurance|loan|tax/;
const PERIODS = [['weekly', 7, 5, 9], ['monthly', 30.44, 26, 35], ['quarterly', 91, 84, 98], ['yearly', 365, 350, 380]];

function subscriptions(txs, today) {
  const groups = {};
  for (const t of txs) if (isSpend(t) && t.amount < 0) (groups[t.merchant] ??= []).push(t);
  const found = [];
  for (const list of Object.values(groups)) {
    if (list.length < 3) continue;
    list.sort(byDate);
    const gaps = list.slice(1).map((t, i) => days(list[i].date, t.date)).filter((g) => g > 2);
    if (gaps.length < 2) continue;
    const med = median(gaps);
    const per = PERIODS.find(([, , lo, hi]) => med >= lo && med <= hi);
    if (!per) continue;
    if (gaps.filter((g) => Math.abs(g - med) <= Math.max(5, med * 0.25)).length / gaps.length < 0.7) continue;
    const amts = list.map((t) => -t.amount), typical = median(amts);
    if (amts.filter((a) => Math.abs(a - typical) <= typical * 0.3).length / amts.length < 0.6) continue;

    const last = list[list.length - 1], lastAmt = -last.amount;
    const prior = median(amts.slice(0, -1));
    const [period, pdays] = per;
    const sinceLast = days(last.date, today);
    const lapsed = sinceLast > pdays * 1.6 + 5;
    const flags = [];
    if (lastAmt > prior * 1.03 && amts.length > 3) flags.push('price_increase');
    if (days(list[0].date, today) <= 60) flags.push('new');
    for (let i = 1; i < list.length; i++) if (days(list[i - 1].date, list[i].date) <= 3 && Math.abs(list[i].amount - list[i - 1].amount) < 0.01 && pdays >= 28) flags.push('duplicate_charge');
    found.push({
      merchant: last.desc, key: last.merchant, category: last.category, period, count: list.length,
      amount: r2(lastAmt), previousAmount: r2(prior), perMonth: r2((lastAmt * 30.44) / pdays), perYear: r2((lastAmt * 365.25) / pdays),
      lastCharged: last.date, nextExpected: lapsed ? null : addDays(last.date, Math.round(pdays)), lapsed, flags: [...new Set(flags)],
      kind: BILL.test(last.category) ? 'bill' : 'subscription',
    });
  }
  const live = found.filter((s) => s.kind === 'subscription' && !s.lapsed);
  const byCat = {};
  for (const s of live) (byCat[s.category.split(':').slice(0, 3).join(':')] ??= []).push(s);
  for (const grp of Object.values(byCat)) if (grp.length >= 3) for (const s of grp) s.flags.push('overlap');
  for (const s of live) if (s.perYear >= 300 && !s.flags.includes('expensive')) s.flags.push('expensive');
  const sorted = (k) => found.filter((s) => (k === 'lapsed' ? s.lapsed : !s.lapsed && s.kind === k)).sort((a, b) => b.perYear - a.perYear);
  return {
    active: sorted('subscription'), bills: sorted('bill'), lapsed: sorted('lapsed'),
    monthlyTotal: r2(live.reduce((s, x) => s + x.perMonth, 0)), yearlyTotal: r2(live.reduce((s, x) => s + x.perYear, 0)),
  };
}

function anomalies(txs, subs, today, minAbs = 30) {
  const out = [], recentFrom = addDays(today, -45);
  const outflows = txs.filter((t) => isSpend(t) && t.amount < 0);
  const recent = outflows.filter((t) => t.date >= recentFrom);
  const history = outflows.filter((t) => t.date < recentFrom);
  const enough = txs.length && days(txs[0].date, today) > 90;
  const push = (type, severity, t, detail) => out.push({ type, severity, date: t.date, desc: t.desc, amount: r2(-t.amount), category: t.category, detail });

  if (enough) {
    // 1. Unusually large for its category
    const catHist = {};
    for (const t of history) (catHist[t.category.split(':').slice(0, 3).join(':')] ??= []).push(-t.amount);
    for (const t of recent) {
      const h = catHist[t.category.split(':').slice(0, 3).join(':')];
      if (!h || h.length < 8) continue;
      const m = mean(h), s = sd(h), a = -t.amount;
      if (a > m + 3 * s && a > 2 * median(h) && a >= minAbs) push('unusual_amount', a > m + 5 * s ? 'high' : 'medium', t, `${(a / median(h)).toFixed(1)}x the usual ${t.category.split(':').slice(1, 3).join(' › ')} purchase (median ${r2(median(h))})`);
    }
    // 2. First-time merchant with a big charge
    const seen = new Set(history.map((t) => t.merchant)), big = Math.max(100, pct(history.map((t) => -t.amount), 0.95));
    for (const t of recent) if (!seen.has(t.merchant) && -t.amount >= big && !subs.active.some((s) => s.key === t.merchant)) push('new_merchant', 'medium', t, `First time paying this merchant, and it's above your 95th percentile spend (${r2(big)})`);
  }
  // 3. Duplicate charges
  const rs = [...recent].sort(byDate);
  for (let i = 1; i < rs.length; i++) for (let j = i - 1; j >= 0 && days(rs[j].date, rs[i].date) <= 3; j--)
    if (rs[j].merchant === rs[i].merchant && Math.abs(rs[j].amount - rs[i].amount) < 0.01 && -rs[i].amount >= 5) { push('duplicate_charge', 'medium', rs[i], days(rs[j].date, rs[i].date) ? `Same amount charged twice within ${days(rs[j].date, rs[i].date)} day(s)` : 'Same amount charged twice on the same day'); break; }
  // 4. Month-to-date category spike vs prior 3 full months
  const month = today.slice(0, 7), prevs = [1, 2, 3].map((n) => { const d = new Date(Date.parse(month + '-01')); d.setUTCMonth(d.getUTCMonth() - n); return iso(d).slice(0, 7); });
  if (enough) {
    const tot = (mo) => { const m = {}; for (const t of outflows) if (t.date.startsWith(mo)) { const k = t.category.split(':').slice(0, 3).join(':'); m[k] = (m[k] || 0) - t.amount; } return m; };
    const now = tot(month), past = prevs.map(tot);
    for (const [k, v] of Object.entries(now)) {
      const avg = mean(past.map((p) => p[k] || 0));
      if (avg >= 30 && v > avg * 1.5 && v - avg > 50) out.push({ type: 'category_spike', severity: v > avg * 2 ? 'high' : 'medium', date: today, desc: k, amount: r2(v), category: k, detail: `${r2(v)} so far this month vs ${r2(avg)} average for the last 3 months` });
    }
  }
  // 5. Subscription price increases
  for (const s of subs.active) if (s.flags.includes('price_increase')) out.push({ type: 'price_increase', severity: 'low', date: s.lastCharged, desc: s.merchant, amount: s.amount, category: s.category, detail: `Went from ${s.previousAmount} to ${s.amount} per ${s.period.replace(/ly$/, '')}` });

  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || b.date.localeCompare(a.date));
}

function suggestBudgets(txs, today) {
  const month = today.slice(0, 7);
  const months = [1, 2, 3].map((n) => { const d = new Date(Date.parse(month + '-01')); d.setUTCMonth(d.getUTCMonth() - n); return iso(d).slice(0, 7); });
  const totals = {};
  for (const mo of months) for (const c of spendByCategory(txs, mo + '-01', mo + '-31', 3)) totals[c.category] = (totals[c.category] || 0) + c.amount / 3;
  const out = {};
  for (const [k, v] of Object.entries(totals)) if (v >= 20 && !/rent|uncategorized|housing$/.test(k)) out[k] = Math.ceil((v * 1.05) / 10) * 10;
  return out;
}

// ---------- period reports (Spending page) ----------
const PERIODS_ = ['week', 'month', 'quarter', 'year'];
function periodKey(date, period) {
  if (period === 'month') return date.slice(0, 7);
  if (period === 'year') return date.slice(0, 4);
  const d = new Date(date + 'T00:00:00Z');
  if (period === 'quarter') return date.slice(0, 4) + '-Q' + (Math.floor(d.getUTCMonth() / 3) + 1);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return iso(d);
}
function keyStart(key, period) {
  if (period === 'month') return key + '-01';
  if (period === 'year') return key + '-01-01';
  if (period === 'quarter') return `${key.slice(0, 4)}-${String((+key.slice(6) - 1) * 3 + 1).padStart(2, '0')}-01`;
  return key;
}
function shiftKey(key, period, n) {
  const d = new Date(keyStart(key, period) + 'T00:00:00Z');
  if (period === 'week') d.setUTCDate(d.getUTCDate() + 7 * n);
  else if (period === 'month') d.setUTCMonth(d.getUTCMonth() + n);
  else if (period === 'quarter') d.setUTCMonth(d.getUTCMonth() + 3 * n);
  else d.setUTCFullYear(d.getUTCFullYear() + n);
  return periodKey(iso(d), period);
}
const BUDGET_SCALE = { week: 12 / 52, month: 1, quarter: 3, year: 12 };
const under = (cat, parent) => cat === parent || cat.startsWith(parent + ':');

/**
 * Spending broken down per period and group.
 * opts: { period, count, group: category|vendor|account, account, parent, today, budgets }
 */
function spendingReport(txs, { period = 'month', count = 12, group = 'category', account = null, parent = 'expenses', today, budgets = {} }) {
  const defs = normBudgets(budgets);
  if (!PERIODS_.includes(period)) period = 'month';
  const cur = periodKey(today, period);
  const keys = Array.from({ length: count }, (_, i) => shiftKey(cur, period, i - (count - 1)));
  const inRange = new Set(keys);
  const scoped = txs.filter((t) => isSpend(t) && under(t.category, parent) && (!account || t.account === account));
  const depth = parent.split(':').length;
  const gk = (t) => (group === 'vendor' ? t.merchant : group === 'account' ? t.account : t.category.split(':').slice(0, depth + 1).join(':'));
  const names = {}, hasChildren = {};
  for (const t of scoped) {
    const k = gk(t);
    names[k] = group === 'vendor' ? t.desc : k;
    if (group === 'category' && t.category.split(':').length > depth + 1) hasChildren[k] = true;
  }

  const sums = {}, counts = {};          // sums[bucket][group]
  const keyAll = [...new Set([...keys, ...Array.from({ length: 4 }, (_, i) => shiftKey(keys[0], period, -(i + 1)))])];
  for (const k of keyAll) { sums[k] = {}; counts[k] = {}; }
  for (const t of scoped) {
    const b = periodKey(t.date, period);
    if (!sums[b]) continue;
    const g = gk(t);
    sums[b][g] = (sums[b][g] || 0) + spend(t);
    counts[b][g] = (counts[b][g] || 0) + 1;
  }
  const total = (b) => Object.values(sums[b] || {}).reduce((x, y) => x + y, 0);
  const groupTotals = {};
  for (const k of keys) for (const [g, v] of Object.entries(sums[k])) groupTotals[g] = (groupTotals[g] || 0) + v;
  const order = Object.keys(groupTotals).sort((a, b) => groupTotals[b] - groupTotals[a]);

  // A budget is either per-period (monthly budgets scaled to the view) or yearly (tracked against year-to-date spend).
  const monthlyEq = (d) => (d.period === 'year' ? d.amount / 12 : d.amount);
  const budgetFor = (g) => {
    if (group !== 'category') return null;
    if (defs[g]) return defs[g].period === 'year' ? { kind: 'year', amount: defs[g].amount } : { kind: 'period', amount: defs[g].amount * BUDGET_SCALE[period] };
    const kids = Object.entries(defs).filter(([c]) => c.startsWith(g + ':'));
    if (!kids.length) return null;
    if (kids.every(([, d]) => d.period === 'year')) return { kind: 'year', amount: kids.reduce((s, [, d]) => s + d.amount, 0) };
    return { kind: 'period', amount: kids.reduce((s, [, d]) => s + monthlyEq(d), 0) * BUDGET_SCALE[period] };
  };
  const bucketEnd = (k) => { const e = addDays(keyStart(shiftKey(k, period, 1), period), -1); return e > today ? today : e; };
  const ytd = (k, g) => { const end = bucketEnd(k), y = end.slice(0, 4); return scoped.filter((t) => gk(t) === g && t.date >= y + '-01-01' && t.date <= end).reduce((s, t) => s + spend(t), 0); };
  const tables = {};
  for (const k of keys) {
    const prev = shiftKey(k, period, -1), prior = [1, 2, 3].map((n) => shiftKey(k, period, -n));
    const rows = order.filter((g) => sums[k][g] || sums[prev]?.[g]).map((g) => {
      const amount = sums[k][g] || 0, p = sums[prev]?.[g] || 0, avg = mean(prior.map((b) => sums[b]?.[g] || 0)), bd = budgetFor(g);
      const bspent = bd?.kind === 'year' ? ytd(k, g) : amount;
      return {
        key: g, name: names[g], amount: r2(amount), avg: r2(avg), count: counts[k][g] || 0, drill: !!hasChildren[g],
        vsPrev: p ? Math.round(((amount - p) / p) * 100) : null, vsAvg: avg ? Math.round(((amount - avg) / avg) * 100) : null,
        budget: bd ? { amount: r2(bd.amount), kind: bd.kind, spent: r2(bspent), pct: bd.amount ? Math.round((bspent / bd.amount) * 100) : (bspent > 0 ? 999 : 0) } : null,
      };
    }).filter((r) => r.amount > 0 || r.avg > 0).sort((a, b) => b.amount - a.amount);
    const avgTotal = mean(prior.map(total)), budRows = rows.filter((r) => r.budget?.kind === 'period');
    const bTotal = budRows.reduce((s, r) => s + r.budget.amount, 0), bUsed = budRows.reduce((s, r) => s + r.amount, 0);
    tables[k] = {
      rows, total: r2(total(k)), previous: r2(total(prev)), avg3: r2(avgTotal), vsAvg: avgTotal ? Math.round(((total(k) - avgTotal) / avgTotal) * 100) : null,
      budget: bTotal ? { total: r2(bTotal), used: r2(bUsed), pct: Math.round((bUsed / bTotal) * 100), over: r2(bUsed - bTotal), overCount: budRows.filter((r) => r.budget.pct > 100).length, unbudgeted: r2(rows.filter((r) => !r.budget).reduce((s, r) => s + r.amount, 0)) } : null,
    };
  }

  const vend = {};
  for (const t of scoped) {
    const b = periodKey(t.date, period);
    if (!inRange.has(b)) continue;
    const v = (vend[t.merchant] ??= { name: t.desc, total: 0, count: 0, series: Object.fromEntries(keys.map((k) => [k, 0])) });
    v.total += spend(t); v.count++; v.series[b] += spend(t); v.name = t.desc;
  }
  const vendors = Object.values(vend).sort((a, b) => b.total - a.total).slice(0, 8).map((v) => ({ name: v.name, total: r2(v.total), count: v.count, avg: r2(v.total / v.count), series: keys.map((k) => r2(v.series[k])) }));

  return {
    yearly: Object.entries(defs).filter(([c, d]) => d.period === 'year' && (c === parent || c.startsWith(parent + ':') || parent.startsWith(c + ':'))).map(([c, d]) => yearStatus(txs, c, d.amount, today, account)).sort((a, b) => b.pct - a.pct),
    period, group, parent, account, current: cur, keys, groups: order.map((g) => ({ key: g, name: names[g], drill: !!hasChildren[g] })),
    buckets: keys.map((k) => ({ key: k, total: r2(total(k)), groups: Object.fromEntries(Object.entries(sums[k]).map(([g, v]) => [g, r2(v)])) })), tables, vendors,
  };
}

/** Merchants whose category is still "uncategorized", grouped for the Review queue. */
function reviewQueue(txs) {
  const m = {};
  for (const t of txs) if (t.category.endsWith(':uncategorized')) {
    const e = (m[t.merchant] ??= { merchant: t.merchant, name: t.desc, dir: t.amount < 0 ? 'out' : 'in', count: 0, total: 0, last: t.date, sample: [] });
    e.count++; e.total += Math.abs(t.amount); if (t.date >= e.last) { e.last = t.date; e.name = t.desc; }
    if (e.sample.length < 3) e.sample.push({ id: t.id, date: t.date, amount: t.amount });
  }
  return Object.values(m).map((e) => ({ ...e, total: r2(e.total) })).sort((a, b) => b.total - a.total);
}

module.exports = { normBudgets, yearStatus, spendingReport, reviewQueue, periodKey, normalize, monthly, spendByCategory, budgets, subscriptions, anomalies, suggestBudgets, merchantKey, isSpend, isIncome, spend };
