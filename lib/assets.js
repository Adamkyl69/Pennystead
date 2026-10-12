// Static UI files: read from public/ in development, from the embedded assets inside the packaged app.
const fs = require('fs');
const path = require('path');
let sea = null;
try { const m = require('node:sea'); if (m.isSea()) sea = m; } catch { /* older Node */ }

const PUBLIC = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

/** Returns { body, type } or null. `name` is a path relative to public/, e.g. "index.html". */
function get(name) {
  name = name.replace(/^\/+/, '');
  if (!/^[\w./-]+$/.test(name) || name.includes('..')) return null;
  const type = TYPES[path.extname(name)] || 'application/octet-stream';
  if (sea) { try { return { body: Buffer.from(sea.getRawAsset ? sea.getRawAsset('public/' + name) : sea.getAsset('public/' + name)), type }; } catch { return null; } }
  const f = path.resolve(PUBLIC, name);
  if (!f.startsWith(PUBLIC + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return null; // separator matters: "/public2" must not pass
  return { body: fs.readFileSync(f), type };
}
module.exports = { get, PUBLIC };
