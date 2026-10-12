#!/usr/bin/env node
// Builds a single-file Pennystead executable for the platform this runs on (Windows, macOS or Linux) using Node's Single Executable Applications:
// the Node runtime + the bundled app + the UI files are packed into one binary that needs no install of Node or anything else.
// Usage: node scripts/build.js            (CI runs it once per operating system)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { bundle } = require('./bundle');

const ROOT = path.join(__dirname, '..'), DIST = path.join(ROOT, 'dist');
const pkg = require('../package.json'), version = pkg.version;
const plat = process.platform, arch = process.arch;
const nodeBin = process.argv.includes('--node') ? path.resolve(process.argv[process.argv.indexOf('--node') + 1]) : process.execPath; // any official Node >= 20.12 binary
const exeName = plat === 'win32' ? 'pennystead.exe' : 'pennystead';
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, shell: plat === 'win32' && /^npx|npm$/.test(cmd), ...opts });

fs.rmSync(DIST, { recursive: true, force: true }); fs.mkdirSync(DIST, { recursive: true });

// 1. one script
fs.writeFileSync(path.join(DIST, 'pennystead.js'), bundle(undefined, { version }));

// 2. SEA blob with the UI embedded as assets
const pub = fs.readdirSync(path.join(ROOT, 'public')).filter((f) => fs.statSync(path.join(ROOT, 'public', f)).isFile());
const assets = Object.fromEntries(pub.map((f) => [`public/${f}`, path.join(ROOT, 'public', f)]));
const cfg = path.join(DIST, 'sea-config.json');
fs.writeFileSync(cfg, JSON.stringify({ main: path.join(DIST, 'pennystead.js'), output: path.join(DIST, 'sea-prep.blob'), disableExperimentalSEAWarning: true, assets }, null, 2));
sh(nodeBin, ['--experimental-sea-config', cfg]);

// 3. copy this machine's Node runtime and inject the blob
const out = path.join(DIST, exeName);
fs.copyFileSync(nodeBin, out); fs.chmodSync(out, 0o755);
// The marker string that postject looks for differs between Node releases, so read it from the binary itself.
const bin = fs.readFileSync(out), at = bin.indexOf('NODE_SEA_FUSE_');
if (at < 0) throw new Error(`${nodeBin} has no single-executable support. Use an official Node.js build from nodejs.org (>= 20.12).`);
const fuse = bin.toString('latin1', at, at + 46); // NODE_SEA_FUSE_ + 32 hex chars
if (plat === 'darwin') sh('codesign', ['--remove-signature', out]);
const inject = ['postject', out, 'NODE_SEA_BLOB', path.join(DIST, 'sea-prep.blob'), '--sentinel-fuse', fuse, ...(plat === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : [])];
sh(path.join(ROOT, 'node_modules', '.bin', plat === 'win32' ? 'postject.cmd' : 'postject'), inject.slice(1), { shell: plat === 'win32' });
if (plat === 'darwin') sh('codesign', ['--sign', '-', out]); // Apple Silicon refuses to run an unsigned (modified) binary: an ad-hoc signature satisfies it

// 4. smoke test what we just built
const v = execFileSync(out, ['--version']).toString().trim();
if (v !== version) throw new Error(`Built binary reports version ${v}, expected ${version}`);

fs.rmSync(path.join(DIST, 'sea-prep.blob'), { force: true });
console.log(`\nBuilt ${out}  (${(fs.statSync(out).size / 1048576).toFixed(0)} MB, version ${v}, ${plat}-${arch})`);
