// A readable Excel copy of your data: every transaction, today's balances, and spending per category per month.
// It is a copy for reading, sorting and sharing; the .bak backup is what restores Pennystead exactly.
const core = require('./core');
const store = require('./store');
const { loadConfig } = require('./config');
const { writeXlsx } = require('./xlsxwrite');
const { today } = require('./dates');

async function workbook() {
  const txs = await core.transactions(), w = await core.wealth(), base = loadConfig().base;
  const labels = Object.fromEntries(Object.values(store.accounts()).map((a) => ['assets:bank:' + a.name, a.label || a.name]));
  const acct = (a) => labels[a] || a.split(':').slice(1).map((p) => p.replace(/-/g, ' ')).join(' / ');
  const cat = (c) => c.split(':').map((p) => p.replace(/-/g, ' ')).join(' / ');

  const transactions = {
    name: 'Transactions',
    columns: [{ header: 'Date', type: 'date' }, { header: 'Account', width: 22 }, { header: 'Description', width: 40 }, { header: 'Category', width: 30 }, { header: 'Amount', type: 'money' }, { header: 'Currency', width: 9 }, { header: `Amount in ${base}`, type: 'money' }],
    rows: [...txs].sort((a, b) => b.date.localeCompare(a.date)).map((t) => [t.date, acct(t.account), t.desc, cat(t.category), t.amount, t.cur, t.value ?? t.amount]),
  };

  const balances = {
    name: 'Balances',
    columns: [{ header: 'Account', width: 34 }, { header: `Value in ${base}`, type: 'money', width: 16 }],
    rows: [...w.accounts.map((a) => [acct(a.account), a.value]), [], ['Net worth', w.netWorth], ['Liquid', w.liquid], [`As of ${today()}`]],
  };

  // Spending per category (rows) and month (columns), newest month first, last 24 months.
  const months = [...new Set(txs.map((t) => t.date.slice(0, 7)))].sort().reverse().slice(0, 24);
  const sums = {};
  for (const t of txs) {
    if (!t.category.startsWith('expenses') || !months.includes(t.date.slice(0, 7))) continue;
    const k = t.category.split(':').slice(0, 2).join(':'), m = t.date.slice(0, 7);
    (sums[k] ??= {})[m] = (sums[k][m] || 0) - (t.value ?? t.amount);
  }
  const r2 = (n) => Math.round(n * 100) / 100;
  const rows = Object.entries(sums).map(([k, by]) => [cat(k.replace(/^expenses:?/, '') || 'other'), ...months.map((m) => r2(by[m] || 0)), r2(Object.values(by).reduce((s, v) => s + v, 0))]).sort((a, b) => b[b.length - 1] - a[a.length - 1]);
  const spending = {
    name: 'Spending by month',
    columns: [{ header: 'Category', width: 26 }, ...months.map((m) => ({ header: m, type: 'money', width: 11 })), { header: 'Total', type: 'money' }],
    rows: rows.length ? [...rows, ['All spending', ...months.map((_, i) => r2(rows.reduce((s, r) => s + r[i + 1], 0))), r2(rows.reduce((s, r) => s + r[r.length - 1], 0))]] : [],
  };

  return writeXlsx([transactions, balances, spending]);
}

module.exports = { workbook };
