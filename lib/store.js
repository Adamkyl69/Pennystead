// Small JSON stores: raw transactions, per-transaction category overrides, bank account metadata.
const fs = require('fs');
const { paths } = require('./config');
const read = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d);
const write = (f, o) => { fs.writeFileSync(f + '.tmp', JSON.stringify(o)); fs.renameSync(f + '.tmp', f); };
module.exports = {
  txs: () => read(paths.txs, {}), saveTxs: (o) => write(paths.txs, o),
  overrides: () => read(paths.overrides, {}), saveOverrides: (o) => write(paths.overrides, o),
  accounts: () => read(paths.accounts, {}), saveAccounts: (o) => write(paths.accounts, o),
};
