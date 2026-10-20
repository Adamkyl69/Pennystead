// Settings → MCP server: the local MCP address (token-protected), the connection test, and automatic bank sync settings.
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');

const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const raw = (port, { method = 'GET', url = '/', headers = {}, body } = {}) => new Promise((ok, bad) => {
  const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: { host: `localhost:${port}`, ...headers } }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => ok({ status: res.statusCode, body: Buffer.concat(c).toString() })); });
  r.on('error', bad); if (body) r.write(body); r.end();
});
const post = (port, url, obj, headers = {}) => raw(port, { method: 'POST', url, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(obj) });
const app = (port, url, obj) => post(port, url, obj, { origin: `http://localhost:${port}` });
const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });

let srv, port;
test.before(async () => { port = await freePort(); srv = await require('../server').start({ port }); });
test.after(async () => { await srv.stop(); });

test('the MCP address is off until turned on, then needs its token', async () => {
  assert.equal((await post(port, '/mcp', rpc(1, 'ping'))).status, 404);
  assert.equal((await app(port, '/api/mcp/http', { enabled: true })).status, 200);
  const c = JSON.parse((await raw(port, { url: '/api/mcp' })).body);
  assert.equal(c.http.enabled, true); assert.equal(c.http.url, `http://localhost:${port}/mcp`); assert.ok(c.http.token.length >= 30);
  assert.equal(JSON.parse(c.http.json).mcpServers.pennystead.headers.Authorization, `Bearer ${c.http.token}`);
  assert.equal((await post(port, '/mcp', rpc(1, 'ping'))).status, 401, 'no token');
  assert.equal((await post(port, '/mcp', rpc(1, 'ping'), { authorization: 'Bearer wrong' })).status, 401, 'wrong token');
  const auth = { authorization: `Bearer ${c.http.token}` };
  const init = await post(port, '/mcp', rpc(1, 'initialize', { protocolVersion: '2025-03-26' }), auth);
  assert.equal(init.status, 200); assert.equal(JSON.parse(init.body).result.serverInfo.name, 'pennystead');
  assert.equal((await post(port, '/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }, auth)).status, 202);
  let names = JSON.parse((await post(port, '/mcp', rpc(2, 'tools/list'), auth)).body).result.tools.map((t) => t.name);
  assert.ok(names.includes('net_worth') && !names.includes('record_valuation'), 'read-only by default');
  const call = JSON.parse((await post(port, '/mcp', rpc(3, 'tools/call', { name: 'net_worth', arguments: {} }), auth)).body);
  assert.ok(!call.result.isError, JSON.stringify(call));
  // Another website in your browser cannot use it, even with the token.
  assert.equal((await post(port, '/mcp', rpc(4, 'ping'), { ...auth, origin: 'https://evil.example' })).status, 403);
  await app(port, '/api/mcp/http', { enabled: true, write: true });
  names = JSON.parse((await post(port, '/mcp', rpc(5, 'tools/list'), auth)).body).result.tools.map((t) => t.name);
  assert.ok(names.includes('record_valuation'));
  await app(port, '/api/mcp/http', { enabled: true, rotate: true });
  assert.equal((await post(port, '/mcp', rpc(6, 'ping'), auth)).status, 401, 'a new token replaces the old one');
  await app(port, '/api/mcp/http', { enabled: false });
  assert.equal((await post(port, '/mcp', rpc(7, 'ping'), auth)).status, 404);
});

test('the set-up shown for each app, and the connection test, start the real MCP server', async () => {
  const c = JSON.parse((await raw(port, { url: '/api/mcp' })).body);
  assert.ok(!c.readOnly.entry.env?.MCP_WRITE && c.write.entry.env.MCP_WRITE === '1', 'from source, write access is MCP_WRITE=1');
  assert.ok(c.tools.some((t) => t.write));
  const r = JSON.parse((await app(port, '/api/mcp/test', { write: false })).body);
  assert.equal(r.ok, true, JSON.stringify(r)); assert.ok(r.tools.includes('net_worth')); assert.ok(!r.tools.includes('record_valuation'));
  const w = JSON.parse((await app(port, '/api/mcp/test', { write: true })).body);
  assert.ok(w.tools.includes('record_valuation'));
});

test('automatic bank sync: interval setting and status', async () => {
  let s = JSON.parse((await raw(port, { url: '/api/sync/status' })).body);
  assert.equal(s.every, '6h'); assert.equal(s.nextAt, null, 'nothing to sync without a bank');
  assert.equal((await app(port, '/api/sync/auto', { every: 'hourly' })).status, 400);
  s = JSON.parse((await app(port, '/api/sync/auto', { every: '24h' })).body);
  assert.equal(s.every, '24h');
  assert.equal(require('../lib/config').loadConfig().autoSync, '24h');
  // Connected, last synced 7 hours ago: with "once a day" the next sync is 17 hours away; with "every 6 hours" it is due.
  require('../lib/banks').add({ session_id: 's1', aspsp: { name: 'Bank', country: 'FI' }, accounts: [{ uid: 'u1' }] });
  require('../lib/store').saveAccounts({ u1: { name: 'main', currency: 'EUR', lastSync: '2026-01-01', lastSyncAt: new Date(Date.now() - 7 * 3600e3).toISOString() } });
  s = JSON.parse((await raw(port, { url: '/api/sync/status' })).body);
  assert.ok(Math.abs(Date.parse(s.nextAt) - (Date.now() + 17 * 3600e3)) < 60e3, s.nextAt);
  s = JSON.parse((await app(port, '/api/sync/auto', { every: '6h' })).body);
  assert.ok(Date.parse(s.nextAt) <= Date.now() + 1000, 'due now');
  s = JSON.parse((await app(port, '/api/sync/auto', { every: 'off' })).body);
  assert.equal(s.nextAt, null);
});
