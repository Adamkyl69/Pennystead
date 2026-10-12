// Minimal Google Drive client for backups (OAuth 2.0 installed-app flow with PKCE, scope drive.file).
// drive.file only lets this app see files it created itself, never the rest of your Drive.
const fs = require('fs');
const crypto = require('crypto');
const { paths, writeAtomic } = require('./config');
const settings = require('./settings');

// Endpoints can be overridden (tests use a local mock server).
const URLS = {
  auth: process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
  token: process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
  revoke: process.env.GOOGLE_REVOKE_URL || 'https://oauth2.googleapis.com/revoke',
  api: process.env.GOOGLE_API_URL || 'https://www.googleapis.com/drive/v3',
  upload: process.env.GOOGLE_UPLOAD_URL || 'https://www.googleapis.com/upload/drive/v3',
};
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_NAME = 'Pennystead Backups';

const configured = () => !!settings.google();
const readToken = () => (fs.existsSync(paths.googleToken) ? JSON.parse(fs.readFileSync(paths.googleToken, 'utf8')) : null);
const writeToken = (t) => writeAtomic(paths.googleToken, JSON.stringify(t, null, 2), { mode: 0o600 });
const connected = () => !!readToken()?.refresh_token;

let pending = null; // one in-flight authorization: { state, verifier, redirect }
const b64u = (b) => b.toString('base64url');

function beginAuth(redirect) {
  if (!configured()) throw new Error('Add your Google client ID and secret under Settings → Connections first.');
  const verifier = b64u(crypto.randomBytes(32)), state = b64u(crypto.randomBytes(16));
  pending = { state, verifier, redirect };
  const q = new URLSearchParams({
    client_id: settings.google().clientId, redirect_uri: redirect, response_type: 'code', scope: SCOPE, state,
    code_challenge: b64u(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
    access_type: 'offline', prompt: 'consent', // prompt=consent makes Google return a refresh token every time
  });
  return `${URLS.auth}?${q}`;
}

async function tokenRequest(params) {
  const r = await fetch(URLS.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: settings.google().clientId, client_secret: settings.google().clientSecret, ...params }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error_description || j.error || `Google token error ${r.status}`), { code: j.error });
  return j;
}

async function finishAuth(code, state) {
  if (!pending || state !== pending.state) throw new Error('Authorization state mismatch. Start again from the Backups page.');
  const { verifier, redirect } = pending; pending = null;
  const t = await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirect });
  if (!t.refresh_token) throw new Error('Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and connect again.');
  writeToken({ refresh_token: t.refresh_token, access_token: t.access_token, expires_at: Date.now() + (t.expires_in || 3600) * 1000, folderId: null });
}

async function accessToken() {
  const t = readToken();
  if (!t?.refresh_token) throw new Error('Google Drive is not connected.');
  if (t.access_token && t.expires_at > Date.now() + 60000) return t.access_token;
  try {
    const n = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
    writeToken({ ...t, access_token: n.access_token, expires_at: Date.now() + (n.expires_in || 3600) * 1000 });
    return n.access_token;
  } catch (e) {
    if (e.code === 'invalid_grant') { fs.rmSync(paths.googleToken, { force: true }); throw new Error('Google access expired or was revoked. Reconnect Google Drive. (If your Google Cloud app is in "Testing" mode, tokens expire after 7 days: publish it to "In production".)'); }
    throw e;
  }
}

async function call(url, opts = {}, retried = false) {
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${await accessToken()}` } });
  if (r.status === 401 && !retried) { writeToken({ ...readToken(), access_token: null, expires_at: 0 }); return call(url, opts, true); }
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw Object.assign(new Error(j.error?.message || `Google Drive error ${r.status}`), { status: r.status }); }
  return r;
}

async function folderId() {
  const t = readToken();
  if (!t?.refresh_token) throw new Error('Google Drive is not connected. Reconnect it on the Backups page.');
  if (t.folderId) {
    try { const f = await (await call(`${URLS.api}/files/${t.folderId}?fields=id,trashed`)).json(); if (!f.trashed) return t.folderId; } catch (e) { if (e.status !== 404) throw e; }
  }
  const q = `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const found = (await (await call(`${URLS.api}/files?${new URLSearchParams({ q, fields: 'files(id)', pageSize: '1' })}`)).json()).files?.[0];
  const id = found?.id || (await (await call(`${URLS.api}/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }) })).json()).id;
  writeToken({ ...readToken(), folderId: id });
  return id;
}

/** Upload one file into the Pennystead Backups folder. Returns { id, name, size }. */
async function upload(name, buf) {
  const parent = await folderId(), boundary = 'pennystead' + crypto.randomBytes(8).toString('hex');
  const meta = JSON.stringify({ name, parents: [parent], description: 'Pennystead backup' });
  const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`), buf, Buffer.from(`\r\n--${boundary}--`)]);
  const r = await call(`${URLS.upload}/files?uploadType=multipart&fields=id,name,size`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
  const f = await r.json();
  return { id: f.id, name: f.name, size: +f.size };
}

async function list() {
  const parent = await folderId();
  const q = `'${parent}' in parents and trashed=false`;
  const r = await (await call(`${URLS.api}/files?${new URLSearchParams({ q, orderBy: 'createdTime desc', fields: 'files(id,name,size,createdTime)', pageSize: '200' })}`)).json();
  return (r.files || []).map((f) => ({ id: f.id, name: f.name, size: +f.size || 0, createdAt: f.createdTime }));
}
const download = async (id) => Buffer.from(await (await call(`${URLS.api}/files/${encodeURIComponent(id)}?alt=media`)).arrayBuffer());
const remove = (id) => call(`${URLS.api}/files/${encodeURIComponent(id)}`, { method: 'DELETE' });

async function account() {
  try { const a = await (await call(`${URLS.api}/about?fields=user(emailAddress)`)).json(); return a.user?.emailAddress || null; } catch { return null; }
}
async function disconnect() {
  const t = readToken();
  if (t?.refresh_token) await fetch(URLS.revoke, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: t.refresh_token }) }).catch(() => {});
  fs.rmSync(paths.googleToken, { force: true });
}

module.exports = { configured, connected, beginAuth, finishAuth, upload, list, download, remove, account, disconnect };
