// Paths, .env loading and user config (data/config.json).
const fs = require('fs');
const os = require('os');
const path = require('path');

// Inside the packaged single-file app there is no source tree: assets are embedded and data lives in the user's profile.
let sea = null;
try { const m = require('node:sea'); if (m.isSea()) sea = m; } catch { /* older Node */ }
const PACKAGED = !!sea;
const ROOT = PACKAGED ? path.dirname(process.execPath) : path.join(__dirname, '..');

// .env is a developer convenience. The packaged app is configured from the UI (Settings → Connections).
const envFile = path.join(ROOT, '.env');
if (!PACKAGED && !process.env.PENNYSTEAD_NO_ENV && fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#')) process.env[m[1]] ??= m[2];
  }
}

function userDataDir() {
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Pennystead');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Pennystead');
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'pennystead');
}
const DATA_DIR = path.resolve(ROOT, process.env.PENNYSTEAD_DATA || process.env.DATA_DIR || (PACKAGED ? userDataDir() : 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
try { fs.chmodSync(DATA_DIR, 0o700); } catch { /* not supported (Windows) */ }
const p = (f) => path.join(DATA_DIR, f);
const paths = {
  main: p('main.journal'), bank: p('bank.journal'), manual: p('manual.journal'),
  holdings: p('holdings.journal'), prices: p('prices.journal'), budget: p('budget.journal'),
  config: p('config.json'), imports: p('imports.json'), importProfiles: p('import-profiles.json'), backupState: p('backup-state.json'), passphrase: p('backup.passphrase'), googleToken: p('google-token.json'), txs: p('transactions.json'), overrides: p('overrides.json'), manualAssets: p('manual-assets.json'), valuations: p('valuations.journal'), session: p('session.json'), accounts: p('accounts.json'), reviewHidden: p('review-hidden.json'), trash: p('deleted-transactions.json'),
  investments: p('investments.json'), mcpTokens: p('mcp-tokens.json'), auth: p('auth.json'), secrets: p('secrets.json'), demoFlag: p('demo.flag'), goalChecks: p('goal-checks.json'),
};

// First match wins. `match` is a case-insensitive regex tested on counterparty + remittance text.
const DEFAULT_RULES = [
  { match: 'salary|payroll|wage|palkka|gehalt|maaş', account: 'income:salary', dir: 'in' },
  { match: 'interest|dividend|osinko|zins', account: 'income:investments', dir: 'in' },
  { match: 'rent|vuokra|miete|kira', account: 'expenses:housing:rent', dir: 'out' },
  { match: 'netflix|disney|hbo|spotify|youtube premium|apple music|prime video|deezer|amazon prime', account: 'expenses:subscriptions:media' },
  { match: 'icloud|google one|dropbox|adobe|microsoft 365|github|openai|anthropic|notion', account: 'expenses:subscriptions:software' },
  { match: 'gym|fitness|clubhouse', account: 'expenses:subscriptions:fitness' },
  { match: 'lidl|aldi|tesco|carrefour|rewe|edeka|migros|kroger|walmart|grocer|supermarket|s-market|k-market|prisma|bim\\b|a101', account: 'expenses:food:groceries' },
  { match: 'wolt|uber eats|deliveroo|foodora', account: 'expenses:food:delivery' },
  { match: 'cafe|coffee|starbucks|bakery', account: 'expenses:food:coffee-snacks' },
  { match: 'restaurant|ravintola|mcdonald|burger|pizza|kebab|bar & grill', account: 'expenses:food:restaurants' },
  { match: 'uber|bolt|taxi|shell|esso|fuel|petrol|train|metro|transit|airline|ryanair|easyjet', account: 'expenses:transport' },
  { match: 'electric|energy|water|internet|mobile|telia|vodafone|comcast|utility', account: 'expenses:housing:utilities' },
  { match: 'pharmacy|apotek|doctor|dental|clinic|hospital', account: 'expenses:health' },
  { match: 'amazon|ebay|zalando|ikea|media ?markt', account: 'expenses:shopping' },
  { match: 'insurance|vakuutus|versicherung', account: 'expenses:insurance' },
  { match: 'atm|cash withdrawal', account: 'expenses:cash' },
];

const DEFAULTS = {
  base: null, // never assumed: taken from your accounts until you confirm one (see detectBase)
  rules: DEFAULT_RULES,
  // Monthly budget per account prefix, in base currency. Try: node cli.js suggest-budgets --write
  budgets: {},
  // { symbol, av (Alpha Vantage ticker), qty, cost (total cost basis, optional), currency (quote currency), since }
  holdings: [],
  // { currency, amount, account }  e.g. foreign-currency cash
  cash: [],
  // Extra category accounts to offer in dropdowns even before they have transactions
  categories: [],
  anomalyMin: 30,
  // interval: off | daily | weekly | on-change (checked every 10 min). Scheduled runs skip when nothing changed.
  // window: 'app' opens Pennystead in its own window (Chrome/Edge/Brave app mode) when one is installed; 'browser' uses a tab.
  window: 'app',
  // goalChecks: 'monthly' checks every savings goal at the start of each month and keeps the result; 'off' disables it.
  goalChecks: 'monthly',
  // autoSync: banks are fetched in the background (on start, then every few hours); false leaves it to the Sync button.
  autoSync: true,
  backup: { interval: 'daily', keep: 14, local: { enabled: true, dir: '' }, drive: { enabled: false, keep: 30 } },
};

/** Write a file so a crash or power cut mid-write leaves either the old or the new content, never half a file. */
function writeAtomic(f, data, opts) {
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, opts);
  fs.renameSync(tmp, f);
}

function loadConfig() {
  if (!fs.existsSync(paths.config)) writeAtomic(paths.config, JSON.stringify(DEFAULTS, null, 2));
  let saved;
  try { saved = JSON.parse(fs.readFileSync(paths.config, 'utf8')); } catch { throw new Error(`Your settings file (${paths.config}) is damaged. Restore it from a backup in Settings → Backups, or delete it to start with default settings.`); }
  const c = { ...DEFAULTS, ...saved };
  // Until you confirm a main currency, it is the one your own data uses (bank and imported accounts, then
  // transactions, then manual assets). An older install's saved "EUR" was only a default, so it is not trusted.
  if (!saved.baseConfirmed) c.base = detectBase();
  const b = c.backup || {};
  c.backup = { ...DEFAULTS.backup, ...b, local: { ...DEFAULTS.backup.local, ...b.local }, drive: { ...DEFAULTS.backup.drive, ...b.drive } };
  return c;
}
const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const mtime = (f) => { try { const st = fs.statSync(f); return `${st.mtimeMs}:${st.size}`; } catch { return '-'; } };
let detectCache = { key: null, base: null };
/** The currency most of your accounts use (ties broken by number of transactions), or null when nothing says. */
function detectBase() {
  const key = [paths.accounts, paths.txs, paths.manualAssets].map(mtime).join('|');
  if (detectCache.key === key) return detectCache.base;
  const count = {}, add = (c, n = 1) => { if (/^[A-Z]{3}$/.test(c || '')) count[c] = (count[c] || 0) + n; };
  for (const a of Object.values(readJSON(paths.accounts) || {})) add(a.currency || a.opening?.cur, 1000);
  for (const t of Object.values(readJSON(paths.txs) || {})) add(t.cur, 1);
  if (!Object.keys(count).length) for (const a of readJSON(paths.manualAssets)?.assets || []) add(a.currency);
  const base = Object.entries(count).sort((x, y) => y[1] - x[1])[0]?.[0] || null;
  detectCache = { key, base };
  return base;
}
const saveConfig = (c) => writeAtomic(paths.config, JSON.stringify(c, null, 2));

module.exports = { ROOT, DATA_DIR, PACKAGED, paths, loadConfig, saveConfig, DEFAULTS, writeAtomic, detectBase };
