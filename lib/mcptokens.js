// Bearer tokens for the HTTP MCP endpoint (/mcp). Only a SHA-256 hash is stored: a token is shown once, when it is made.
const fs = require('fs');
const crypto = require('crypto');
const { paths, writeAtomic } = require('./config');

const read = () => { try { const j = JSON.parse(fs.readFileSync(paths.mcpTokens, 'utf8')); return Array.isArray(j.tokens) ? j.tokens : []; } catch { return []; } };
const write = (tokens) => writeAtomic(paths.mcpTokens, JSON.stringify({ tokens }, null, 2), { mode: 0o600 });
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');

function create(name) {
  name = String(name || '').replace(/[\r\n]/g, ' ').trim().slice(0, 60);
  if (!name) throw new Error('Give the token a name, for example the app that will use it.');
  const tokens = read();
  if (tokens.length >= 20) throw new Error('That is a lot of tokens. Revoke the ones you no longer use first.');
  const token = 'pnst_' + crypto.randomBytes(32).toString('base64url');
  const entry = { id: crypto.randomBytes(5).toString('hex'), name, hash: hash(token), createdAt: new Date().toISOString(), lastUsed: null };
  write([...tokens, entry]);
  return { token, id: entry.id, name };
}
const list = () => read().map(({ hash: _h, ...t }) => t);
function revoke(id) {
  const tokens = read();
  if (!tokens.some((t) => t.id === id)) throw Object.assign(new Error('Unknown token.'), { status: 404 });
  write(tokens.filter((t) => t.id !== id));
}
const any = () => read().length > 0;

/** True when the Authorization header carries a valid token (and notes when it was last used). */
function verify(header) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(header || ''));
  if (!m) return false;
  const h = Buffer.from(hash(m[1]), 'hex'), tokens = read();
  let hit = null;
  for (const t of tokens) { const b = Buffer.from(t.hash, 'hex'); if (b.length === h.length && crypto.timingSafeEqual(b, h)) hit = t; }
  if (!hit) return false;
  // Written at most once an hour per token, so a busy client does not rewrite the file on every request.
  if (!hit.lastUsed || Date.now() - Date.parse(hit.lastUsed) > 36e5) { hit.lastUsed = new Date().toISOString(); write(tokens); }
  return true;
}

module.exports = { create, list, revoke, verify, any };
