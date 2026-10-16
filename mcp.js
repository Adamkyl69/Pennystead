#!/usr/bin/env node
// MCP server (stdio, JSON-RPC) so an AI client can chat with your finances.
// Packaged app:  Pennystead --mcp [--write] [--data-dir <dir>]   From source:  node mcp.js   (Settings → Chat shows the exact config for your install)
const WRITE = process.env.MCP_WRITE === '1';
const prompts = require('./lib/prompts');
const tools = require('./lib/tools');

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
async function handle(msg) {
  if (!msg || typeof msg !== 'object') return; // not a JSON-RPC message
  const { id, method, params } = msg;
  if (id === undefined) return; // notification
  try {
    if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2025-03-26', capabilities: { tools: {}, prompts: {} }, serverInfo: { name: 'pennystead', version: require('./lib/version') }, instructions: 'Private personal finance data from Pennystead. Amounts: negative = money out. Base currency is in net_worth/overview.' } });
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'prompts/list') return send({ jsonrpc: '2.0', id, result: { prompts: prompts.list() } });
    if (method === 'prompts/get') return send({ jsonrpc: '2.0', id, result: prompts.get(params?.name, params?.arguments) });
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: tools.list({ write: WRITE }).map(({ name, description, inputSchema, write }) => ({ name, description, inputSchema, annotations: { readOnlyHint: !write } })) } });
    if (method === 'tools/call') {
      try {
        const res = await tools.call(params.name, params.arguments || {}, { write: WRITE });
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(res) }] } });
      } catch (e) {
        return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: e.message }] } });
      }
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  } catch (e) { send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } }); }
}

let buf = '';
process.stdin.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) { try { handle(JSON.parse(line)).catch(() => {}); } catch { /* ignore garbage */ } } } });
