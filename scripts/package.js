#!/usr/bin/env node
// Turns dist/pennystead[.exe] (from scripts/build.js) into the file a person downloads:
//   Windows : Pennystead-<v>-windows-x64.zip   (CI also builds the Setup.exe installer from packaging/windows/pennystead.iss)
//   macOS   : Pennystead-<v>-macos-<arch>.zip  containing Pennystead.app (CI also builds a .dmg)
//   Linux   : Pennystead-<v>-linux-x64.tar.gz  containing the binary, an install script and a desktop entry
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..'), DIST = path.join(ROOT, 'dist'), OUT = path.join(ROOT, 'release'), PK = path.join(ROOT, 'packaging');
const version = require('../package.json').version;
const read = (f) => fs.readFileSync(path.join(PK, f), 'utf8');
const copy = (from, to, mode) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); if (mode) fs.chmodSync(to, mode); };

/** Builds the folder layout for a platform (pure file operations, testable anywhere). Returns { dir, name }. */
function layout(platform, arch, work, binary) {
  fs.rmSync(work, { recursive: true, force: true });
  if (platform === 'win32') {
    const dir = path.join(work, 'Pennystead');
    copy(binary, path.join(dir, 'Pennystead.exe'), 0o755); copy(path.join(PK, 'README.txt'), path.join(dir, 'README.txt'));
    return { dir, name: `Pennystead-${version}-windows-${arch}.zip` };
  }
  if (platform === 'darwin') {
    const app = path.join(work, 'Pennystead.app', 'Contents');
    copy(binary, path.join(app, 'MacOS', 'Pennystead'), 0o755); copy(path.join(PK, 'macos', 'Pennystead.icns'), path.join(app, 'Resources', 'Pennystead.icns'));
    fs.writeFileSync(path.join(app, 'Info.plist'), read('macos/Info.plist').replace(/__VERSION__/g, version));
    copy(path.join(PK, 'README.txt'), path.join(work, 'README.txt'));
    return { dir: work, name: `Pennystead-${version}-macos-${arch}.zip` };
  }
  const dir = path.join(work, 'Pennystead');
  copy(binary, path.join(dir, 'pennystead'), 0o755); copy(path.join(PK, 'linux', 'install.sh'), path.join(dir, 'install.sh'), 0o755);
  copy(path.join(PK, 'linux', 'pennystead.desktop'), path.join(dir, 'pennystead.desktop')); copy(path.join(PK, 'icon.png'), path.join(dir, 'icon.png')); copy(path.join(PK, 'README.txt'), path.join(dir, 'README.txt'));
  return { dir, name: `Pennystead-${version}-linux-${arch}.tar.gz` };
}

function archive(platform, { dir, name }) {
  fs.mkdirSync(OUT, { recursive: true });
  const out = path.join(OUT, name), parent = path.dirname(dir), item = path.basename(dir);
  if (platform === 'darwin') { execFileSync('codesign', ['--force', '--deep', '--sign', '-', path.join(dir, 'Pennystead.app')], { stdio: 'inherit' }); execFileSync('ditto', ['-c', '-k', '--keepParent', path.join(dir, 'Pennystead.app'), out], { stdio: 'inherit' }); }
  else if (platform === 'win32') execFileSync('tar', ['-a', '-c', '-f', out, '-C', parent, item], { stdio: 'inherit' }); // bsdtar ships with Windows 10+
  else execFileSync('tar', ['-czf', out, '-C', parent, item], { stdio: 'inherit' });
  return out;
}

module.exports = { layout, archive };
if (require.main === module) {
  const platform = process.platform, arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const binary = path.join(DIST, platform === 'win32' ? 'pennystead.exe' : 'pennystead');
  if (!fs.existsSync(binary)) throw new Error('Run "node scripts/build.js" first.');
  const out = archive(platform, layout(platform, arch, path.join(OUT, '_work'), binary));
  fs.rmSync(path.join(OUT, '_work'), { recursive: true, force: true });
  console.log(`Packaged ${out} (${(fs.statSync(out).size / 1048576).toFixed(0)} MB)`);
}
