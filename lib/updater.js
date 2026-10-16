// In-app updates from the project's GitHub Releases.
// check(): is there a newer release with a download for this computer?  install(): download it, verify its SHA-256
// against the SHA256SUMS file published with the same release, put it in place and restart Pennystead.
// Nothing about you is sent: one anonymous request to GitHub's public API, at start and every 12 hours (can be turned off).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { DATA_DIR, PACKAGED, loadConfig, saveConfig } = require('./config');
const VERSION = require('./version');

const REPO = 'Adamkyl69/Pennystead';
const api = () => process.env.PENNYSTEAD_UPDATE_API || `https://api.github.com/repos/${REPO}/releases/latest`;
const DIR = path.join(DATA_DIR, 'updates');
let cache = null, busy = null;

/** -1, 0 or 1. "v1.10.0" > "1.9.2". */
function compare(a, b) {
  const p = (v) => String(v).replace(/^v/, '').split(/[.-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

/** The release file for this computer, and the checksum list it is listed in. */
function platformAsset(version, platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return { file: `Pennystead-${version}-windows-x64-setup.exe`, sums: 'SHA256SUMS-windows-x64.txt' };
  if (platform === 'darwin') { const a = arch === 'arm64' ? 'arm64' : 'x64'; return { file: `Pennystead-${version}-macos-${a}.zip`, sums: `SHA256SUMS-macos-${a}.txt` }; }
  if (platform === 'linux' && arch === 'x64') return { file: `Pennystead-${version}-linux-x64.tar.gz`, sums: 'SHA256SUMS-linux-x64.txt' };
  return null;
}

/** Why this copy cannot update itself (null when it can). */
function cannotInstall(platform = process.platform, execPath = process.execPath) {
  if (!PACKAGED && process.env.PENNYSTEAD_UPDATE_TEST !== '1') return 'This copy runs from source code. Update it with git pull instead.';
  if (!platformAsset('0', platform)) return 'There is no download for this kind of computer.';
  if (platform === 'darwin') {
    const app = macBundle(execPath);
    if (!app) return 'Pennystead is not running from Pennystead.app.';
    if (app.startsWith('/Volumes/')) return 'Pennystead is running from the disk image. Drag it to Applications first, then open it from there.';
    if (/\/AppTranslocation\//.test(app)) return 'macOS is running Pennystead from a temporary copy. Move Pennystead.app to Applications, then open it from there.';
  }
  return null;
}
// macOS paths, whatever system this check runs on: Pennystead.app/Contents/MacOS/Pennystead → Pennystead.app
const macBundle = (execPath) => { const app = path.posix.resolve(execPath, '..', '..', '..'); return app.endsWith('.app') ? app : null; };

const auto = () => loadConfig().updates?.auto !== false;
function setAuto(on) { const c = loadConfig(); c.updates = { ...(c.updates || {}), auto: !!on }; saveConfig(c); }

async function getJSON(url) {
  const r = await fetch(url, { headers: { 'User-Agent': `Pennystead/${VERSION}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
  if (r.status === 404) return null; // no release published yet
  if (!r.ok) throw new Error(`GitHub answered ${r.status}${r.status === 403 ? ' (too many checks from this network; try again in an hour)' : ''}.`);
  return r.json();
}

/** Looks for a newer release. Returns the status shown in the app (also cached for the sidebar). */
async function check() {
  const out = { current: VERSION, latest: null, available: false, notes: '', publishedAt: null, url: null, size: null, checkedAt: new Date().toISOString(), error: null, cannotInstall: cannotInstall(), auto: auto() };
  try {
    const rel = await getJSON(api());
    if (rel && !rel.draft && !rel.prerelease) {
      const latest = String(rel.tag_name || '').replace(/^v/, ''), want = platformAsset(latest);
      const asset = want && (rel.assets || []).find((a) => a.name === want.file), sums = want && (rel.assets || []).find((a) => a.name === want.sums);
      Object.assign(out, { latest, notes: String(rel.body || '').slice(0, 4000), publishedAt: rel.published_at || null, page: rel.html_url || null });
      if (compare(latest, VERSION) > 0) {
        if (asset && sums) Object.assign(out, { available: true, url: asset.browser_download_url, sumsUrl: sums.browser_download_url, file: asset.name, size: asset.size });
        else out.error = `Version ${latest} is out, but it has no download for this computer yet.`;
      }
    }
  } catch (e) { out.error = `Could not check for updates: ${e.message}`; }
  cache = out;
  return out;
}
const status = () => cache;
/** For the sidebar: just whether there is something to install. */
const summary = () => (cache?.available ? { available: true, latest: cache.latest } : null);

async function download(url, to) {
  const r = await fetch(url, { headers: { 'User-Agent': `Pennystead/${VERSION}` }, redirect: 'follow', signal: AbortSignal.timeout(10 * 60000) });
  if (!r.ok) throw new Error(`Download failed (${r.status}).`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(to, buf);
  return buf;
}

/** Downloads the update and checks it against the release's SHA256SUMS. Returns the verified file's path. */
async function fetchVerified(st) {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, st.file);
  const buf = await download(st.url, file);
  const sums = (await download(st.sumsUrl, path.join(DIR, 'SHA256SUMS.txt'))).toString('utf8');
  const line = sums.split(/\r?\n/).map((l) => l.trim().split(/\s+\*?/)).find(([, n]) => n === st.file);
  if (!line) throw new Error('The checksum list does not mention this download. Nothing was installed.');
  const got = crypto.createHash('sha256').update(buf).digest('hex');
  if (got !== line[0].toLowerCase()) { fs.rmSync(file, { force: true }); throw new Error('The download does not match its published checksum, so it was not installed. Try again later.'); }
  return file;
}

// Starts a program that outlives this one.
const detach = (cmd, args, opts = {}) => spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, ...opts }).unref();
// Arguments to start the new version with: the same ones as now (port, data folder...), plus --updated.
const relaunchArgs = () => [...process.argv.slice(2).filter((a) => a !== '--updated'), '--updated']; // argv[1] is the program in both builds

/**
 * Puts the verified download in place and starts the new version. The caller exits right after;
 * the new version waits for the port to be free (main.js, --updated).
 */
function apply(file, { platform = process.platform, execPath = process.execPath, run = detach } = {}) {
  if (platform === 'win32') {
    // The installer replaces the app where it is now, closes this one if still running, and starts the new one.
    run(file, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/RELAUNCH=1', `/DIR=${path.win32.dirname(execPath)}`]);
    return;
  }
  const work = path.join(path.dirname(file), 'unpacked');
  fs.rmSync(work, { recursive: true, force: true }); fs.mkdirSync(work, { recursive: true });
  if (platform === 'darwin') {
    const app = macBundle(execPath), parent = path.dirname(app);
    try { fs.accessSync(parent, fs.constants.W_OK); } catch { throw new Error(`Pennystead cannot write to ${parent}. Download the update from the Releases page instead.`); }
    execFileSync('ditto', ['-x', '-k', file, work]);
    const fresh = path.join(work, 'Pennystead.app');
    if (!fs.existsSync(path.join(fresh, 'Contents', 'MacOS', 'Pennystead'))) throw new Error('The download does not contain Pennystead.app. Nothing was changed.');
    const next = app + '.new', prev = app + '.previous';
    fs.rmSync(next, { recursive: true, force: true }); fs.rmSync(prev, { recursive: true, force: true });
    execFileSync('ditto', [fresh, next]); // copy (not rename): the data folder may be on another volume
    fs.renameSync(app, prev); fs.renameSync(next, app);
    fs.rmSync(prev, { recursive: true, force: true }); // the running program keeps working from the deleted files
    run(path.join(app, 'Contents', 'MacOS', 'Pennystead'), relaunchArgs());
  } else {
    execFileSync('tar', ['-xzf', file, '-C', work]);
    const fresh = path.join(work, 'Pennystead', 'pennystead');
    if (!fs.existsSync(fresh)) throw new Error('The download does not contain the pennystead program. Nothing was changed.');
    try { fs.accessSync(path.dirname(execPath), fs.constants.W_OK); } catch { throw new Error(`Pennystead cannot write to ${path.dirname(execPath)}. Download the update from the Releases page instead.`); }
    const next = execPath + '.new';
    fs.copyFileSync(fresh, next); fs.chmodSync(next, 0o755);
    fs.renameSync(next, execPath); // atomic: the running program keeps its old file
    run(execPath, relaunchArgs());
  }
  fs.rmSync(work, { recursive: true, force: true });
}

/** Download, verify, install, restart. Resolves once the new version has been started; the caller then exits. */
function install() {
  return (busy ??= (async () => {
    const why = cannotInstall();
    if (why) throw new Error(why);
    const st = await check();
    if (!st.available) throw new Error(st.error || 'You already have the newest version.');
    apply(await fetchVerified(st));
    return { from: VERSION, to: st.latest };
  })().finally(() => { busy = null; }));
}

/** Clears what an earlier update left behind (run at start). */
function cleanup() { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* not important */ } }

module.exports = { check, status, summary, install, apply, fetchVerified, compare, platformAsset, cannotInstall, auto, setAuto, cleanup, REPO };
