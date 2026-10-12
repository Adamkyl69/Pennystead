// Pull new booked transactions from Enable Banking into the raw store, then rebuild bank.journal.
const fs = require('fs');
const { paths } = require('./config');
const { eb, allTransactions } = require('./eb');
const J = require('./journal');
const store = require('./store');
const { today } = require('./dates');

const iso = (d) => d.toISOString().slice(0, 10);
const shift = (s, n) => iso(new Date(Date.parse(s) + n * 864e5));

async function sync() {
  if (!fs.existsSync(paths.session)) throw new Error('Not connected to a bank yet.');
  const session = JSON.parse(fs.readFileSync(paths.session, 'utf8'));
  J.writeDerived();
  const info = store.accounts();
  const result = [];

  for (const a of session.accounts) {
    const meta = (info[a.uid] ??= { name: J.slug(a.name || a.details || (a.account_id?.iban || '').slice(-4) || a.uid.slice(0, 6)), label: a.name || a.details || null, iban: a.account_id?.iban || null, currency: a.currency });
    const acct = 'assets:bank:' + meta.name;
    const from = meta.lastSync ? shift(meta.lastSync, -10) : shift(today(), -365);
    const { count, net, first } = J.ingest(a.uid, acct, await allTransactions(a.uid, from));
    if (!meta.opening) {
      const bals = (await eb('GET', `/accounts/${a.uid}/balances`)).balances || [];
      const b = ['CLBD', 'XPCD', 'ITBD', 'CLAV', 'ITAV'].map((t) => bals.find((x) => x.balance_type === t)).find(Boolean) || bals[0];
      if (b) meta.opening = { date: shift(first || today(), -1), amount: parseFloat(b.balance_amount.amount) - net, cur: b.balance_amount.currency };
    }
    meta.lastSync = today();
    result.push({ account: acct, added: count });
  }
  store.saveAccounts(info);
  J.rebuildBank();
  return result;
}

module.exports = { sync };
