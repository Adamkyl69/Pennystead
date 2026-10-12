// The packaged app is its own MCP server: `Pennystead --mcp` must speak JSON-RPC on stdout and print nothing else.
const { dir } = require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const MAIN = path.join(__dirname, '..', 'main.js');

function session(extra = []) {
  const p = spawn(process.execPath, [MAIN, '--mcp', '--data-dir', dir, ...extra], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = ''; const waiting = new Map(); const lines = [];
  p.stdout.on('data', (c) => { out += c; let i; while ((i = out.indexOf('\n')) >= 0) { const l = out.slice(0, i); out = out.slice(i + 1); lines.push(l); const m = JSON.parse(l); waiting.get(m.id)?.(m); } });
  let n = 0;
  const call = (method, params) => new Promise((resolve, reject) => { const id = ++n; const t = setTimeout(() => reject(new Error('no reply to ' + method)), 8000); waiting.set(id, (m) => { clearTimeout(t); resolve(m); }); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  return { call, lines, close: () => p.kill() };
}

test('--mcp: handshake, tool list and a real tool call, with only JSON on stdout', async () => {
  const s = session();
  try {
    const init = await s.call('initialize', { protocolVersion: '2025-03-26' });
    assert.equal(init.result.serverInfo.name, 'pennystead');
    assert.equal(init.result.serverInfo.version, require('../package.json').version);
    const tools = (await s.call('tools/list')).result.tools.map((t) => t.name);
    for (const t of ['net_worth', 'overview', 'anomalies', 'subscriptions', 'budget_status', 'search_transactions']) assert.ok(tools.includes(t), t);
    assert.ok(!tools.includes('record_valuation'), 'read-only unless --write');
    const r = await s.call('tools/call', { name: 'anomalies', arguments: {} });
    assert.ok(!r.result.isError, JSON.stringify(r));
    assert.doesNotThrow(() => JSON.parse(r.result.content[0].text));
    for (const l of s.lines) JSON.parse(l); // every stdout line is a JSON-RPC message
  } finally { s.close(); }
});

test('--mcp --write exposes record_valuation', async () => {
  const s = session(['--write']);
  try {
    await s.call('initialize', {});
    assert.ok((await s.call('tools/list')).result.tools.some((t) => t.name === 'record_valuation'));
  } finally { s.close(); }
});

test('--mcp: guided reviews are offered as prompts, and the review queue tool carries suggestions', async () => {
  const s = session();
  try {
    const init = await s.call('initialize', {});
    assert.ok(init.result.capabilities.prompts, 'prompts capability is announced');
    const names = (await s.call('prompts/list')).result.prompts.map((p) => p.name);
    for (const n of ['monthly_review', 'find_savings', 'budget_checkup', 'net_worth_report', 'tidy_categories']) assert.ok(names.includes(n), n);
    const got = (await s.call('prompts/get', { name: 'monthly_review', arguments: { month: '2026-03' } })).result;
    assert.equal(got.messages[0].role, 'user'); assert.match(got.messages[0].content.text, /2026-03/); assert.match(got.messages[0].content.text, /2026-02/, 'compares with the month before');
    assert.ok((await s.call('prompts/get', { name: 'nope' })).error, 'unknown prompt is an error');
    const tools = (await s.call('tools/list')).result.tools.map((t) => t.name);
    assert.ok(tools.includes('review_queue'));
    for (const l of s.lines) JSON.parse(l);
  } finally { s.close(); }
});
