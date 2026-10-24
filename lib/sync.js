// Pull new booked transactions from Enable Banking into the raw store, then rebuild bank.journal.
const sessions = require('./sessions');
const { eb, allTransactions } = require('./eb');
const J = require('./journal');
const store = require('./store');
const { today } = require('./dates');

const iso = (d) => d.toISOString().slice(0, 10);
const shift = (s, n) => iso(new Date(Date.parse(s) + n * 864e5));
const r2 = (n) => Math.round(n * 100) / 100;
const month = (s, n) => { const d = new Date(s.slice(0, 7) + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return iso(d).slice(0, 7); };

// The same bank account seen through an earlier connection (Enable Banking gives accounts a new uid per session).
const sameAccount = (m, a) => !m.imported && ((m.hash && m.hash === a.identification_hash) || (m.iban && m.iban === a.account_id?.iban));

/** How much history an account has: count, first and last date, and months in between with no transactions at all. */
function coverage(acct, all = store.txs()) {
  const dates = Object.values(all).filter((t) => t.acct === acct).map((t) => t.date).sort();
  if (!dates.length) return { count: 0, first: null, last: null, gaps: [] };
  const have = new Set(dates.map((d) => d.slice(0, 7))), gaps = [];
  for (let m = month(dates[0], 1); m < dates[dates.length - 1].slice(0, 7); m = month(m, 1)) if (!have.has(m)) gaps.push(m);
  return { count: dates.length, first: dates[0], last: dates[dates.length - 1], gaps };
}

async function balance(uid) {
  const bals = (await eb('GET', `/accounts/${uid}/balances`)).balances || [];
  const b = ['CLBD', 'XPCD', 'ITBD', 'CLAV', 'ITAV'].map((t) => bals.find((x) => x.balance_type === t)).find(Boolean) || bals[0];
  return b ? { amount: parseFloat(b.balance_amount.amount), cur: b.balance_amount.currency } : null;
}

/**
 * opts.full: fetch as much history as the bank allows (also done automatically the first time an account is synced)
 * and work the opening balance out again from everything stored, so filling a gap keeps today's balance right.
 */
async function sync({ full = false } = {}) {
  const connections = sessions.list();
  if (!connections.length) throw new Error('Not connected to a bank yet.');
  J.writeDerived();
  const info = store.accounts();
  const result = [];
  // Each connected bank is synced on its own: one bank refusing (an expired consent, say) must not stop the others.
  for (const session of connections) {
    try { result.push(...(await syncSession(session, info, full))); }
    catch (e) { result.push({ account: session.aspsp?.name || 'Bank', added: 0, error: e.message }); }
  }
  store.saveAccounts(info);
  J.rebuildBank();
  if (result.every((r) => r.error)) throw new Error(result[0].error);
  return result;
}

async function syncSession(session, info, full) {
  const result = [];
  for (const a of session.accounts) {
    if (!info[a.uid]) {
      const prev = Object.keys(info).find((u) => sameAccount(info[u], a));
      // Keep its name, opening balance and transaction ids (they are derived from the first uid).
      if (prev) { info[a.uid] = { ...info[prev], idKey: info[prev].idKey || prev, prevUids: [...(info[prev].prevUids || []), prev] }; delete info[prev]; }
    }
    const meta = (info[a.uid] ??= { name: J.slug(a.name || a.details || (a.account_id?.iban || '').slice(-4) || a.uid.slice(0, 6)), label: a.name || a.details || null, iban: a.account_id?.iban || null, currency: a.currency });
    meta.hash ??= a.identification_hash || null;
    meta.bank = session.aspsp?.name || meta.bank || null;
    const acct = 'assets:bank:' + meta.name;
    const deep = full || !meta.lastSync || !meta.fullAt;
    let txs;
    if (deep) {
      try { txs = await allTransactions(a.uid, shift(today(), -730), 'longest'); }
      catch { txs = await allTransactions(a.uid, shift(today(), -365)); } // a bank that refuses the longest search still gets a year
    } else txs = await allTransactions(a.uid, shift(meta.lastSync, -10));
    const { count } = J.ingest(meta.idKey || a.uid, acct, txs);
    if (deep || !meta.opening) {
      const b = await balance(a.uid);
      if (b) {
        const mine = Object.values(store.txs()).filter((t) => t.acct === acct);
        const first = mine.reduce((m, t) => (t.date < m ? t.date : m), today());
        meta.opening = { date: shift(first, -1), amount: r2(b.amount - mine.reduce((s, t) => s + t.amount, 0)), cur: b.cur };
      }
      meta.fullAt = today();
    }
    meta.lastSync = today();
    result.push({ account: acct, added: count, ...coverage(acct) });
  }
  return result;
}

module.exports = { sync, coverage };
