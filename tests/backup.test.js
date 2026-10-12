const { dir } = require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const demo = require('../lib/demo'), b = require('../lib/backup'), core = require('../lib/core');
const { paths, loadConfig, saveConfig } = require('../lib/config');
const backupDir = path.join(dir, 'bk');

test.before(() => { demo.generate(); const c = loadConfig(); c.backup.local.dir = backupDir; c.backup.keep = 3; c.backup.interval = 'daily'; saveConfig(c); });
test.afterEach(() => b.setPassphrase(null));

test('encrypted backup round-trips; plaintext never appears; wrong or missing passphrase is refused', async () => {
  b.setPassphrase('correct horse battery');
  const r = await b.runBackup({ force: true }); assert.equal(r[0].encrypted, true);
  const f = path.join(backupDir, b.listLocal()[0].name), buf = fs.readFileSync(f);
  assert.equal(buf.subarray(0, 6).toString(), 'PSTBK1'); assert.ok(!buf.includes(Buffer.from('NETFLIX')) && !buf.includes(Buffer.from('ACME')));
  assert.throws(() => b.unpack(buf, 'wrong password'), /Wrong passphrase/); assert.throws(() => b.unpack(buf), (e) => e.needsPassphrase);
  const u = b.unpack(buf, 'correct horse battery'); assert.ok(u.files.length >= 8);
  // any flipped byte is detected (authenticated encryption)
  const t = Buffer.from(buf); t[t.length - 5] ^= 1; assert.throws(() => b.unpack(t, 'correct horse battery'), /corrupted|Wrong/);
});
test('credentials are never included', () => {
  fs.writeFileSync(paths.session, '{"secret":1}'); fs.writeFileSync(paths.secrets, '{"k":1}'); fs.writeFileSync(paths.auth, '{"h":1}'); fs.writeFileSync(paths.googleToken, '{}');
  b.setPassphrase('correct horse battery');
  const names = b.collect().files.map((x) => x.name);
  for (const n of ['session.json', 'secrets.json', 'auth.json', 'google-token.json', 'backup.passphrase', 'backup-state.json']) assert.ok(!names.includes(n), n);
  for (const n of ['transactions.json', 'accounts.json', 'config.json', 'manual-assets.json']) assert.ok(names.includes(n), n);
  for (const f of [paths.session, paths.secrets, paths.auth, paths.googleToken]) fs.rmSync(f, { force: true });
});
test('restore: exact data back, safety copy taken, credentials and backup settings untouched', async () => {
  const nw = (await core.wealth()).netWorth; await b.runBackup({ force: true });
  const name = b.listLocal().find((x) => !x.safety).name;
  const m = JSON.parse(fs.readFileSync(paths.manualAssets)); m.assets = []; fs.writeFileSync(paths.manualAssets, JSON.stringify(m));
  fs.writeFileSync(paths.session, '{"keep":"me"}'); const c = loadConfig(); c.backup.interval = 'weekly'; saveConfig(c);
  const r = b.restoreLocal(name);
  assert.equal((await core.wealth()).netWorth, nw); assert.ok(r.safetyBackup.startsWith('pre-restore-'));
  assert.equal(fs.readFileSync(paths.session, 'utf8'), '{"keep":"me"}'); assert.equal(loadConfig().backup.interval, 'weekly', 'backup settings are machine-local');
  fs.rmSync(paths.session, { force: true });
});
test('restore refuses tampered bundles (traversal, credential files, garbage)', () => {
  const evil = (files) => zlib.gzipSync(JSON.stringify({ app: 'pennystead', v: 1, files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.from(v).toString('base64')])) }));
  assert.throws(() => b.applyBackup(evil({ '../../etc/passwd': 'x' })), /unexpected file name/); assert.throws(() => b.applyBackup(evil({ 'session.json': 'x' })), /unexpected file name/);
  assert.throws(() => b.applyBackup(evil({ 'a/b.json': 'x' })), /unexpected file name/); assert.throws(() => b.applyBackup(Buffer.from('garbage')), /valid Pennystead backup/);
  assert.throws(() => b.applyBackup(evil({})), /empty/);
});
test('retention keeps the newest N and never touches safety copies', async () => {
  for (let i = 0; i < 6; i++) await b.runBackup({ force: true });
  const all = b.listLocal(); assert.equal(all.filter((x) => !x.safety).length, 3); assert.ok(all.some((x) => x.safety), 'pre-restore copy survived');
});
test('scheduling: off / daily / weekly / on-change, skip when unchanged, retry window after a failure', async () => {
  const iv = (i) => { const c = loadConfig(); c.backup.interval = i; saveConfig(c); };
  const hrs = (h) => new Date(Date.now() - h * 36e5).toISOString(), state = (o) => fs.writeFileSync(paths.backupState, JSON.stringify({ local: o }));
  const out = async () => { const r = await b.runBackup(); return r.length ? (r[0].skipped ? 'skip' : r[0].error ? 'error' : 'ran') : 'nothing'; };
  fs.rmSync(paths.backupState, { force: true });
  iv('off'); assert.equal(await out(), 'nothing');
  iv('daily'); assert.equal(await out(), 'ran'); assert.equal(await out(), 'skip', 'unchanged since the last run');
  state({ lastAt: hrs(25), lastHash: b.collect().hash }); assert.equal(await out(), 'skip', 'due, but nothing changed');
  state({ lastAt: hrs(25), lastHash: 'old' }); assert.equal(await out(), 'ran'); state({ lastAt: hrs(2), lastHash: 'old' }); assert.equal(await out(), 'skip', 'not due yet');
  iv('weekly'); state({ lastAt: hrs(24 * 6), lastHash: 'old' }); assert.equal(await out(), 'skip'); state({ lastAt: hrs(24 * 8), lastHash: 'old' }); assert.equal(await out(), 'ran');
  iv('on-change'); state({ lastAt: hrs(0.1), lastHash: 'old' }); assert.equal(await out(), 'ran'); assert.equal(await out(), 'skip');
  iv('daily'); state({ lastAt: hrs(30), lastHash: 'old', lastError: 'disk full', lastAttemptAt: hrs(0.2) }); assert.equal(await out(), 'skip', 'failed 12 minutes ago: wait');
  state({ lastAt: hrs(30), lastHash: 'old', lastError: 'x', lastAttemptAt: hrs(2) }); assert.equal(await out(), 'ran', 'failed 2h ago: retry');
  iv('off'); assert.equal((await b.runBackup({ force: true }))[0].file.startsWith('pennystead-'), true, '"Back up now" ignores the schedule');
});
test('Google Drive is refused without a passphrase (financial data must not be uploaded in the clear)', async () => {
  const gd = require('../lib/gdrive'); const c = loadConfig(); c.backup.drive.enabled = true; saveConfig(c);
  const r = (await b.runBackup({ force: true })).find((x) => x.dest === 'drive'); assert.match(r.error, /passphrase|not connected/i);
  const c2 = loadConfig(); c2.backup.drive.enabled = false; saveConfig(c2);
});
