// Bank connections (Enable Banking sessions). session.json holds one connection (written by older versions)
// or { sessions: [...] }, so you can connect several banks and keep each one's consent separately.
const fs = require('fs');
const { paths, writeAtomic } = require('./config');

function list() {
  if (!fs.existsSync(paths.session)) return [];
  let o;
  try { o = JSON.parse(fs.readFileSync(paths.session, 'utf8')); } catch { return []; }
  return (Array.isArray(o?.sessions) ? o.sessions : [o]).filter((s) => s && Array.isArray(s.accounts));
}
function save(sessions) {
  if (!sessions.length) return fs.rmSync(paths.session, { force: true });
  writeAtomic(paths.session, JSON.stringify({ sessions }, null, 2), { mode: 0o600 });
}
const sameBank = (a, b) => !!(a.aspsp && b.aspsp && a.aspsp.name === b.aspsp.name && a.aspsp.country === b.aspsp.country);
/** A connection's id: Enable Banking's session id, or (for an old file without one) the bank's name. */
const idOf = (s) => s.session_id || (s.aspsp ? `${s.aspsp.country}-${s.aspsp.name}` : 'bank');

/** Adds a new connection. Connecting the same bank again (renewing consent) replaces its old connection. */
function add(session) {
  save([...list().filter((s) => !sameBank(s, session) && idOf(s) !== idOf(session)), session]);
}
function remove(id) {
  const all = list(), left = all.filter((s) => idOf(s) !== id);
  if (left.length === all.length) throw Object.assign(new Error('Unknown bank connection.'), { status: 404 });
  save(left);
}
const expired = (s, now = new Date().toISOString()) => !!s.access?.valid_until && s.access.valid_until < now;

/** For the UI: one row per connected bank. */
const summary = () => list().map((s) => ({ id: idOf(s), bank: s.aspsp?.name || 'Bank', country: s.aspsp?.country || null, validUntil: s.access?.valid_until || null, expired: expired(s), accounts: s.accounts.length }));
/** Which connection each bank account uid came through. */
const bankOf = () => Object.fromEntries(list().flatMap((s) => s.accounts.map((a) => [a.uid, idOf(s)])));

module.exports = { list, add, remove, idOf, expired, summary, bankOf };
