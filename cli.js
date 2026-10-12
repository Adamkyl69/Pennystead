#!/usr/bin/env node
// node cli.js <sync|prices|overview|subs|anomalies|import <file>|imports|undo-import <id>|backup|backups|restore <file>|suggest-budgets [--write]>
const { sync } = require('./lib/sync');
const { updatePrices } = require('./lib/prices');
const core = require('./lib/core');
const A = require('./lib/analysis');
const backup = require('./lib/backup');
const importer = require('./lib/importer');
const fs = require('fs');
const { loadConfig, saveConfig } = require('./lib/config');

(async () => {
  const [cmd, flag] = process.argv.slice(2);
  const out = (x) => console.log(JSON.stringify(x, null, 2));
  if (cmd === 'sync') out(await sync());
  else if (cmd === 'prices') out(await updatePrices());
  else if (cmd === 'overview') out(await core.overview());
  else if (cmd === 'subs') out(A.subscriptions(await core.transactions(), core.today()));
  else if (cmd === 'anomalies') { const t = await core.transactions(); out(A.anomalies(t, A.subscriptions(t, core.today()), core.today(), loadConfig().anomalyMin)); }
  else if (cmd === 'import') {
    // node cli.js import <file> --account "<label or uid>" [--currency EUR] [--balance N] [--use-category] [--include-possible] [--include-overlap] [--yes]
    const a = process.argv.slice(3), file = a.find((x) => !x.startsWith('--') && (a[a.indexOf(x) - 1] || '').startsWith('--') === false);
    const opt = (n) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : undefined; }, has = (n) => a.includes('--' + n);
    if (!file || !fs.existsSync(file)) throw new Error('Usage: node cli.js import <file.csv|.xlsx> --account "<name>" [--currency EUR] [--balance N] [--use-category] [--include-possible] [--include-overlap] [--yes]');
    const d = importer.upload(fs.readFileSync(file), require('path').basename(file));
    const name = opt('account'), found = importer.accountsList().find((x) => x.uid === name || x.label.toLowerCase() === String(name).toLowerCase());
    const account = found ? { uid: found.uid } : { name, currency: opt('currency') };
    const options = { useCategory: has('use-category'), includePossible: has('include-possible'), includeOverlap: has('include-overlap'), balance: opt('balance') };
    const p = importer.preview(d.importId, d.mapping, account, options);
    console.error(`Detected: ${d.kind}${d.encoding ? ' ' + d.encoding : ''}, header row ${d.headerRow}, columns → date="${d.headers[d.mapping.date]}" description="${d.headers[d.mapping.desc]}" ${d.mapping.mode === 'split' ? `debit="${d.headers[d.mapping.debit]}" credit="${d.headers[d.mapping.credit]}"` : `amount="${d.headers[d.mapping.amount]}"`}`);
    out({ account: p.account, counts: p.counts, from: p.from, to: p.to, totals: p.totals, balance: p.balance, errors: p.errors.slice(0, 10) });
    if (has('yes')) out(importer.commit(d.importId, d.mapping, account, options)); else console.error('Preview only. Add --yes to import.');
  } else if (cmd === 'imports') out(importer.history());
  else if (cmd === 'undo-import') out(importer.undo(flag));
  else if (cmd === 'backup') out(await backup.runBackup({ force: true }));
  else if (cmd === 'backups') out(backup.listLocal());
  else if (cmd === 'restore') {
    if (!flag) throw new Error('Usage: node cli.js restore <backup file path | name in the backup folder>');
    const f = fs.existsSync(flag) ? flag : require('path').join(backup.localDir(), flag);
    out(backup.applyBackup(fs.readFileSync(f), process.env.BACKUP_PASSPHRASE || backup.passphrase() || undefined));
  } else if (cmd === 'suggest-budgets') {
    const b = A.suggestBudgets(await core.transactions(), core.today());
    out(b);
    if (flag === '--write') { const c = loadConfig(); saveConfig({ ...c, budgets: b }); console.error('Saved to config.json'); }
  } else console.error('Usage: node cli.js <sync|prices|overview|subs|anomalies|import <file>|imports|undo-import <id>|backup|backups|restore <file>|suggest-budgets [--write]>');
})().catch((e) => { console.error(e.message); process.exit(1); });
