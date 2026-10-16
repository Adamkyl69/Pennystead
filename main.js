#!/usr/bin/env node
// Pennystead launcher: starts the server, opens your browser, and makes a second launch just reopen the first.
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

// MCP mode: speak the protocol on stdin/stdout for Claude Desktop / Claude Code. Nothing else may print to stdout.
if (flag('--mcp')) {
  if (opt('--data-dir')) process.env.PENNYSTEAD_DATA = opt('--data-dir');
  if (flag('--write')) process.env.MCP_WRITE = '1';
  require('./mcp');
} else {

if (flag('--help') || flag('-h')) {
  console.log(`Pennystead: your private finance dashboard

Usage: pennystead [options]
  --mcp             Run as an MCP server on stdin/stdout (chat with your data from Claude). Add --write to allow recording valuations.
  --port <n>        Port to listen on (default 3456)
  --data-dir <dir>  Where your data is stored
  --no-browser      Do not open the browser on start
  --browser-tab     Open in a normal browser tab instead of Pennystead's own window
  --host <addr>     Listen address (default 127.0.0.1). Anything else requires a password.
  --version         Print the version
  --updated         (used by the updater) wait for the previous version to quit, do not open a window

Data location (default): Windows %APPDATA%\\Pennystead, macOS ~/Library/Application Support/Pennystead, Linux ~/.local/share/pennystead`);
  process.exit(0);
}
// Environment must be set before any module reads it.
if (opt('--data-dir')) process.env.PENNYSTEAD_DATA = opt('--data-dir');
if (opt('--port')) process.env.PENNYSTEAD_PORT = opt('--port');
if (opt('--host')) process.env.PENNYSTEAD_HOST = opt('--host');
const VERSION = require('./lib/version');
if (flag('--version')) { console.log(VERSION); process.exit(0); }

const { spawn } = require('child_process');
function openDefault(url) {
  const [cmd, a] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, a, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* no browser available: the URL is printed below */ }
}
function openBrowser(url) {
  if (flag('--no-browser') || process.env.PENNYSTEAD_NO_BROWSER === '1') return;
  // Its own window (Settings → Security → Window), unless the user prefers a normal browser tab.
  const wantApp = !flag('--browser-tab') && require('./lib/config').loadConfig().window !== 'browser';
  const app = wantApp ? require('./lib/window').appCommand(url) : null;
  if (!app) return openDefault(url);
  try { spawn(app[0], app[1], { stdio: 'ignore', detached: true }).on('error', () => openDefault(url)).unref(); } catch { openDefault(url); }
}

(async () => {
  const { start } = require('./server');
  const { DATA_DIR } = require('./lib/config');
  const port = +process.env.PENNYSTEAD_PORT || +process.env.PORT || 3456;
  // After an in-app update the old version may still be shutting down: wait for the port instead of giving up.
  const updated = flag('--updated');
  let waitForPort = updated;
  const listen = async () => {
    for (let i = 0; ; i++) {
      try { return await start({ port }); } catch (e) { if (!waitForPort || e.code !== 'EADDRINUSE' || i >= 40) throw e; await new Promise((r) => setTimeout(r, 500)); }
    }
  };
  // An older Pennystead still running (say a copy started from a download before installing) must not keep
  // answering instead of this newer one: ask it to quit, then take over its port.
  async function replaceOlder() {
    const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(2000) }).then((x) => x.json()).catch(() => null);
    if (r?.app !== 'pennystead' || !r.version || require('./lib/updater').compare(VERSION, r.version) <= 0) return { running: r };
    const q = await fetch(`http://127.0.0.1:${port}/api/quit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(3000) }).catch(() => null);
    if (!q?.ok) return { running: r, stuck: true };
    console.log(`Pennystead ${r.version} was still running; replaced it with ${VERSION}.`);
    waitForPort = true;
    return { replaced: true };
  }
  try {
    const s = await listen();
    console.log(`\n  Pennystead ${VERSION} is running\n\n    Open:  ${s.url}\n    Data:  ${DATA_DIR}\n\n  Keep this window open while you use Pennystead.\n  Close it (or press Ctrl+C) to quit.\n`);
    if (!updated) openBrowser(s.url); // after an update the open window reloads itself
    const quit = () => s.stop().then(() => process.exit(0));
    process.on('SIGINT', quit); process.on('SIGTERM', quit);
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      const old = await replaceOlder();
      if (old.replaced) {
        try { const s = await listen(); console.log(`\n  Pennystead ${VERSION} is running at ${s.url}\n`); openBrowser(s.url); const quit = () => s.stop().then(() => process.exit(0)); process.on('SIGINT', quit); process.on('SIGTERM', quit); return; }
        catch (e2) { console.error(`Pennystead could not start: ${e2.message}`); process.exit(1); }
      }
      if (old.stuck) console.error(`An older Pennystead (${old.running.version}) is still running. Quit it (Settings → Security → Quit Pennystead, or end pennystead.exe in Task Manager), then start Pennystead again.`);
      // Is it Pennystead itself? Then just bring it up instead of failing.
      const r = old.running;
      if (r?.app === 'pennystead') { console.log(`Pennystead is already running at http://localhost:${port}. Opening it.`); openBrowser(`http://localhost:${port}`); process.exit(0); }
      console.error(`Port ${port} is used by another program. Close it, or start Pennystead with --port <another number>.`);
    } else console.error(`Pennystead could not start: ${e.message}`);
    process.exit(1);
  }
})();
}
