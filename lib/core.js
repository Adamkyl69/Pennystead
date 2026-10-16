// Shared data access used by the web server, CLI and MCP server.
const fs = require('fs');
const hl = require('./hl');
const ledger = require('./ledger');
const A = require('./analysis');
const suggest = require('./suggest');
const manual = require('./manual');
const store = require('./store');
const { paths, loadConfig, saveConfig } = require('./config');
const { writeDerived, rebuildBank } = require('./journal');

const { today, shiftDays } = require('./dates');
const r2 = (n) => Math.round(n * 100) / 100;

// The dashboard computes everything itself (lib/ledger.js). PENNYSTEAD_ENGINE=hledger switches to the hledger CLI,
// which the parity tests use to prove both give the same numbers.
const useHledger = () => process.env.PENNYSTEAD_ENGINE === 'hledger';

async function transactions() {
  writeDerived();
  const L = ledger.build();
  return inBase(useHledger() ? A.normalize(await hl.json(['print']), store.txs()) : L.txs, L);
}

/**
 * Totals (spending, budgets, subscriptions, anomalies) must be in one currency. Each transaction keeps its own
 * amount and currency for display, plus `value`: the amount in the base currency at the price on its date
 * (or the earliest later price when none is that old). Without any price path, `value` stays the raw amount.
 */
function inBase(txs, L) {
  const convert = ledger.priceBook(L.prices), t0 = today();
  for (const t of txs) {
    if (!t.cur || t.cur === L.base) { t.value = t.amount; continue; }
    const v = convert(t.amount, t.cur, L.base, t.date) ?? convert(t.amount, t.cur, L.base, t0);
    // No rate: the amount is counted as-is (and flagged, so the app can say so instead of silently mixing currencies).
    if (v == null) { t.value = t.amount; t.unconverted = true; } else t.value = Math.round(v * 100) / 100;
  }
  return txs;
}

// ---------- wealth ----------
const LIQUID_PREFIXES = ['assets:bank', 'assets:cash', 'assets:investments', 'assets:manual:liquid'];
const startsWith = (a, ps) => ps.some((p) => a === p || a.startsWith(p + ':'));

async function wealthData() {
  writeDerived();
  const cfg = loadConfig(), base = cfg.base, val = base ? ['--value=now,' + base] : [];
  let all, qty, costBy;
  if (useHledger()) {
    let cost;
    [all, qty, cost] = await Promise.all([hl.balances(['^assets', '^liabilities', ...val]), hl.balances(['^assets:investments']), hl.balances(['^assets:investments', '--cost', ...val])]);
    costBy = Object.fromEntries(cost.map((r) => [r.account, r.amounts[base] || 0]));
  } else {
    const L = ledger.build();
    all = ledger.balances(L, ['assets', 'liabilities'], { value: { target: base, date: today() } });
    qty = ledger.balances(L, ['assets:investments']);
    costBy = ledger.costBasis(L, base, today());
  }
  const accounts = all.map((r) => ({ account: r.account, value: r2(r.amounts[base] || 0), unpriced: Object.entries(r.amounts).filter(([c]) => c !== base).map(([c, v]) => `${v} ${c}`) }));
  const sum = (pred) => r2(accounts.filter((a) => pred(a.account)).reduce((s, a) => s + a.value, 0));
  const valueBy = Object.fromEntries(all.map((r) => [r.account, r.amounts[base] || 0]));
  const investments = qty.map((r) => {
    const q = Object.values(r.amounts)[0], value = valueBy[r.account] || 0, c = costBy[r.account] || 0;
    return { symbol: r.account.split(':').pop().toUpperCase(), qty: q, value: r2(value), cost: r2(c), pl: r2(value - c), plPct: c ? Math.round(((value - c) / c) * 1000) / 10 : null };
  });
  const man = manual.summarize(accounts, today());
  const stalePrices = stale(base);
  const cash = sum((a) => startsWith(a, ['assets:bank', 'assets:cash']));
  const inv = sum((a) => startsWith(a, ['assets:investments']));
  const liquidManual = sum((a) => startsWith(a, ['assets:manual:liquid']));
  const illiquidAssets = sum((a) => startsWith(a, ['assets:manual:illiquid']));
  const secured = -sum((a) => startsWith(a, ['liabilities:secured'])), unsecured = -sum((a) => startsWith(a, ['liabilities:unsecured']));
  const illiquidParts = {};
  for (const a of man) if (a.kind === 'asset' && !a.liquid && !a.closed && a.valueBase) illiquidParts[a.typeLabel] = (illiquidParts[a.typeLabel] || 0) + a.valueBase;
  return {
    base, netWorth: sum(() => true), liquid: r2(cash + inv + liquidManual - unsecured), illiquid: r2(illiquidAssets - secured),
    cash, investmentsValue: inv, liquidManual, illiquidAssets, secured, unsecured, illiquidParts: Object.entries(illiquidParts).map(([name, value]) => ({ name, value: r2(value) })),
    accounts, investments, manual: man, unpriced: accounts.flatMap((a) => a.unpriced), stalePrices,
  };
}

const STALE_DAYS = 7;
/**
 * Market prices (stocks, funds, exchange rates) older than a week, for commodities you actually hold.
 * Manual assets are not included: their values are yours to record, and the Assets page shows their age separately.
 */
function stale(base) {
  const L = ledger.build(), t = today(), held = new Set(), securities = new Set();
  for (const r of ledger.balances(L, ['assets:bank', 'assets:cash', 'assets:investments', 'liabilities'])) for (const c of Object.keys(r.amounts)) if (c !== base && !c.startsWith('MANUAL_')) { held.add(c); if (r.account.startsWith('assets:investments')) securities.add(c); }
  // A stock priced in USD also depends on the USD rate, so the currencies of held items' prices count too.
  for (const p of L.prices) if (held.has(p.from) && p.to !== base) held.add(p.to);
  const latest = {};
  // A stock quote in USD ("AAPL 231 USD") dates the stock, not the dollar's exchange rate.
  for (const p of L.prices) if (p.date <= t) for (const c of securities.has(p.from) ? [p.from] : [p.from, p.to]) if (held.has(c) && !(latest[c] >= p.date)) latest[c] = p.date;
  return Object.entries(latest).map(([commodity, date]) => ({ commodity, date, days: Math.round((Date.parse(t) - Date.parse(date)) / 864e5) }))
    .filter((x) => x.days > STALE_DAYS).sort((a, b) => b.days - a.days);
}

const RANGES = { '1M': ['day', 31], '3M': ['week', 92], YTD: ['week', null], '1Y': ['week', 366], All: ['month', null] };
/** Net worth + liquid net worth over time. Values use the latest known price at each date. */
async function wealthHistory(range = '1Y') {
  const base = loadConfig().base, [step, days] = RANGES[range] || RANGES['1Y'];
  const t = today();
  let from;
  if (range === 'YTD') from = `${t.slice(0, 4)}-01-01`;
  else if (days) from = shiftDays(t, -days);
  else {
    const first = useHledger() ? (await hl.run(['print', '-O', 'csv'])).split('\n').slice(1).map((l) => l.split(',')[1]?.replace(/"/g, '')).filter(Boolean).sort()[0] : ledger.build().postings.map((p) => p.date).sort()[0];
    from = (first || t).slice(0, 7) + '-01';
  }
  const to = shiftDays(t, 1);
  const LIQUID = ['^assets:bank', '^assets:cash', '^assets:investments', '^assets:manual:liquid', '^liabilities:unsecured'];
  let net, liquid;
  if (useHledger()) {
    const flag = { day: '-D', week: '-W', month: '-M' }[step];
    const series = async (queries) => {
      const j = await hl.json(['bal', ...queries, flag, '--historical', '--value=end,' + base, '-b', from, '-e', to]);
      const cols = j.prTotals?.prrAmounts || [];
      return (j.prDates || []).map((d, i) => ({ date: d[0].contents, value: r2((cols[i] || []).find((a) => a.acommodity === base)?.aquantity.floatingPoint || 0) }));
    };
    [net, liquid] = await Promise.all([series(['^assets', '^liabilities']), series(LIQUID)]);
  } else {
    [net, liquid] = ledger.series(ledger.build(), [{ prefixes: ['assets', 'liabilities'] }, { prefixes: LIQUID.map((x) => x.slice(1)) }], step, from, to, base).map((s) => s.map((p) => ({ ...p, value: r2(p.value) })));
  }
  return { range, step, net, liquid: liquid.length === net.length ? liquid : [] };
}

// ---------- pages ----------
const monthKey = (d) => d.slice(0, 7);
const shiftMonth = (m, n) => { const d = new Date(m + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };
const label = (c) => c.replace(/^(expenses|income):?/, '').split(':').filter(Boolean).map((s) => s[0].toUpperCase() + s.slice(1).replace(/-/g, ' ')).join(' › ') || c;

function categoryList(txs, cfg) {
  const set = new Set(['expenses:uncategorized', 'income:uncategorized', ...cfg.rules.map((r) => r.account), ...(cfg.categories || []), ...Object.keys(cfg.budgets), ...txs.map((t) => t.category)]);
  return [...set].filter((c) => /^(expenses|income)(:|$)/.test(c)).sort().map((account) => ({ account, label: label(account), budget: A.normBudgets(cfg.budgets)[account]?.amount ?? null, budgetPeriod: A.normBudgets(cfg.budgets)[account]?.period ?? 'month', kind: account.startsWith('income') ? 'income' : 'expense' }));
}

/** Which currencies your accounts use, whether you confirmed the main currency, and what could not be converted. */
function currencyState(cfg, accts, txs) {
  const accounts = [...new Set([...accts.map((a) => a.currency), ...txs.map((t) => t.cur)].filter((c) => /^[A-Z]{3}$/.test(c || '')))].sort();
  const unconverted = {};
  for (const t of txs) if (t.unconverted) unconverted[t.cur] = (unconverted[t.cur] || 0) + 1;
  return { base: cfg.base, confirmed: !!cfg.baseConfirmed, accounts, unconverted };
}

/** Change the main currency everything is shown in (budgets and goal targets keep their numbers). */
function setBase(base) {
  base = String(base || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(base)) throw new Error('Use a 3-letter ISO currency code.');
  const cfg = loadConfig(); cfg.base = base; cfg.baseConfirmed = true; saveConfig(cfg);
  writeDerived();
  return { base };
}
function confirmBase() { const cfg = loadConfig(); if (!cfg.base) throw new Error('There is no currency to confirm yet.'); cfg.baseConfirmed = true; saveConfig(cfg); return { base: cfg.base }; }

async function state() {
  const cfg = loadConfig(), txs = await transactions();
  const session = fs.existsSync(paths.session) ? JSON.parse(fs.readFileSync(paths.session, 'utf8')) : null;
  const accts = Object.values(store.accounts());
  const subs = A.subscriptions(txs, today());
  const an = A.anomalies(txs, subs, today(), cfg.anomalyMin);
  return {
    base: cfg.base, today: today(), connected: !!session, bank: session?.aspsp || null, validUntil: session?.access?.valid_until || null,
    backup: require('./backup').summary(),
    lastSync: accts.map((a) => a.lastSync).filter(Boolean).sort().pop() || null, accountCount: accts.length,
    reviewCount: A.reviewQueue(txs).length + an.filter((x) => x.severity !== 'low').length,
    currency: currencyState(cfg, accts, txs),
  };
}

async function overview() {
  const cfg = loadConfig(), t = today(), txs = await transactions(), m = A.monthly(txs, 12);
  const cur = monthKey(t), prev = shiftMonth(cur, -1);
  const get = (k) => m.find((x) => x.month === k) || { income: 0, spend: 0, saved: 0 };
  const wealth = await wealthData();
  const accts = store.accounts();
  const bankRows = wealth.accounts.filter((a) => a.account.startsWith('assets:bank')).map((a) => ({ ...a, name: Object.values(accts).find((x) => 'assets:bank:' + x.name === a.account)?.label || a.account.split(':').pop() }));
  const sp = A.spendingReport(txs, { period: 'month', count: 4, today: t, budgets: cfg.budgets });
  return {
    wealth, thisMonth: get(cur), lastMonth: get(prev), cashflow: m,
    categories: sp.tables[cur].rows.map((r) => ({ key: r.key, name: label(r.key), amount: r.amount, last: sp.tables[prev]?.rows.find((x) => x.key === r.key)?.amount || 0, avg: r.avg })),
    recent: [...txs].reverse().slice(0, 25), accounts: bankRows,
  };
}

async function spending(q) {
  const cfg = loadConfig();
  const txs = await transactions();
  const r = A.spendingReport(txs, { period: q.period, count: +q.count || 12, group: q.group, account: q.account || null, parent: q.parent || 'expenses', today: today(), budgets: cfg.budgets });
  r.accounts = [...new Set(txs.map((t) => t.account))];
  const subs = A.subscriptions(txs, today());
  r.recurring = subs;
  return r;
}

async function transactionsPage(q) {
  const txs = await transactions(), cfg = loadConfig();
  const text = (q.q || '').toLowerCase();
  const rows = txs.filter((t) => (!text || t.desc.toLowerCase().includes(text)) && (!q.account || t.account === q.account) && (!q.category || t.category === q.category || t.category.startsWith(q.category + ':')) && (!q.from || t.date >= q.from) && (!q.to || t.date <= q.to)).reverse();
  const offset = +q.offset || 0, limit = Math.min(+q.limit || 100, 500);
  return { total: rows.length, rows: rows.slice(offset, offset + limit), categories: categoryList(txs, cfg), accounts: [...new Set(txs.map((t) => t.account))] };
}

async function review() {
  const txs = await transactions(), cfg = loadConfig(), t = today();
  const subs = A.subscriptions(txs, t);
  // Each unknown merchant gets a suggested category learned from what you have already categorized (lib/suggest.js).
  const model = suggest.train(txs);
  const merchants = A.reviewQueue(txs).map((m) => ({ ...m, suggestion: suggest.suggest(model, m.name, (m.dir === 'out' ? -1 : 1) * (m.total / m.count || 1)) }));
  return { merchants, anomalies: A.anomalies(txs, subs, t, cfg.anomalyMin), subscriptions: subs, categories: categoryList(txs, cfg) };
}

async function categories() { const txs = await transactions(); return categoryList(txs, loadConfig()); }

// ---------- mutations ----------
const CAT = /^(expenses|income)(:[a-z0-9][a-z0-9-]*)*$/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function mustCat(c) { if (!CAT.test(c)) throw new Error('Category must look like expenses:food:groceries'); return c; }

function setRules(rules) {
  if (!Array.isArray(rules)) throw new Error('rules must be an array');
  const clean = rules.map((r) => {
    new RegExp(r.match, 'i');
    return { match: String(r.match), account: mustCat(r.account), ...(r.dir === 'in' || r.dir === 'out' ? { dir: r.dir } : {}) };
  });
  saveConfig({ ...loadConfig(), rules: clean }); rebuildBank(); return clean;
}
function assignMerchant(merchantKey, category) {
  mustCat(category);
  const cfg = loadConfig();
  const match = merchantKey.split(' ').map(escapeRe).join('.*');
  cfg.rules.unshift({ match, account: category });
  saveConfig(cfg); rebuildBank();
}
/** Apply several merchant → category choices at once (Review's "Accept all"), with one save and one rebuild. */
function assignMerchants(list) {
  if (!Array.isArray(list) || !list.length) throw new Error('Nothing to apply.');
  const cfg = loadConfig();
  for (const { merchant, category } of list) { mustCat(category); cfg.rules.unshift({ match: String(merchant).split(' ').map(escapeRe).join('.*'), account: category }); }
  saveConfig(cfg); rebuildBank();
  return { applied: list.length };
}
function setOverride(id, category) {
  const ov = store.overrides();
  if (category) ov[id] = mustCat(category); else delete ov[id];
  store.saveOverrides(ov); rebuildBank();
}
function setBudget(category, amount, period = 'month') {
  mustCat(category);
  const cfg = loadConfig();
  if (amount === null || amount === '' || amount === undefined) delete cfg.budgets[category];
  else {
    const n = Number(amount);
    if (!Number.isFinite(n) || n < 0) throw new Error('Budget must be a number ≥ 0');
    cfg.budgets[category] = period === 'year' ? { amount: n, period: 'year' } : n; // monthly stays a plain number
  }
  saveConfig(cfg); writeDerived();
}
function addCategory(account) {
  mustCat(account);
  const cfg = loadConfig();
  if (!cfg.categories.includes(account)) cfg.categories.push(account);
  saveConfig(cfg);
}

module.exports = { setBase, confirmBase, assignMerchants, transactions, wealth: wealthData, wealthHistory, state, overview, spending, transactionsPage, review, categories, setRules, assignMerchant, setOverride, setBudget, addCategory, today, label };
