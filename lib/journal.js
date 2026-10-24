// Turns bank transactions into hledger journal entries and (re)generates derived journal files.
const fs = require('fs');
const crypto = require('crypto');
const { paths, loadConfig, writeAtomic } = require('./config');
const manual = require('./manual');
const investments = require('./investments');
const store = require('./store');
const { normBudgets } = require('./analysis');

const slug = (s) => ascii(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const q = (c) => (/^[A-Za-z_]+$/.test(c) ? c : `"${c}"`);
const money = (n, c) => `${n.toFixed(2)} ${q(c)}`;
// hledger reads journal files using the machine's locale, and a non-UTF-8 locale makes a single "ä" or "ş" fatal for every report.
// The generated journals are therefore kept ASCII-only. Real names stay in transactions.json and are what the UI shows.
const { ascii } = require('./journal-text');
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');

const party = (t) => (t.credit_debit_indicator === 'DBIT' ? t.creditor?.name : t.debtor?.name);
const txDate = (t) => t.booking_date || t.value_date || t.transaction_date;
const signed = (t) => (t.credit_debit_indicator === 'DBIT' ? -1 : 1) * parseFloat(t.transaction_amount.amount);
const searchText = (t) => [party(t), (t.remittance_information || []).join(' '), t.note].filter(Boolean).join(' ');
function description(t) {
  const d = party(t) || (t.remittance_information || [])[0] || t.note || 'Unknown';
  return d.replace(/[;|\r\n]+/g, ' ').replace(/\s+/g, ' ').replace(/^[()!*\s]+/, '').trim().slice(0, 70) || 'Unknown';
}

function categorize(text, dir, rules) {
  const folded = ascii(text); // "Café" must match a rule written as "cafe"; a rule written with accents still matches the original text
  for (const r of rules) {
    if (r.dir && r.dir !== dir) continue;
    try { const re = new RegExp(r.match, 'i'); if (re.test(text) || re.test(folded)) return r.account; } catch { /* bad regex: skip */ }
  }
  return dir === 'out' ? 'expenses:uncategorized' : 'income:uncategorized';
}

function txId(uid, t, seen) {
  const base = t.entry_reference || [txDate(t), t.transaction_amount.amount, t.credit_debit_indicator, description(t)].join('|');
  let h = sha(uid + '|' + base).slice(0, 12);
  if (seen[h]) h = sha(h + seen[h]).slice(0, 12);
  seen[h] = (seen[h] || 0) + 1;
  return h;
}

/** Add raw Enable Banking transactions to the store (skipping known ids). Returns { count, net, first }. */
const deletedIdsOf = () => { try { return new Set(Object.keys(JSON.parse(fs.readFileSync(paths.trash, 'utf8')))); } catch { return new Set(); } };
function ingest(uid, acct, ebTxs) {
  const all = store.txs(), seen = {}, gone = deletedIdsOf();
  // Rows imported from a statement file into this account stand for the same payments: a bank row matching one
  // (same day, same amount) is not added again. Each imported row covers one bank row.
  const imported = {};
  for (const t of Object.values(all)) if (t.acct === acct && t.src === 'import') { const k = `${t.date}|${t.amount.toFixed(2)}`; imported[k] = (imported[k] || 0) + 1; }
  let count = 0, net = 0, first = null;
  for (const t of ebTxs) {
    if (t.status && t.status !== 'BOOK') continue;
    const id = txId(uid, t, seen);
    if (all[id] || gone.has(id)) continue; // already here, or deleted by you
    const amount = signed(t), date = txDate(t);
    if (!date || !Number.isFinite(amount)) continue;
    const k = `${date}|${amount.toFixed(2)}`;
    if (imported[k]) { imported[k]--; continue; }
    all[id] = { acct, date, amount, cur: t.transaction_amount.currency, desc: description(t), text: searchText(t) };
    net += amount; count++;
    if (!first || date < first) first = date;
  }
  store.saveTxs(all);
  return { count, net, first };
}

/** Regenerate bank.journal from the raw store + current rules + per-transaction overrides. */
function rebuildBank() {
  ensureFiles();
  const rules = loadConfig().rules, ov = store.overrides(), all = store.txs(), meta = Object.values(store.accounts());
  let out = '';
  for (const m of meta) if (m.opening) out += `${m.opening.date} Opening balance  ; managed\n    assets:bank:${m.name}  ${money(m.opening.amount, m.opening.cur)}\n    equity:opening-balances\n\n`;
  for (const [id, t] of Object.entries(all).sort((a, b) => a[1].date.localeCompare(b[1].date))) {
    const cat = ov[id] || categorize(t.text, t.amount < 0 ? 'out' : 'in', rules);
    out += `${t.date} ${ascii(t.desc)}  ; eb:${id}\n    ${cat}  ${money(-t.amount, t.cur)}\n    ${t.acct}  ${money(t.amount, t.cur)}\n\n`;
  }
  writeAtomic(paths.bank, out);
}

function ensureFiles() {
  const stub = {
    [paths.main]: '; Managed by banking-dashboard. Put your own entries in manual.journal.\ninclude bank.journal\ninclude manual.journal\ninclude holdings.journal\ninclude prices.journal\ninclude valuations.journal\ninclude budget.journal\n',
    [paths.valuations]: '', [paths.bank]: '', [paths.manual]: '; Your own hand-written entries (cash purchases, loans, etc.)\n', [paths.prices]: '',
  };
  for (const [f, c] of Object.entries(stub)) if (!fs.existsSync(f)) fs.writeFileSync(f, c);
  // migrate journals created before manual assets existed
  const main = fs.readFileSync(paths.main, 'utf8');
  if (!main.includes('include valuations.journal')) fs.writeFileSync(paths.main, main.replace('include prices.journal\n', 'include prices.journal\ninclude valuations.journal\n'));
}

/** Regenerate budget.journal and holdings.journal from config. Safe to call any time. */
function writeDerived() {
  ensureFiles();
  const cfg = loadConfig();
  let b = '; Generated from config.json. Use with: hledger bal expenses --budget -M   (or -Y for yearly budgets)\n';
  const defs = Object.entries(normBudgets(cfg.budgets));
  for (const [period, word] of [['month', 'monthly'], ['year', 'yearly']]) {
    const list = defs.filter(([, d]) => d.period === period);
    if (!list.length || !cfg.base) continue; // budgets are in the main currency
    b += `~ ${word}\n`;
    for (const [acct, d] of list) b += `    ${acct}  ${money(d.amount, cfg.base)}\n`;
    b += '    assets:budget\n';
  }
  writeAtomic(paths.budget, b);

  const dates = (fs.readFileSync(paths.bank, 'utf8').match(/^\d{4}-\d{2}-\d{2}/gm) || []).sort();
  const dflt = dates[0] || require('./dates').today();
  let h = '; Generated from config.json (holdings, cash)\n';
  const imp = investments.entries(), impSymbols = investments.symbols();
  for (const x of cfg.holdings) {
    if (impSymbols.has(x.symbol)) continue;
    const cost = x.cost != null ? ` @@ ${money(x.cost, x.currency || 'USD')}` : '';
    h += `${x.since || dflt} Holding ${x.symbol}\n    assets:investments:${slug(x.symbol)}  ${x.qty} ${q(x.symbol)}${cost}\n    equity:holdings\n\n`;
  }
  for (const p of imp.postings) h += `${p.date} Holding ${p.cur}\n    ${p.account}  ${p.qty} ${q(p.cur)}\n    equity:holdings\n\n`;
  for (const p of imp.prices) h += `P ${p.date} ${q(p.from)} ${p.rate} ${q(p.to)}\n`;
  for (const c of cfg.cash) {
    h += `${c.since || dflt} Cash ${c.currency}\n    ${c.account || 'assets:cash:' + slug(c.currency)}  ${money(c.amount, c.currency)}\n    equity:holdings\n\n`;
  }
  writeAtomic(paths.holdings, h);
  manual.writeJournal(cfg.base);
}

module.exports = { ingest, rebuildBank, categorize, writeDerived, ensureFiles, slug, money, ascii };
