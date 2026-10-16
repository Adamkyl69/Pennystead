require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
test.before(() => require('../lib/demo').generate());

test('review: hide and restore items (data untouched), date range, hidden items leave the count', async () => {
  const core = require('../lib/core');
  const all = await core.review(), st0 = (await core.state()).reviewCount;
  const m = all.merchants[0], a = all.anomalies.find((x) => x.severity !== 'low');
  assert.ok(m && a, 'sample data has something to review');
  const txBefore = Object.keys(require('../lib/store').txs()).length;
  core.setHidden('merchant', m.merchant); core.setHidden('anomaly', a.id);
  let r = await core.review();
  assert.equal(r.merchants.find((x) => x.merchant === m.merchant).hidden, true);
  assert.equal(r.anomalies.find((x) => x.id === a.id).hidden, true);
  assert.equal((await core.state()).reviewCount, st0 - 2);
  assert.equal(Object.keys(require('../lib/store').txs()).length, txBefore, 'hiding deletes nothing');
  core.setHidden('merchant', m.merchant, false); core.setHidden('anomaly', a.id, false);
  assert.equal((await core.state()).reviewCount, st0);
  assert.throws(() => core.setHidden('transaction', 'x'), /Unknown item/);
  // A period: only what happened in it, with totals for that period.
  r = await core.review({ from: m.last, to: m.last });
  assert.ok(r.merchants.every((x) => x.last === m.last));
  assert.ok(r.anomalies.every((x) => x.date === m.last));
  assert.deepEqual((await core.review({ from: 'garbage' })).merchants.length, all.merchants.length, 'a bad date is ignored');
});
