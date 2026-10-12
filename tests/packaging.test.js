// Packaging: the bundler, and the folder layout of each operating system's download (the binaries themselves are smoke-tested in CI per OS).
const { dir: tmp } = require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { bundle } = require('../scripts/bundle');
const { layout } = require('../scripts/package');
const version = require('../package.json').version;
const ROOT = path.join(__dirname, '..');

const fakeBin = path.join(tmp, 'fakebin'); fs.writeFileSync(fakeBin, 'binary');
const exists = (...p) => fs.existsSync(path.join(...p));

test('the bundle is one self-contained script that needs only Node built-ins', () => {
  const src = bundle(undefined, { version });
  assert.ok(src.includes(`var __PENNYSTEAD_VERSION__ = ${JSON.stringify(version)}`));
  const required = [...src.matchAll(/__nodeRequire\(n\)|require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]).filter(Boolean).filter((n) => !n.startsWith('.'));
  const builtins = new Set([...require('node:module').builtinModules.flatMap((m) => [m, 'node:' + m]), 'node:sea']); // node:sea only exists with its prefix
  for (const n of new Set(required)) assert.ok(builtins.has(n), `${n} is not a Node built-in; the packaged app could not load it`);
  assert.doesNotThrow(() => new vm.Script(src), 'syntax');
  assert.ok(!src.includes('node_modules'), 'no third-party code is bundled');
});
test('the bundler refuses dynamic requires instead of producing a build that breaks at runtime', () => {
  for (const bad of ["const n = 'x'; require('./' + n);", "require(name);", "require(`./${x}`);", "require( './a' + b )"]) {
    const f = path.join(tmp, 'dyn.js'); fs.writeFileSync(f, bad);
    assert.throws(() => bundle(f), /Dynamic require/, bad);
  }
  const ok = path.join(tmp, 'ok.js'); fs.writeFileSync(ok, "const a = require('node:fs'); const b = require( \"path\" ); x.require('y'); // plain static requires and method calls are fine");
  assert.doesNotThrow(() => bundle(ok));
});
test('every file the UI references is something the build embeds', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8') + fs.readFileSync(path.join(ROOT, 'public', 'login.html'), 'utf8');
  for (const m of html.matchAll(/(?:src|href)="\/([\w.-]+)"/g)) assert.ok(exists(ROOT, 'public', m[1]), `${m[1]} is referenced but missing from public/`);
});
test('Windows layout: Pennystead.exe + README', () => {
  const l = layout('win32', 'x64', path.join(tmp, 'w'), fakeBin);
  assert.equal(l.name, `Pennystead-${version}-windows-x64.zip`); assert.ok(exists(l.dir, 'Pennystead.exe')); assert.ok(exists(l.dir, 'README.txt'));
});
test('macOS layout: a valid .app bundle (executable, icon, Info.plist that matches the executable name)', () => {
  const l = layout('darwin', 'arm64', path.join(tmp, 'm'), fakeBin);
  assert.equal(l.name, `Pennystead-${version}-macos-arm64.zip`);
  const app = path.join(l.dir, 'Pennystead.app', 'Contents'); assert.ok(exists(app, 'MacOS', 'Pennystead')); assert.ok(exists(app, 'Resources', 'Pennystead.icns'));
  assert.ok(fs.statSync(path.join(app, 'MacOS', 'Pennystead')).mode & 0o111, 'executable bit');
  const plist = fs.readFileSync(path.join(app, 'Info.plist'), 'utf8');
  assert.ok(!plist.includes('__VERSION__')); assert.ok(plist.includes(`<string>${version}</string>`)); assert.match(plist, /<key>CFBundleExecutable<\/key><string>Pennystead<\/string>/); assert.match(plist, /<key>CFBundleIconFile<\/key><string>Pennystead<\/string>/);
  assert.equal((plist.match(/<key>/g) || []).length, (plist.match(/<(string|true|false)\b/g) || []).length, 'every key has a value (well-formed plist)');
});
test('Linux layout: binary, installer, desktop entry with a quoted Exec, icon', () => {
  const l = layout('linux', 'x64', path.join(tmp, 'l'), fakeBin);
  assert.equal(l.name, `Pennystead-${version}-linux-x64.tar.gz`); for (const f of ['pennystead', 'install.sh', 'pennystead.desktop', 'icon.png', 'README.txt']) assert.ok(exists(l.dir, f), f);
  assert.ok(fs.statSync(path.join(l.dir, 'install.sh')).mode & 0o111); assert.match(fs.readFileSync(path.join(l.dir, 'pennystead.desktop'), 'utf8'), /^Exec="__EXEC__"$/m);
});
test('icons exist in every format the installers reference', () => {
  for (const f of ['icon.png', 'windows/icon.ico', 'macos/Pennystead.icns']) assert.ok(fs.statSync(path.join(ROOT, 'packaging', f)).size > 1000, f);
  assert.deepEqual([...fs.readFileSync(path.join(ROOT, 'packaging', 'windows', 'icon.ico')).subarray(0, 4)], [0, 0, 1, 0], 'valid .ico header');
  assert.equal(fs.readFileSync(path.join(ROOT, 'packaging', 'macos', 'Pennystead.icns')).subarray(0, 4).toString(), 'icns');
  assert.deepEqual([...fs.readFileSync(path.join(ROOT, 'packaging', 'icon.png')).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});
test('the Windows installer script points at files the build produces and keeps user data on uninstall', () => {
  const iss = fs.readFileSync(path.join(ROOT, 'packaging', 'windows', 'pennystead.iss'), 'utf8');
  assert.match(iss, /PrivilegesRequired=lowest/); assert.match(iss, /Source: "\.\.\\\.\.\\dist\\pennystead\.exe"/); assert.match(iss, /taskkill/);
  assert.ok(!/UninstallDelete/.test(iss), 'must not delete %APPDATA%\\Pennystead');
});
