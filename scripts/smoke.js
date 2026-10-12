#!/usr/bin/env node
// Starts a built Pennystead binary in an empty data folder and exercises it over HTTP like a first-time user would.
// Usage: node scripts/smoke.js <path to pennystead[.exe]>      (CI runs this on every operating system)
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const bin = path.resolve(process.argv[2] || '');
if (!fs.existsSync(bin)) { console.error('Usage: node scripts/smoke.js <path to pennystead binary>'); process.exit(2); }
const free = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (cond, msg) => { if (!cond) throw new Error('FAILED: ' + msg); console.log('  ok  ' + msg); };

(async () => {
  const port = await free(), data = fs.mkdtempSync(path.join(os.tmpdir(), 'pennystead-smoke-')), base = `http://localhost:${port}`;
  const child = spawn(bin, ['--no-browser', '--port', String(port), '--data-dir', data], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PENNYSTEAD_NO_BROWSER: '1' } });
  let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
  const exited = new Promise((r) => child.on('exit', (c) => r(c)));
  try {
    let up = false; for (let i = 0; i < 60 && !up; i++) { await sleep(500); up = await fetch(base + '/api/ping').then((r) => r.ok).catch(() => false); }
    check(up, 'server starts');
    const ping = await (await fetch(base + '/api/ping')).json(); check(ping.app === 'pennystead', `reports itself (version ${ping.version})`);
    const html = await (await fetch(base + '/')).text(); check(html.includes('Pennystead') && html.includes('/app.js'), 'serves the embedded UI');
    for (const f of ['/app.js', '/pages.js', '/login', '/favicon.svg']) check((await fetch(base + f)).status === 200, `serves ${f}`);
    const hdrs = (await fetch(base + '/')).headers; check(/script-src 'self'/.test(hdrs.get('content-security-policy')), 'sends a Content-Security-Policy');
    const j = { 'Content-Type': 'application/json', Origin: base };
    check(!(await (await fetch(base + '/api/state')).json()).hasData, 'starts empty (first-run)');
    check((await fetch(base + '/api/demo/load', { method: 'POST', headers: j, body: '{}' })).ok, 'loads sample data');
    check(fs.existsSync(path.join(data, 'transactions.json')), 'writes its data to the data folder');
    const o = await (await fetch(base + '/api/overview')).json(); check(typeof o.wealth.netWorth === 'number' && o.cashflow.length > 0, `computes the dashboard without hledger (net worth ${o.wealth.netWorth})`);
    const h = await (await fetch(base + '/api/history?range=1Y')).json(); check(h.net.length > 10, 'computes net-worth history');
    check((await fetch(base + '/api/demo/clear', { method: 'POST', headers: j, body: '{}' })).ok, 'clears sample data');
    const rebinding = await new Promise((ok) => { const r = http.request({ host: '127.0.0.1', port, path: '/api/ping', headers: { host: 'evil.example' } }, (res) => { res.resume(); ok(res.statusCode); }); r.on('error', () => ok(0)); r.end(); });
    check(rebinding === 421, 'refuses a foreign Host header (DNS rebinding)');
    const bad = await fetch(base + '/api/budget', { method: 'PUT', headers: { ...j, Origin: 'https://evil.example' }, body: '{}' }); check(bad.status === 403, 'refuses cross-origin writes');
    await fetch(base + '/api/quit', { method: 'POST', headers: j, body: '{}' }).catch(() => {});
    const code = await Promise.race([exited, sleep(8000).then(() => 'timeout')]); check(code === 0, 'quits cleanly');
    console.log('\nSMOKE TEST PASSED');
  } catch (e) { console.error('\n' + e.message + '\n--- output ---\n' + log); child.kill(); process.exitCode = 1; }
  finally { child.kill(); fs.rmSync(data, { recursive: true, force: true }); }
})();
