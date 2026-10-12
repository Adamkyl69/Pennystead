// Optional password protection (needed whenever Pennystead is reachable by anything other than this computer).
// Passwords are stored as scrypt hashes; sessions are random tokens in an HttpOnly cookie held in memory.
const fs = require('fs');
const crypto = require('crypto');
const { paths } = require('./config');

const SESSION_MS = 12 * 36e5, COOKIE = 'pennystead_session';
const sessions = new Map();       // token -> expiry
const attempts = new Map();       // ip -> { n, until }
const scrypt = (pw, salt) => crypto.scryptSync(pw, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });

let envHash = null;               // PENNYSTEAD_PASSWORD: kept as a hash in memory, never written to disk
function stored() {
  if (process.env.PENNYSTEAD_PASSWORD) {
    if (!envHash) { const salt = crypto.randomBytes(16); envHash = { salt: salt.toString('hex'), hash: scrypt(process.env.PENNYSTEAD_PASSWORD, salt).toString('hex') }; }
    return envHash;
  }
  try { return JSON.parse(fs.readFileSync(paths.auth, 'utf8')); } catch { return null; }
}
const required = () => !!stored();
const source = () => (process.env.PENNYSTEAD_PASSWORD ? 'environment' : stored() ? 'saved' : null);

function verify(pw) {
  const s = stored();
  if (!s) return true;
  const a = scrypt(String(pw ?? ''), Buffer.from(s.salt, 'hex')), b = Buffer.from(s.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function setPassword(pw) {
  if (pw === null) { fs.rmSync(paths.auth, { force: true }); sessions.clear(); return; }
  if (String(pw).length < 8) throw new Error('Use at least 8 characters.');
  const salt = crypto.randomBytes(16);
  fs.writeFileSync(paths.auth, JSON.stringify({ salt: salt.toString('hex'), hash: scrypt(String(pw), salt).toString('hex'), createdAt: new Date().toISOString() }), { mode: 0o600 });
  sessions.clear();
}

function newSession() {
  const t = crypto.randomBytes(32).toString('base64url');
  sessions.set(t, Date.now() + SESSION_MS);
  for (const [k, v] of sessions) if (v < Date.now()) sessions.delete(k);
  return t;
}
const cookieOf = (req) => (String(req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === COOKIE) || [])[1];
function authenticated(req) {
  if (!required()) return true;
  const t = cookieOf(req), exp = t && sessions.get(t);
  if (!exp || exp < Date.now()) { if (t) sessions.delete(t); return false; }
  return true;
}
const setCookie = (token, maxAge = SESSION_MS / 1000) => `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(maxAge)}${process.env.PENNYSTEAD_SECURE_COOKIE === '1' ? '; Secure' : ''}`;
const clearCookie = () => setCookie('', 0);

/** 5 wrong passwords lock that address out for 15 minutes. Returns seconds to wait, or 0. */
function locked(ip) { const a = attempts.get(ip); return a && a.until > Date.now() ? Math.ceil((a.until - Date.now()) / 1000) : 0; }
function failed(ip) { const a = attempts.get(ip) || { n: 0, until: 0 }; a.n++; if (a.n >= 5) { a.until = Date.now() + 15 * 60e3; a.n = 0; } attempts.set(ip, a); }
const succeeded = (ip) => attempts.delete(ip);
function logout(req) { sessions.delete(cookieOf(req)); }

module.exports = { required, source, verify, setPassword, newSession, authenticated, setCookie, clearCookie, locked, failed, succeeded, logout };
