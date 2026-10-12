// Every test file runs in its own process; this gives it a private, empty data folder BEFORE any Pennystead module is loaded.
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pennystead-test-'));
for (const k of ['DATA_DIR', 'APP_ID', 'KEY_PATH', 'ALPHAVANTAGE_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'PENNYSTEAD_PASSWORD', 'BACKUP_PASSPHRASE', 'PENNYSTEAD_ENGINE']) delete process.env[k];
process.env.PENNYSTEAD_DATA = dir; process.env.PENNYSTEAD_NO_ENV = '1'; process.env.PENNYSTEAD_NO_BROWSER = '1';
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
const FIX = path.join(__dirname, 'fixtures');
module.exports = { dir, FIX, fixture: (n) => fs.readFileSync(path.join(FIX, n)) };
