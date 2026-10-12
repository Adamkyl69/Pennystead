const { } = require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const demo = require('../lib/demo'), core = require('../lib/core'), A = require('../lib/analysis'), { loadConfig } = require('../lib/config');
let txs, subs, today;
test.before(async () => { demo.generate(); txs = await core.transactions(); today = core.today(); subs = A.subscriptions(txs, today); });

test('subscriptions: finds the recurring services and none of the groceries', () => {
  const names = subs.active.map((s) => s.merchant); for (const n of ['NETFLIX.COM', 'SPOTIFY', 'DISNEY PLUS', 'APPLE ICLOUD', 'CITY GYM CLUBHOUSE']) assert.ok(names.includes(n), n);
  assert.ok(!names.some((n) => /LIDL|S-MARKET|ZALANDO/.test(n))); assert.ok(subs.bills.some((b) => /Housing/.test(b.merchant)), 'rent is a bill, not a subscription');
  const nf = subs.active.find((s) => s.merchant === 'NETFLIX.COM'); assert.equal(nf.period, 'monthly'); assert.ok(nf.flags.includes('price_increase')); assert.equal(nf.previousAmount, 12.99); assert.equal(nf.amount, 15.49);
  assert.ok(subs.active.filter((s) => s.category.startsWith('expenses:subscriptions:media')).every((s) => s.flags.includes('overlap')), 'three streaming services overlap');
});
test('anomalies: the planted oddities are flagged', () => {
  const an = A.anomalies(txs, subs, today, loadConfig().anomalyMin), has = (type, re) => an.some((x) => x.type === type && re.test(x.desc));
  assert.ok(has('unusual_amount', /MEDIAMARKT/)); assert.ok(has('new_merchant', /NORDIC DIGITAL/)); assert.ok(has('duplicate_charge', /UBER/)); assert.ok(has('price_increase', /NETFLIX/));
  assert.ok(!an.some((x) => /LIDL|S-MARKET/.test(x.desc)), 'ordinary groceries are not anomalies');
});
test('budgets: monthly status and yearly budgets tracked against year-to-date', () => {
  const b = A.budgets(txs, { 'expenses:transport': 50, 'expenses:shopping': { amount: 1000, period: 'year' } }, today);
  const t = b.find((x) => x.category === 'expenses:transport'), y = b.find((x) => x.category === 'expenses:shopping');
  assert.equal(t.period, 'month'); assert.ok(t.spent > 0); assert.equal(y.period, 'year'); assert.ok(y.spent > 0 && y.pace > 0 && y.projected >= y.spent);
  assert.ok(['over', 'on_track_to_exceed', 'warn', 'ok'].includes(y.status));
});
test('spending report: buckets, drill-down and totals add up', () => {
  const r = A.spendingReport(txs, { period: 'month', count: 12, group: 'category', parent: 'expenses', today, budgets: loadConfig().budgets });
  assert.equal(r.keys.length, 12); const cur = r.tables[r.current]; assert.equal(Math.round(cur.rows.reduce((s, x) => s + x.amount, 0) * 100) / 100, cur.total);
  assert.ok(r.groups.find((g) => g.key === 'expenses:food').drill); const food = A.spendingReport(txs, { period: 'month', count: 3, group: 'category', parent: 'expenses:food', today, budgets: {} });
  assert.ok(food.groups.every((g) => g.key.startsWith('expenses:food:')));
  for (const p of ['week', 'quarter', 'year']) assert.ok(A.spendingReport(txs, { period: p, count: 4, group: 'vendor', today, budgets: {} }).vendors.length > 0, p);
  const all = A.spendingReport(txs, { period: 'month', count: 12, group: 'category', today, budgets: {} }), sum = all.buckets.reduce((s, b) => s + b.total, 0);
  const direct = txs.filter((t) => t.category.startsWith('expenses') && all.keys.includes(t.date.slice(0, 7))).reduce((s, t) => s + (-t.amount), 0); assert.ok(Math.abs(sum - direct) < 0.05, `${sum} vs ${direct}`);
});
test('review queue lists only uncategorized merchants', () => { const q = A.reviewQueue(txs); assert.ok(q.length >= 1 && q.every((m) => m.total > 0)); assert.ok(q.some((m) => /NORDIC/.test(m.name))); });
