// Bank connections (Enable Banking sessions): one per bank, any number of banks. Stored in session.json as
// { sessions: [...] }; a file from an older version holds a single session object and is read the same way.
const fs = require('fs');
const { paths, writeAtomic } = require('./config');

const read = () => { try { return JSON.parse(fs.readFileSync(paths.session, 'utf8')); } catch { return null; } };
const bankKey = (s) => `${s.aspsp?.name || ''}|${s.aspsp?.country || ''}`.toLowerCase();
const idOf = (s) => s.session_id || bankKey(s) || 'bank';

function list() {
  const j = read();
  if (!j) return [];
  return (Array.isArray(j.sessions) ? j.sessions : [j]).filter((s) => s && Array.isArray(s.accounts));
}
function save(sessions) {
  if (!sessions.length) return fs.rmSync(paths.session, { force: true });
  writeAtomic(paths.session, JSON.stringify({ sessions }, null, 2), { mode: 0o600 });
}
/** Adds a connection. Connecting a bank that is already connected replaces that connection (a renewed consent). */
function add(session) {
  const rest = list().filter((s) => bankKey(s) !== bankKey(session) || !bankKey(session).replace('|', ''));
  save([...rest, session]);
  return session;
}
/** Removes one bank (by id), or all of them when no id is given. */
function remove(id) { save(id ? list().filter((s) => idOf(s) !== id) : []); }
const exists = () => list().length > 0;
/** What the UI needs, without anything secret. */
const summary = () => list().map((s) => ({ id: idOf(s), name: s.aspsp?.name || 'Bank', country: s.aspsp?.country || null, validUntil: s.access?.valid_until || null, accounts: s.accounts.length }));

module.exports = { list, add, remove, exists, summary, idOf };
