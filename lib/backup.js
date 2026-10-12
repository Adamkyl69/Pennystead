// Backups of everything in data/ (except credentials) to a local folder and/or Google Drive.
// Format: gzip(JSON bundle), optionally wrapped in AES-256-GCM with a scrypt-derived key.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { ROOT, DATA_DIR, paths, loadConfig, saveConfig, writeAtomic } = require('./config');
const drive = require('./gdrive');
const { writeDerived, rebuildBank } = require('./journal');

// Credentials and machine-local state are never backed up.
const EXCLUDE = new Set(['session.json', 'google-token.json', 'backup.passphrase', 'backup-state.json', 'secrets.json', 'auth.json']);
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAGIC = Buffer.from('PSTBK1');
const RESERVED = new Set(['backups']); // folders inside the data folder that a restored file must never replace
const BACKUP_FILE = /^(pennystead|pre-restore)-.*\.bak(\.enc)?$/;
const INTERVAL_MS = { daily: 24 * 36e5, weekly: 7 * 24 * 36e5 };
const RETRY_MS = 36e5;

// ---------- passphrase ----------
function passphrase() {
  if (process.env.BACKUP_PASSPHRASE) return process.env.BACKUP_PASSPHRASE;
  return fs.existsSync(paths.passphrase) ? fs.readFileSync(paths.passphrase, 'utf8').trim() : null;
}
const passphraseSource = () => (process.env.BACKUP_PASSPHRASE ? 'env' : fs.existsSync(paths.passphrase) ? 'file' : null);
function setPassphrase(p) {
  if (p === null) { fs.rmSync(paths.passphrase, { force: true }); return; }
  if (String(p).length < 8) throw new Error('Passphrase must be at least 8 characters.');
  writeAtomic(paths.passphrase, String(p), { mode: 0o600 });
}

// ---------- bundle ----------
function collect() {
  const files = [];
  for (const name of fs.readdirSync(DATA_DIR).sort()) {
    const f = path.join(DATA_DIR, name);
    if (EXCLUDE.has(name) || name.endsWith('.tmp') || !NAME_RE.test(name) || !fs.statSync(f).isFile()) continue;
    files.push({ name, data: fs.readFileSync(f) });
  }
  const h = crypto.createHash('sha256');
  for (const f of files) h.update(f.name + '\0').update(f.data).update('\0');
  return { files, hash: h.digest('hex') };
}
const pack = (files) => zlib.gzipSync(Buffer.from(JSON.stringify({ app: 'pennystead', v: 1, createdAt: new Date().toISOString(), files: Object.fromEntries(files.map((f) => [f.name, f.data.toString('base64')])) })));

const key = (pass, salt) => crypto.scryptSync(pass, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
function encrypt(buf, pass) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(pass, salt), iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), ct]);
}
const isEncrypted = (buf) => buf.subarray(0, MAGIC.length).equals(MAGIC);
function decrypt(buf, pass) {
  const o = MAGIC.length, salt = buf.subarray(o, o + 16), iv = buf.subarray(o + 16, o + 28), tag = buf.subarray(o + 28, o + 44);
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key(pass, salt), iv); d.setAuthTag(tag);
    return Buffer.concat([d.update(buf.subarray(o + 44)), d.final()]);
  } catch { throw new Error('Wrong passphrase, or the backup file is corrupted.'); }
}
/** Parse a backup file into { createdAt, files: [{name, data}] }. Validates names; never touches disk. */
function unpack(buf, pass) {
  if (isEncrypted(buf)) { if (!pass) throw Object.assign(new Error('This backup is encrypted: a passphrase is required.'), { needsPassphrase: true }); buf = decrypt(buf, pass); }
  let b;
  // Capped: a 2 MB upload must not be able to inflate to gigabytes.
  try { b = JSON.parse(zlib.gunzipSync(buf, { maxOutputLength: 512 * 1024 * 1024 }).toString('utf8')); } catch { throw new Error('Not a valid Pennystead backup file.'); }
  if (b.app !== 'pennystead' || b.v !== 1 || typeof b.files !== 'object') throw new Error('Not a valid Pennystead backup file.');
  const files = Object.entries(b.files).map(([name, data]) => {
    // Compared the way the file system will: on macOS and Windows "AUTH.JSON" or "auth.json." is auth.json.
    const fsName = name.toLowerCase().replace(/[. ]+$/, '');
    if (!NAME_RE.test(name) || EXCLUDE.has(fsName) || fsName.endsWith('.tmp') || name !== name.replace(/[. ]+$/, '') || RESERVED.has(fsName)) throw new Error(`Backup contains an unexpected file name: ${name}`);
    return { name, data: Buffer.from(data, 'base64') };
  });
  return { createdAt: b.createdAt, files };
}

// ---------- state & config ----------
// Bookkeeping only: if it is damaged, the next backup simply runs as if none had been made yet.
const readState = () => { try { return JSON.parse(fs.readFileSync(paths.backupState, 'utf8')); } catch { return {}; } };
const writeState = (s) => writeAtomic(paths.backupState, JSON.stringify(s, null, 2));
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '');
const fileName = (enc, prefix = 'pennystead') => `${prefix}-${stamp()}.bak${enc ? '.enc' : ''}`;

function localDir() {
  const d = loadConfig().backup.local.dir;
  const dir = d ? path.resolve(ROOT, d.replace(/^~(?=$|\/)/, os.homedir())) : path.join(DATA_DIR, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function listLocal() {
  const dir = localDir();
  return fs.readdirSync(dir).filter((n) => BACKUP_FILE.test(n)).map((name) => { const st = fs.statSync(path.join(dir, name)); return { name, size: st.size, createdAt: st.mtime.toISOString(), encrypted: name.endsWith('.enc'), safety: name.startsWith('pre-restore') }; }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function updateConfig(patch) {
  const cfg = loadConfig(), b = cfg.backup;
  if (patch.interval !== undefined) { if (!['off', 'daily', 'weekly', 'on-change'].includes(patch.interval)) throw new Error('Invalid interval'); b.interval = patch.interval; }
  if (patch.keep !== undefined) b.keep = Math.max(1, Math.min(365, Math.floor(+patch.keep) || 14));
  if (patch.local) { if (patch.local.enabled !== undefined) b.local.enabled = !!patch.local.enabled; if (patch.local.dir !== undefined) b.local.dir = String(patch.local.dir).trim(); }
  if (patch.drive) { if (patch.drive.enabled !== undefined) b.drive.enabled = !!patch.drive.enabled; if (patch.drive.keep !== undefined) b.drive.keep = Math.max(1, Math.min(365, Math.floor(+patch.drive.keep) || 30)); }
  if (b.drive.enabled && !drive.connected()) throw new Error('Connect Google Drive before enabling it.');
  saveConfig(cfg); localDir();
  return b;
}

// ---------- running backups ----------
const due = (st, interval, hash, now) => {
  if (!st) return true;
  if (st.lastAttemptAt && st.lastError && now - Date.parse(st.lastAttemptAt) < RETRY_MS) return false;
  if (interval === 'on-change') return st.lastHash !== hash;
  return now - Date.parse(st.lastAt || 0) >= INTERVAL_MS[interval] && st.lastHash !== hash;
};

/**
 * Back up to every enabled destination.
 * force: ignore schedule and "nothing changed" checks (the Back up now button).
 */
// One backup at a time: the schedule and "Back up now" share a run instead of uploading the same data twice.
let running = null;
function runBackup(opts) {
  if (!running) running = doBackup(opts).finally(() => { running = null; });
  return running;
}
async function doBackup({ force = false } = {}) {
  const cfg = loadConfig().backup, state = readState(), now = Date.now(), nowIso = new Date(now).toISOString();
  if (!force && cfg.interval === 'off') return [];
  const pass = passphrase(), { files, hash } = collect(), out = [];
  let payload = null;
  const build = () => (payload ??= pass ? encrypt(pack(files), pass) : pack(files));
  const dests = [['local', cfg.local.enabled], ['drive', cfg.drive.enabled]].filter(([, on]) => on);

  for (const [dest] of dests) {
    const st = (state[dest] ??= {});
    if (!force && !due(st, cfg.interval, hash, now)) { out.push({ dest, skipped: true, reason: st.lastHash === hash ? 'no changes since last backup' : 'not due yet' }); continue; }
    try {
      const name = fileName(!!pass), buf = build();
      if (dest === 'local') {
        const dir = localDir(), f = path.join(dir, name);
        fs.writeFileSync(f + '.tmp', buf); fs.renameSync(f + '.tmp', f);
        unpack(fs.readFileSync(f), pass); // verify it can be read back
        const old = listLocal().filter((x) => !x.safety).slice(cfg.keep);
        for (const o of old) fs.rmSync(path.join(dir, o.name), { force: true });
        Object.assign(st, { lastFile: name, lastSize: buf.length, location: dir });
      } else {
        if (!pass && !process.env.BACKUP_ALLOW_PLAINTEXT_CLOUD) throw new Error('Set a backup passphrase before uploading to Google Drive: your financial data would otherwise be stored unencrypted.');
        const up = await drive.upload(name, buf);
        if (up.size !== buf.length) throw new Error(`Upload verification failed (${up.size} of ${buf.length} bytes stored).`);
        for (const o of (await drive.list()).slice(cfg.drive.keep)) await drive.remove(o.id).catch(() => {});
        Object.assign(st, { lastFile: name, lastSize: buf.length, location: 'Google Drive' });
      }
      Object.assign(st, { lastAt: nowIso, lastAttemptAt: nowIso, lastHash: hash, lastError: null, encrypted: !!pass });
      out.push({ dest, file: name, size: buf.length, encrypted: !!pass });
    } catch (e) {
      Object.assign(st, { lastAttemptAt: nowIso, lastError: e.message });
      out.push({ dest, error: e.message });
    }
  }
  writeState(state);
  return out;
}

// ---------- restore ----------
/** Replace data/ contents with a backup. Takes a safety backup of the current data first. */
function applyBackup(buf, pass) {
  const { files } = unpack(buf, pass);
  if (!files.length) throw new Error('The backup is empty.');
  const current = collect();
  const safety = path.join(localDir(), fileName(!!passphrase(), 'pre-restore'));
  writeAtomic(safety, passphrase() ? encrypt(pack(current.files), passphrase()) : pack(current.files));
  const mySettings = loadConfig().backup; // backup destinations/schedule are machine-local: a restore must not change them
  // Every file is checked before anything is deleted, so a bad entry cannot leave the data folder half replaced.
  for (const f of files) { const t = path.join(DATA_DIR, f.name); if (fs.existsSync(t) && !fs.statSync(t).isFile()) throw new Error(`Backup contains an unexpected file name: ${f.name}`); }
  for (const f of files) writeAtomic(path.join(DATA_DIR, f.name), f.data);
  const keep = new Set(files.map((f) => f.name));
  for (const f of current.files) if (!keep.has(f.name)) fs.rmSync(path.join(DATA_DIR, f.name), { force: true });
  const restored = loadConfig(); restored.backup = mySettings; saveConfig(restored);
  writeDerived(); rebuildBank();
  return { restored: files.length, safetyBackup: path.basename(safety) };
}
function restoreLocal(name, pass) {
  if (!BACKUP_FILE.test(name)) throw new Error('Invalid backup name.');
  const f = path.join(localDir(), name);
  if (!fs.existsSync(f)) throw new Error('Backup not found.');
  return applyBackup(fs.readFileSync(f), pass || passphrase());
}
async function restoreDrive(id, pass) { return applyBackup(await drive.download(id), pass || passphrase()); }

async function status() {
  const cfg = loadConfig().backup, state = readState();
  return {
    config: cfg, state, local: { dir: localDir(), files: listLocal(), insideData: localDir().startsWith(DATA_DIR) },
    passphrase: { set: !!passphrase(), source: passphraseSource() },
    google: { configured: drive.configured(), connected: drive.connected(), account: drive.connected() ? await drive.account() : null },
  };
}
/** Short summary for the sidebar. */
function summary() {
  const cfg = loadConfig().backup, st = readState();
  const last = [st.local?.lastAt, st.drive?.lastAt].filter(Boolean).sort().pop() || null;
  const err = (cfg.local.enabled && st.local?.lastError) || (cfg.drive.enabled && st.drive?.lastError) || null;
  return { enabled: cfg.interval !== 'off' && (cfg.local.enabled || cfg.drive.enabled), lastAt: last, error: err };
}

module.exports = { runBackup, restoreLocal, restoreDrive, applyBackup, status, summary, updateConfig, setPassphrase, listLocal, localDir, collect, pack, encrypt, unpack, passphrase };
