// Google Drive client against a local stand-in for Google's OAuth and Drive endpoints.
const { dir } = require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');

const S = { challenge: null, access: 'at-1', files: {}, n: 0, folder: null, revoked: false, tokenFail: null, expire401Once: false };
const body = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
const send = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(typeof o === 'string' ? o : JSON.stringify(o)); };
let mock, base, gd, backup, core, demo;

test.before(async () => {
  mock = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'), raw = await body(req);
    if (u.pathname === '/token') {
      const p = new URLSearchParams(raw.toString());
      if (p.get('client_id') !== 'cid.apps.googleusercontent.com' || p.get('client_secret') !== 'csecret123') return send(res, 401, { error: 'invalid_client' });
      if (S.tokenFail) return send(res, 400, { error: S.tokenFail });
      if (p.get('grant_type') === 'authorization_code') { if (crypto.createHash('sha256').update(p.get('code_verifier') || '').digest('base64url') !== S.challenge) return send(res, 400, { error: 'invalid_grant' }); return send(res, 200, { access_token: S.access, refresh_token: 'rt-1', expires_in: 3600 }); }
      S.access = 'at-' + (++S.n + 1); return send(res, 200, { access_token: S.access, expires_in: 3600 });
    }
    if (u.pathname === '/revoke') { S.revoked = true; return send(res, 200, {}); }
    if (req.headers.authorization !== `Bearer ${S.access}` || S.expire401Once) { S.expire401Once = false; S.access = 'at-' + (++S.n + 1000); return send(res, 401, { error: { message: 'Invalid Credentials' } }); }
    if (u.pathname === '/drive/v3/about') return send(res, 200, { user: { emailAddress: 'me@example.com' } });
    if (u.pathname === '/upload/drive/v3/files') {
      const b = req.headers['content-type'].match(/boundary=(.+)$/)[1], parts = raw.toString('binary').split(`--${b}`).filter((x) => x.trim() && x.trim() !== '--');
      const meta = JSON.parse(parts[0].split('\r\n\r\n')[1].replace(/\r\n$/, '')), data = Buffer.from(parts[1].slice(parts[1].indexOf('\r\n\r\n') + 4).replace(/\r\n$/, ''), 'binary'), id = 'f' + (++S.n);
      S.files[id] = { id, name: meta.name, data, parent: meta.parents?.[0], t: new Date(Date.now() + S.n * 1000).toISOString() }; return send(res, 200, { id, name: meta.name, size: String(data.length) });
    }
    const m = u.pathname.match(/^\/drive\/v3\/files(?:\/([^/]+))?$/);
    if (m && !m[1] && req.method === 'POST') { const id = 'folder' + (++S.n); S.folder = id; S.files[id] = { id, folder: true, data: Buffer.alloc(0) }; return send(res, 200, { id }); }
    if (m && !m[1]) { const q = u.searchParams.get('q'); if (q.includes('vnd.google-apps.folder')) return send(res, 200, { files: Object.values(S.files).filter((f) => f.folder).slice(0, 1).map((f) => ({ id: f.id })) }); const par = q.match(/'([^']+)' in parents/)[1]; return send(res, 200, { files: Object.values(S.files).filter((f) => f.parent === par).sort((a, b) => b.t.localeCompare(a.t)).map((f) => ({ id: f.id, name: f.name, size: String(f.data.length), createdTime: f.t })) }); }
    if (m && req.method === 'GET') { const f = S.files[m[1]]; if (!f) return send(res, 404, { error: { message: 'nf' } }); if (u.searchParams.get('alt') === 'media') { res.writeHead(200); return res.end(f.data); } return send(res, 200, { id: f.id, trashed: false }); }
    if (m && req.method === 'DELETE') { delete S.files[m[1]]; res.writeHead(204); return res.end(); }
    send(res, 404, {});
  });
  await new Promise((ok) => mock.listen(0, '127.0.0.1', ok)); base = `http://127.0.0.1:${mock.address().port}`;
  Object.assign(process.env, { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'csecret123', GOOGLE_AUTH_URL: base + '/auth', GOOGLE_TOKEN_URL: base + '/token', GOOGLE_REVOKE_URL: base + '/revoke', GOOGLE_API_URL: base + '/drive/v3', GOOGLE_UPLOAD_URL: base + '/upload/drive/v3' });
  gd = require('../lib/gdrive'); backup = require('../lib/backup'); core = require('../lib/core'); demo = require('../lib/demo'); demo.generate();
});
test.after(() => mock.close());

const connect = async () => { const q = new URL(gd.beginAuth('http://localhost:3456/oauth/google/callback')).searchParams; S.challenge = q.get('code_challenge'); await gd.finishAuth('good-code', q.get('state')); return q; };

test('OAuth: PKCE S256, least-privilege scope, state check, token stored 0600', async () => {
  const q = new URL(gd.beginAuth('http://localhost:3456/oauth/google/callback')).searchParams;
  assert.equal(q.get('scope'), 'https://www.googleapis.com/auth/drive.file'); assert.equal(q.get('code_challenge_method'), 'S256'); assert.equal(q.get('access_type'), 'offline');
  await assert.rejects(() => gd.finishAuth('good-code', 'WRONG-STATE'), /state mismatch/);
  await connect(); assert.ok(gd.connected()); assert.equal(await gd.account(), 'me@example.com');
  if (process.platform !== 'win32') assert.equal(fs.statSync(require('../lib/config').paths.googleToken).mode & 0o777, 0o600);
});
test('upload goes into a "Pennystead Backups" folder, encrypted, verified; retention; refresh after 401; restore from Drive', async () => {
  backup.updateConfig({ drive: { enabled: true, keep: 2 } });
  const unenc = (await backup.runBackup({ force: true })).find((x) => x.dest === 'drive'); assert.match(unenc.error, /passphrase/, 'refuses to upload unencrypted');
  backup.setPassphrase('correct horse battery');
  const ok = (await backup.runBackup({ force: true })).find((x) => x.dest === 'drive'); assert.ok(ok.file && ok.encrypted);
  const stored = Object.values(S.files).find((f) => f.parent); assert.equal(stored.parent, S.folder); assert.equal(stored.data.subarray(0, 6).toString(), 'PSTBK1'); assert.ok(!stored.data.includes(Buffer.from('NETFLIX')));
  for (let i = 0; i < 3; i++) await backup.runBackup({ force: true });
  assert.equal((await gd.list()).length, 2, 'keeps only the newest 2');
  S.expire401Once = true; assert.equal((await gd.list()).length, 2, 'a 401 triggers a refresh and a retry');
  const m = JSON.parse(fs.readFileSync(require('../lib/config').paths.manualAssets)); m.assets = []; fs.writeFileSync(require('../lib/config').paths.manualAssets, JSON.stringify(m));
  const r = await backup.restoreDrive((await gd.list())[0].id); assert.ok(r.restored >= 8); assert.ok(JSON.parse(fs.readFileSync(require('../lib/config').paths.manualAssets)).assets.length > 0);
  backup.setPassphrase(null);
});
test('a revoked or expired grant is reported clearly and forgotten; local backups still run', async () => {
  const { paths } = require('../lib/config'); const t = JSON.parse(fs.readFileSync(paths.googleToken)); t.expires_at = 0; fs.writeFileSync(paths.googleToken, JSON.stringify(t));
  S.tokenFail = 'invalid_grant'; await assert.rejects(() => gd.list(), /expired or was revoked/); assert.ok(!gd.connected()); S.tokenFail = null;
  backup.setPassphrase('correct horse battery');
  const r = await backup.runBackup({ force: true }); assert.ok(r.find((x) => x.dest === 'local').file); assert.match(r.find((x) => x.dest === 'drive').error, /not connected/i);
  backup.setPassphrase(null);
});
test('disconnect revokes the token at Google and deletes it locally', async () => {
  await connect(); S.revoked = false; await gd.disconnect(); assert.equal(S.revoked, true); assert.ok(!gd.connected());
});
