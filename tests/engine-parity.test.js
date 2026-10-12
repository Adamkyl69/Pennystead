// The native engine and the hledger CLI must give identical answers on the same data. Skipped when hledger is not installed.
const { dir } = require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
let hasHledger = true; try { execFileSync('hledger', ['--version'], { stdio: 'ignore' }); } catch { hasHledger = false; }

const core = require('../lib/core'), demo = require('../lib/demo'), store = require('../lib/store'), J = require('../lib/journal');
const { paths, loadConfig, saveConfig } = require('../lib/config');
const ago = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const asset = (o) => ({ kind: 'asset', currency: 'EUR', valuations: [], ...o });
const rd = (f) => JSON.parse(fs.readFileSync(f)), wr = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2));
const addAssets = (...a) => { const m = rd(paths.manualAssets); m.assets.push(...a); wr(paths.manualAssets, m); };
const cfg = (fn) => { const c = loadConfig(); fn(c); saveConfig(c); };
const P = (...l) => fs.appendFileSync(paths.prices, l.join('\n') + '\n');
const both = async (fn) => { process.env.PENNYSTEAD_ENGINE = 'hledger'; try { var h = await fn(); } finally { delete process.env.PENNYSTEAD_ENGINE; } return [h, await fn()]; };
function diff(path, a, b, out) {
  if (typeof a === 'number' && typeof b === 'number') { if (Math.abs(a - b) > 0.011) out.push(`${path}: hledger ${a} vs native ${b}`); }
  else if (Array.isArray(a) && Array.isArray(b)) { if (a.length !== b.length) out.push(`${path}: length ${a.length} vs ${b.length}`); for (let i = 0; i < Math.min(a.length, b.length); i++) diff(`${path}[${i}]`, a[i], b[i], out); }
  else if (a && b && typeof a === 'object') for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(`${path}.${k}`, a[k], b[k], out);
  else if (a !== b) out.push(`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
}
async function parity() {
  J.writeDerived(); const out = [], pick = (t) => t.map(({ id, date, desc, category, amount, cur, account, merchant }) => ({ id, date, desc, category, amount, cur, account, merchant }));
  const [ht, nt] = await both(() => core.transactions()); diff('txs', pick(ht), pick(nt), out);
  const [hw, nw] = await both(() => core.wealth()); diff('wealth', hw, nw, out);
  for (const r of ['1M', '3M', 'YTD', '1Y', 'All']) { const [hh, nh] = await both(() => core.wealthHistory(r)); diff('history.' + r, hh, nh, out); }
  return out;
}
const SCEN = {
  'demo data': () => {},
  'closed asset, liquid crypto, credit liability'() { addAssets(asset({ id: 'old-car', name: 'Old car', type: 'vehicle', cost: 5000, acquired: ago(900), valuations: [{ date: ago(900), value: 5000 }, { date: ago(300), value: 3000 }, { date: ago(40), value: 0 }], closed: ago(40) }), asset({ id: 'credit-card', name: 'Card', type: 'credit', kind: 'liability', valuations: [{ date: ago(100), value: 800 }, { date: ago(20), value: 300 }] }), asset({ id: 'eth', name: 'ETH', type: 'crypto', liquid: true, valuations: [{ date: ago(200), value: 1000 }, { date: ago(10), value: 1500 }] })); },
  'foreign currency asset with changing FX'() { addAssets(asset({ id: 'us-house', name: 'US house', type: 'property', currency: 'USD', valuations: [{ date: ago(400), value: 200000 }, { date: ago(30), value: 210000 }] })); P(`P ${ago(500)} USD 0.92 EUR`, `P ${ago(200)} USD 0.90 EUR`, `P ${ago(5)} USD 0.87 EUR`); },
  'price chain GBP>USD>EUR'() { addAssets(asset({ id: 'uk-flat', name: 'UK flat', type: 'property', currency: 'GBP', valuations: [{ date: ago(300), value: 300000 }, { date: ago(20), value: 310000 }] })); P(`P ${ago(400)} GBP 1.25 USD`, `P ${ago(50)} GBP 1.30 USD`, `P ${ago(400)} USD 0.92 EUR`, `P ${ago(10)} USD 0.87 EUR`); },
  'reversed price only (EUR>USD)'() { cfg((c) => { c.cash = [{ currency: 'USD', amount: 2000 }]; }); fs.writeFileSync(paths.prices, `P ${ago(300)} EUR 1.10 USD\nP ${ago(5)} EUR 1.16 USD\n`); },
  'unpriced holding and unpriced foreign cash'() { cfg((c) => { c.holdings.push({ symbol: 'NOPRICE', qty: 7, cost: 70, currency: 'USD' }); c.cash.push({ currency: 'CHF', amount: 500 }); }); },
  'future-dated holding'() { cfg((c) => c.holdings.push({ symbol: 'FUT', qty: 3, currency: 'USD', since: ago(-30) })); P(`P ${ago(1)} FUT 100 USD`); },
  'prices change over time, history before first price'() { cfg((c) => { c.holdings = [{ symbol: 'AAPL', qty: 12, cost: 2100, currency: 'USD', since: ago(400) }]; }); fs.writeFileSync(paths.prices, [`P ${ago(300)} AAPL 150 USD`, `P ${ago(150)} AAPL 180 USD`, `P ${ago(2)} AAPL 231 USD`, `P ${ago(250)} USD 0.95 EUR`, `P ${ago(100)} USD 0.90 EUR`, `P ${ago(2)} USD 0.86 EUR`].join('\n') + '\n'); },
  'dotted, quoted ticker'() { cfg((c) => { c.holdings = [{ symbol: 'BRK.B', qty: 4, cost: 1500, currency: 'USD', since: ago(300) }]; }); fs.writeFileSync(paths.prices, `P ${ago(100)} "BRK.B" 400 USD\nP ${ago(2)} "BRK.B" 450 USD\nP ${ago(2)} USD 0.86 EUR\n`); },
  'cost only / acquired before first value / no values'() { addAssets(asset({ id: 'bike', name: 'Bike', type: 'vehicle', cost: 900, acquired: ago(500) }), asset({ id: 'art', name: 'Art', type: 'collectible', cost: 2000, acquired: ago(600), valuations: [{ date: ago(100), value: 2600 }] }), asset({ id: 'empty', name: 'Nothing yet', type: 'other' })); },
  'imported account, anchored, with older rows'() {
    const imp = require('../lib/importer'); const run = (s, n, a, o = {}) => { const d = imp.upload(Buffer.from(s), n); return imp.commit(d.importId, d.mapping, a, o); };
    run('Date,Payee,Amount,Balance\n2025-12-01,Shop,-20.00,980.00\n2025-12-15,Pay,500.00,1480.00\n2026-01-10,Rent,-400.00,1080.00\n', 'p1.csv', { name: 'Side account', currency: 'EUR' });
    run('Date,Payee,Amount\n2025-10-01,Older,-60.00\n2025-11-20,Older2,200.00\n', 'p2.csv', { uid: Object.keys(store.accounts()).find((k) => k.startsWith('import-')) });
  },
  'overrides and changed rules'() { const ids = Object.keys(store.txs()).slice(0, 6); ids.forEach((id, i) => core.setOverride(id, i % 2 ? 'expenses:health' : 'income:salary')); core.assignMerchant('lidl helsinki', 'expenses:shopping'); },
};
for (const [name, setup] of Object.entries(SCEN)) test(`parity: ${name}`, { skip: !hasHledger && 'hledger not installed' }, async () => {
  demo.generate(); setup(); const d = await parity(); assert.deepEqual(d, [], `native and hledger differ:\n${d.slice(0, 10).join('\n')}`);
});
