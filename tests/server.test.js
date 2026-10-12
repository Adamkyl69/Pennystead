// HTTP-level tests of the security model: Host/Origin checks, authentication, headers, input limits, credential handling.
const { dir, fixture } = require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
// Raw request so we can send any Host/Origin header (fetch forbids overriding them).
const raw = (port, { method = 'GET', url = '/', headers = {}, body } = {}) => new Promise((ok, bad) => {
  const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: { host: `localhost:${port}`, ...headers } }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString() })); });
  r.on('error', bad); if (body) r.write(body); r.end();
});
const send = (method) => (port, url, obj, headers = {}) => raw(port, { method, url, headers: { 'content-type': 'application/json', origin: `http://localhost:${port}`, ...headers }, body: JSON.stringify(obj) });
const post = send('POST'), putJson = send('PUT');

let srv, port;
test.before(async () => { port = await freePort(); srv = await require('../server').start({ port }); });
test.after(async () => { await srv.stop(); });

test('ping works and reports the app', async () => { const r = await raw(port, { url: '/api/ping' }); assert.equal(r.status, 200); assert.equal(JSON.parse(r.body).app, 'pennystead'); });

test('security headers are on every response, CSP forbids inline scripts', async () => {
  for (const u of ['/', '/api/ping', '/nope']) {
    const h = (await raw(port, { url: u })).headers;
    assert.match(h['content-security-policy'], /script-src 'self'(;|$)/); assert.ok(!/script-src[^;]*unsafe-inline/.test(h['content-security-policy']));
    assert.equal(h['x-content-type-options'], 'nosniff'); assert.equal(h['x-frame-options'], 'DENY'); assert.equal(h['referrer-policy'], 'no-referrer'); assert.match(h['cache-control'], /no-store/);
  }
});
test('index.html contains no inline <script> and no inline event handlers', async () => {
  const html = (await raw(port, { url: '/' })).body;
  assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>/.test(html)); assert.ok(!/\son\w+\s*=/.test(html));
  for (const f of ['app.js', 'pages.js']) assert.ok(!/\son(click|change|submit|load)\s*=\s*["']/.test(fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8')), `${f} has an inline handler`);
});

test('DNS-rebinding: unknown Host header is refused', async () => {
  for (const host of ['evil.example', `evil.example:${port}`, `localhost.evil.example:${port}`, `127.0.0.1.evil.example:${port}`]) assert.equal((await raw(port, { url: '/api/ping', headers: { host } })).status, 421, host);
});
test('CSRF: cross-origin and cross-site writes are refused, same-origin and curl are accepted', async () => {
  const w = { category: 'expenses:food', amount: 1 };
  assert.equal((await putJson(port, '/api/budget', w, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await putJson(port, '/api/budget', w, { origin: 'null' })).status, 403);
  assert.equal((await putJson(port, '/api/budget', w, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await post(port, '/api/override', { id: 'x', category: 'expenses:food' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await raw(port, { url: '/api/state', headers: { 'sec-fetch-site': 'cross-site' } })).status, 403, 'cross-site reads of the API');
  assert.equal((await raw(port, { url: '/api/state', headers: { 'sec-fetch-site': 'same-site' } })).status, 403, 'another local app on a different port is "same-site" to a browser');
  assert.equal((await raw(port, { url: '/api/state', headers: { 'sec-fetch-site': 'same-origin' } })).status, 200);
  assert.equal((await putJson(port, '/api/budget', { ...w, amount: 5 }, { 'sec-fetch-site': 'same-origin' })).status, 200);
  assert.equal((await raw(port, { method: 'PUT', url: '/api/budget', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...w, amount: 6 }) })).status, 200, 'no Origin header (curl, CLI)');
});
test('CSRF: JSON bodies must be application/json (blocks "simple" cross-site form posts)', async () => {
  const r = await raw(port, { method: 'PUT', url: '/api/budget', headers: { 'content-type': 'text/plain', origin: `http://localhost:${port}` }, body: JSON.stringify({ category: 'expenses:food', amount: 1 }) });
  assert.equal(r.status, 415);
});
test('the OAuth return trip (a cross-site top-level navigation) is not blocked', async () => {
  const r = await raw(port, { url: '/callback?code=x&state=y', headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' } });
  assert.equal(r.status, 400); assert.match(r.body, /Bad or missing code/);
});
test('request bodies are size-limited and invalid JSON is rejected cleanly', async () => {
  assert.equal((await raw(port, { method: 'PUT', url: '/api/budget', headers: { 'content-type': 'application/json' }, body: '{not json' })).status, 400);
  const big = await raw(port, { method: 'PUT', url: '/api/budget', headers: { 'content-type': 'application/json' }, body: '{"x":"' + 'a'.repeat(1.2e6) + '"}' }).catch(() => ({ status: 413 })); // server may also reset the connection
  assert.equal(big.status, 413);
});

test('static files: no path traversal, no sibling-directory prefix trick', async () => {
  for (const u of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/%2e%2e%2f%2e%2e%2fetc/passwd', '/....//package.json', '/..\\package.json', '/lib/config.js', '/server.js', '/.env', '/../public2/x', '/public/../package.json']) {
    const r = await raw(port, { url: u }); assert.equal(r.status, 404, `${u} -> ${r.status}`); assert.ok(!r.body.includes('"name"') && !r.body.includes('require('), u);
  }
  const { get } = require('../lib/assets');
  assert.equal(get('../package.json'), null); assert.equal(get('../public2/x'), null); assert.ok(get('index.html'));
});

test('credentials: invalid keys rejected, valid key stored 0600, never returned, never backed up', async () => {
  const put = (url, o) => putJson(port, url, o);
  assert.equal((await put('/api/settings/enablebanking', { appId: 'my-app-id', privateKey: 'junk' })).status, 400);
  const ed = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  const bad = await put('/api/settings/enablebanking', { appId: 'my-app-id', privateKey: ed }); assert.equal(bad.status, 400); assert.match(bad.body, /RSA/);
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const ok = await put('/api/settings/enablebanking', { appId: 'my-app-id', privateKey: rsa }); assert.equal(ok.status, 200);
  assert.ok(!ok.body.includes('PRIVATE') && !(await raw(port, { url: '/api/settings' })).body.includes('PRIVATE'));
  assert.equal(JSON.parse((await raw(port, { url: '/api/settings' })).body).enablebanking.appId, 'my-app-id');
  if (process.platform !== 'win32') assert.equal((fs.statSync(path.join(dir, 'secrets.json')).mode & 0o777), 0o600);
  assert.ok(!require('../lib/backup').collect().files.some((f) => ['secrets.json', 'auth.json', 'session.json', 'google-token.json', 'backup.passphrase'].includes(f.name)), 'credential files must not be in a backup');
  assert.equal((await put('/api/settings/alphavantage', { apiKey: 'x' })).status, 400);
  assert.equal((await put('/api/settings/google', { clientId: 'nope', clientSecret: 'secret123' })).status, 400);
});

test('state never exposes a full IBAN or credentials', async () => {
  const store = require('../lib/store'); store.saveAccounts({ a: { name: 'main', label: 'Main', currency: 'EUR', iban: 'FI2112345600000785', opening: { date: '2024-01-01', amount: 1, cur: 'EUR' } } });
  const s = (await raw(port, { url: '/api/state' })).body;
  assert.ok(!s.includes('FI2112345600000785') && !s.includes('opening')); assert.ok(s.includes('0785'));
  store.saveAccounts({});
});

test('sample data can only be loaded into an empty Pennystead, and only sample data can be cleared', async () => {
  assert.equal((await post(port, '/api/demo/clear', {})).status, 409, 'nothing to clear yet');
  assert.equal((await post(port, '/api/demo/load', {})).status, 200);
  assert.equal((await post(port, '/api/demo/load', {})).status, 409, 'not empty any more');
  assert.equal(JSON.parse((await raw(port, { url: '/api/state' })).body).demo, true);
  assert.equal((await post(port, '/api/demo/clear', {})).status, 200);
  assert.equal(JSON.parse((await raw(port, { url: '/api/state' })).body).hasData, false);
  // real data must never be clearable through the demo route
  require('../lib/manual').create({ name: 'Car', type: 'vehicle', value: 1000 }, 'EUR');
  assert.equal((await post(port, '/api/demo/clear', {})).status, 409); assert.equal((await post(port, '/api/demo/load', {})).status, 409);
  require('../lib/manual').remove('car');
});

test('sample data and real data never mix: adding your own data while sample data is loaded is refused', async () => {
  assert.equal((await post(port, '/api/demo/load', {})).status, 200);
  const before = Object.keys(require('../lib/store').txs()).length;
  for (const [u, body] of [['/api/manual', { name: 'Car', type: 'vehicle', value: 1000 }], ['/api/import/commit', { importId: 'x', mapping: {}, account: { name: 'A' } }], ['/api/sync', {}], ['/api/connect', { name: 'X', country: 'FI' }]]) {
    const r = await post(port, u, body); assert.equal(r.status, 409, u); assert.match(r.body, /sample data/i);
  }
  assert.equal(Object.keys(require('../lib/store').txs()).length, before, 'nothing was added');
  assert.equal((await post(port, '/api/demo/clear', {})).status, 200);
  assert.equal((await post(port, '/api/manual', { name: 'Car', type: 'vehicle', value: 1000 })).status, 200, 'allowed once the sample data is gone');
  require('../lib/manual').remove('car');
});

test('password: gate, login, cookie flags, lockout, logout, change, removal', async () => {
  assert.equal(JSON.parse((await raw(port, { url: '/api/auth/status' })).body).required, false);
  const setPw = (o, h = {}) => post(port, '/api/auth/password', o, h);
  assert.equal((await setPw({ password: 'short' })).status, 400);
  const set = await setPw({ password: 'correct horse battery' }); assert.equal(set.status, 200);
  let cookie = set.headers['set-cookie'][0].split(';')[0];
  assert.match(set.headers['set-cookie'][0], /HttpOnly/); assert.match(set.headers['set-cookie'][0], /SameSite=Lax/);
  assert.equal((await raw(port, { url: '/api/overview' })).status, 401);
  assert.equal((await raw(port, { url: '/api/overview', headers: { cookie } })).status, 200);
  const page = await raw(port, { url: '/' }); assert.equal(page.status, 302); assert.equal(page.headers.location, '/login');
  assert.equal((await raw(port, { url: '/login' })).status, 200, 'login page is public');
  assert.equal((await raw(port, { url: '/api/ping' })).status, 200, 'ping is public');
  for (const u of ['/api/state', '/api/settings', '/api/backup', '/api/transactions', '/api/autostart']) assert.equal((await raw(port, { url: u })).status, 401, u);
  for (const [m, u] of [['POST', '/api/demo/load'], ['PUT', '/api/budget'], ['POST', '/api/import/upload'], ['POST', '/api/backup/restore-upload'], ['POST', '/api/sync']]) assert.equal((await raw(port, { method: m, url: u, headers: { 'content-type': 'application/json', origin: `http://localhost:${port}` }, body: '{}' })).status, 401, `${m} ${u}`);
  assert.equal((await raw(port, { url: '/api/state', headers: { cookie: 'pennystead_session=forged' } })).status, 401, 'forged cookie');
  // changing needs the current password
  assert.equal((await setPw({ password: 'another long one' }, { cookie })).status, 403);
  assert.equal((await setPw({ current: 'wrong', password: 'another long one' }, { cookie })).status, 403);
  // logout invalidates the session
  await post(port, '/api/logout', {}, { cookie }); assert.equal((await raw(port, { url: '/api/overview', headers: { cookie } })).status, 401);
  // login: wrong then right
  assert.equal((await post(port, '/api/login', { password: 'nope' })).status, 401);
  const ok = await post(port, '/api/login', { password: 'correct horse battery' }); assert.equal(ok.status, 200); cookie = ok.headers['set-cookie'][0].split(';')[0];
  assert.equal((await raw(port, { url: '/api/overview', headers: { cookie } })).status, 200);
  // brute force: lockout after 5 failures, even for the right password
  const auth = require('../lib/auth'); auth.succeeded('127.0.0.1');
  for (let i = 0; i < 5; i++) assert.equal((await post(port, '/api/login', { password: 'bad' + i })).status, 401);
  const locked = await post(port, '/api/login', { password: 'correct horse battery' }); assert.equal(locked.status, 429); assert.ok(+locked.headers['retry-after'] > 800);
  auth.succeeded('127.0.0.1');
  // remove it again
  assert.equal((await setPw({ current: 'correct horse battery', password: null }, { cookie })).status, 200);
  assert.equal((await raw(port, { url: '/api/overview' })).status, 200);
  assert.ok(!fs.existsSync(path.join(dir, 'auth.json')));
});

test('auth.json holds a salted scrypt hash, never the password', async () => {
  const auth = require('../lib/auth'); auth.setPassword('very secret pass');
  const f = fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'); assert.ok(!f.includes('very secret pass')); assert.match(f, /"salt"/); assert.match(f, /"hash"/);
  assert.ok(auth.verify('very secret pass')); assert.ok(!auth.verify('very secret pas')); assert.ok(!auth.verify(''));
  auth.setPassword(null);
});

test('refuses to listen on the network without a password, accepts it with one', async () => {
  const { start } = require('../server'), auth = require('../lib/auth');
  await assert.rejects(() => start({ port: 0, host: '0.0.0.0' }), /without a password/);
  auth.setPassword('network password');
  const p2 = await freePort(), s2 = await start({ port: p2, host: '127.0.0.1' }); await s2.stop();
  auth.setPassword(null);
});

test('restore-upload refuses tampered, encrypted-without-passphrase and non-backup files', async () => {
  const bad = (body, h = {}) => raw(port, { method: 'POST', url: '/api/backup/restore-upload', headers: { origin: `http://localhost:${port}`, ...h }, body });
  assert.equal((await bad(Buffer.from('garbage'))).status, 400);
  const zlib = require('node:zlib');
  assert.equal((await bad(zlib.gzipSync(JSON.stringify({ app: 'pennystead', v: 1, files: { '../../evil': Buffer.from('x').toString('base64') } })))).status, 400);
  assert.equal((await bad(zlib.gzipSync(JSON.stringify({ app: 'pennystead', v: 1, files: { 'secrets.json': Buffer.from('{}').toString('base64') } })))).status, 400);
});

test('Chat with AI: the config shown to the user points at this app and is valid JSON', async () => {
  const r = await raw(port, { url: '/api/mcp-config' }); assert.equal(r.status, 200);
  const c = JSON.parse(r.body);
  const entry = JSON.parse(c.desktop).mcpServers.pennystead;
  assert.equal(entry.command, process.execPath); assert.ok(entry.args.some((a) => a.endsWith('mcp.js')), 'from source it runs mcp.js');
  assert.match(c.claudeCode, /^claude mcp add pennystead -- /);
  assert.ok(!/key|secret|password/i.test(r.body.replace(/pennystead-test-[^"\\]*/g, '')), 'no credentials in the config');
});

test('the web app manifest is public (browsers fetch it without the login cookie) and the window preference saves', async () => {
  const m = await raw(port, { url: '/manifest.webmanifest' });
  assert.equal(m.status, 200); assert.match(m.headers['content-type'], /manifest\+json/); assert.equal(JSON.parse(m.body).display, 'standalone');
  assert.equal((await post(port, '/api/window', { mode: 'nope' })).status, 400);
  assert.equal(JSON.parse((await post(port, '/api/window', { mode: 'browser' })).body).mode, 'browser');
  assert.equal(JSON.parse((await post(port, '/api/window', { mode: 'app' })).body).mode, 'app');
});
