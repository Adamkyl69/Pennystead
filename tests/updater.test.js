const { dir } = require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// A fake GitHub: /latest describes release 99.0.0 with a download for every platform plus the checksum lists.
const V = '99.0.0', sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const work = fs.mkdtempSync(path.join(dir, 'upd-'));
fs.mkdirSync(path.join(work, 'Pennystead'));
fs.writeFileSync(path.join(work, 'Pennystead', 'pennystead'), '#!/bin/sh\necho new version\n');
execFileSync('tar', ['-czf', path.join(work, 'linux.tar.gz'), '-C', work, 'Pennystead']);
const FILES = {
  [`Pennystead-${V}-windows-x64-setup.exe`]: Buffer.from('setup program'),
  [`Pennystead-${V}-macos-arm64.zip`]: Buffer.from('mac arm'), [`Pennystead-${V}-macos-x64.zip`]: Buffer.from('mac intel'),
  [`Pennystead-${V}-linux-x64.tar.gz`]: fs.readFileSync(path.join(work, 'linux.tar.gz')),
};
const sums = (plat) => Object.entries(FILES).filter(([n]) => n.includes(plat)).map(([n, b]) => `${sha(b)}  ${n}`).join('\n') + '\n';
for (const p of ['windows-x64', 'macos-arm64', 'macos-x64', 'linux-x64']) FILES[`SHA256SUMS-${p}.txt`] = Buffer.from(sums(p));
let mode = 'ok', base;
const srv = http.createServer((req, res) => {
  if (req.url === '/latest') {
    if (mode === 'none') { res.writeHead(404); return res.end('{}'); }
    if (mode === 'limited') { res.writeHead(403); return res.end('{}'); }
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ tag_name: 'v' + V, body: '- Faster sync\n- <b>not html</b>', published_at: '2026-10-16T10:00:00Z', html_url: 'https://example.invalid/r', assets: Object.entries(FILES).map(([n, b]) => ({ name: n, size: b.length, browser_download_url: `${base}/dl/${n}` })) }));
  }
  const name = decodeURIComponent(req.url.replace('/dl/', ''));
  if (!FILES[name]) { res.writeHead(404); return res.end(); }
  res.end(mode === 'tampered' && !name.startsWith('SHA256') ? Buffer.from('something else') : FILES[name]);
});

let U;
test.before(async () => {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
  process.env.PENNYSTEAD_UPDATE_API = base + '/latest';
  process.env.PENNYSTEAD_UPDATE_TEST = '1';
  U = require('../lib/updater');
});
test.after(() => srv.close());

test('version comparison and the download chosen for each computer', () => {
  assert.equal(U.compare('1.10.0', '1.9.9'), 1); assert.equal(U.compare('v1.2.0', '1.2.0'), 0); assert.equal(U.compare('1.0.0', '1.0.1'), -1);
  assert.equal(U.platformAsset('2.0.0', 'win32').file, 'Pennystead-2.0.0-windows-x64-setup.exe');
  assert.equal(U.platformAsset('2.0.0', 'darwin', 'arm64').sums, 'SHA256SUMS-macos-arm64.txt');
  assert.equal(U.platformAsset('2.0.0', 'linux', 'x64').file, 'Pennystead-2.0.0-linux-x64.tar.gz');
  assert.equal(U.platformAsset('2.0.0', 'linux', 'arm64'), null);
  assert.match(U.cannotInstall('darwin', '/Volumes/Pennystead/Pennystead.app/Contents/MacOS/Pennystead'), /Applications/);
});

test('finds a newer release, its notes and the right download; no release or a rate limit is reported calmly', async () => {
  mode = 'ok';
  const s = await U.check();
  assert.equal(s.available, true); assert.equal(s.latest, V); assert.match(s.notes, /Faster sync/);
  assert.equal(s.file, U.platformAsset(V).file);
  assert.deepEqual(U.summary(), { available: true, latest: V });
  mode = 'none'; const n = await U.check(); assert.equal(n.available, false); assert.equal(n.error, null);
  mode = 'limited'; const l = await U.check(); assert.equal(l.available, false); assert.match(l.error, /try again in an hour/);
  assert.equal(U.summary(), null);
});

test('a download that does not match its published checksum is refused and deleted', async () => {
  mode = 'ok'; const s = await U.check();
  const f = await U.fetchVerified(s); assert.ok(fs.existsSync(f));
  mode = 'tampered';
  await assert.rejects(U.fetchVerified(s), /does not match its published checksum/);
  assert.ok(!fs.existsSync(f));
  mode = 'ok';
});

test('Windows: the installer runs silently over the current folder and restarts the app', () => {
  const calls = [];
  U.apply('C:\\x\\setup.exe', { platform: 'win32', execPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\Pennystead\\pennystead.exe', run: (c, a) => calls.push([c, a]) });
  assert.equal(calls[0][0], 'C:\\x\\setup.exe');
  for (const a of ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/RELAUNCH=1']) assert.ok(calls[0][1].includes(a));
  assert.ok(calls[0][1].some((a) => a.startsWith('/DIR=') && a.includes('Pennystead')));
});

test('Linux: the program file is replaced in place and the new version started with --updated', { skip: process.platform === 'win32' && 'tar/permissions differ on Windows' }, async () => {
  mode = 'ok';
  const s = await U.check();
  const file = await U.fetchVerified({ ...s, ...U.platformAsset(V, 'linux', 'x64'), url: `${base}/dl/${U.platformAsset(V, 'linux', 'x64').file}`, sumsUrl: `${base}/dl/SHA256SUMS-linux-x64.txt` });
  const bin = path.join(work, 'installed', 'pennystead');
  fs.mkdirSync(path.dirname(bin)); fs.writeFileSync(bin, 'old version', { mode: 0o755 });
  const calls = [];
  U.apply(file, { platform: 'linux', execPath: bin, run: (c, a) => calls.push([c, a]) });
  assert.match(fs.readFileSync(bin, 'utf8'), /new version/);
  assert.equal(fs.statSync(bin).mode & 0o777, 0o755);
  assert.deepEqual(calls[0][0], bin); assert.ok(calls[0][1].includes('--updated'));
  assert.ok(!fs.existsSync(bin + '.new'));
});
