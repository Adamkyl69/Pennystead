#!/usr/bin/env node
// MCP server (stdio, JSON-RPC) so an AI client can chat with your finances.
// Packaged app:  Pennystead --mcp [--write] [--data-dir <dir>]   From source:  node mcp.js   (Settings → Chat shows the exact config for your install)
// Other apps and devices can use the same tools over HTTP at /mcp with a bearer token (Settings → Security).
const WRITE = process.env.MCP_WRITE === '1';
const { handle } = require('./lib/mcp-handler');

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');

let buf = '';
process.stdin.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) { try { handle(JSON.parse(line), { write: WRITE }).then((r) => r && send(r)).catch(() => {}); } catch { /* ignore garbage */ } } } });
