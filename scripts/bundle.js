// Bundles main.js and every local module it requires into ONE CommonJS script (a packaged executable can only require Node built-ins).
// Deliberately tiny: it understands require('./relative') with string literals, which is all Pennystead uses.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function resolveFile(from, name) {
  const base = path.resolve(path.dirname(from), name);
  for (const c of [base, base + '.js', base + '.json', path.join(base, 'index.js')]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  throw new Error(`Cannot resolve ${name} from ${path.relative(ROOT, from)}`);
}

function bundle(entry = path.join(ROOT, 'main.js'), { version } = {}) {
  const mods = new Map(), order = [];
  const visit = (file) => {
    if (mods.has(file)) return;
    const raw = fs.readFileSync(file, 'utf8');
    let code = file.endsWith('.json') ? `module.exports = ${raw};` : raw.replace(/^#![^\r\n]*\r?\n/, '');
    const deps = {};
    if (!file.endsWith('.json')) {
      // Every require( must be exactly one string literal. Anything else (variables, concatenation) works from source but would break
      // inside the packaged app, so fail the build instead of shipping it.
      const stat = /require\(\s*(['"])([^'"\n]+)\1\s*\)/y;
      for (const m of code.matchAll(/(?<![\w$.])require\(/g)) {
        stat.lastIndex = m.index;
        const ok = stat.exec(code);
        if (!ok) throw new Error(`Dynamic require in ${path.relative(ROOT, file)} near: ${code.slice(m.index, m.index + 50).split('\n')[0]}`);
        if (/^\.{1,2}\//.test(ok[2])) deps[ok[2]] = resolveFile(file, ok[2]);
      }
    }
    mods.set(file, { code, deps }); order.push(file);
    for (const d of Object.values(deps)) visit(d);
  };
  visit(path.resolve(entry));
  const id = (f) => path.relative(ROOT, f).split(path.sep).join('/');
  let out = `'use strict';\n${version ? `var __PENNYSTEAD_VERSION__ = ${JSON.stringify(version)};\n` : ''}const __modules = {}, __cache = {};\nfunction __load(id) {\n  if (__cache[id]) return __cache[id].exports;\n  const module = (__cache[id] = { exports: {} });\n  __modules[id](module, module.exports);\n  return module.exports;\n}\n`;
  for (const f of order) {
    const { code, deps } = mods.get(f);
    const map = JSON.stringify(Object.fromEntries(Object.entries(deps).map(([k, v]) => [k, id(v)])));
    out += `__modules[${JSON.stringify(id(f))}] = function (module, exports) {\n  const __deps = ${map}, __dirname = ${JSON.stringify(path.dirname(f))}, __filename = ${JSON.stringify(f)};\n  const require = (n) => (n in __deps ? __load(__deps[n]) : __nodeRequire(n)); require.main = undefined;\n${code}\n};\n`;
  }
  out = out.replace("const __modules", "const __nodeRequire = require;\nconst __modules");
  return out + `__load(${JSON.stringify(id(path.resolve(entry)))});\n`;
}

module.exports = { bundle };
if (require.main === module) { const out = path.join(ROOT, 'dist', 'pennystead.js'); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, bundle(undefined, { version: require('../package.json').version })); console.log('bundle:', out, (fs.statSync(out).size / 1024).toFixed(0) + ' KB'); }
