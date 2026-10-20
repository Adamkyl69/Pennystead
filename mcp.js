#!/usr/bin/env node
// MCP server (stdio, JSON-RPC) so an AI client can chat with your finances.
// Packaged app:  Pennystead --mcp [--write] [--data-dir <dir>]   From source:  node mcp.js   (Settings → MCP server shows the exact config for your install)
const WRITE = process.env.MCP_WRITE === '1';
const { handle } = require('./lib/mcpserver');

const send = (m) => m && process.stdout.write(JSON.stringify(m) + '\n');
let buf = '';
process.stdin.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) { try { handle(JSON.parse(line), { write: WRITE }).then(send, () => {}); } catch { /* ignore garbage */ } } } });
