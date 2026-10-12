#!/usr/bin/env node
// Pennystead launcher: starts the server, opens your browser, and makes a second launch just reopen the first.
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

if (flag('--help') || flag('-h')) {
  console.log(`Pennystead: your private finance dashboard

Usage: pennystead [options]
  --port <n>        Port to listen on (default 3456)
  --data-dir <dir>  Where your data is stored
  --no-browser      Do not open the browser on start
  --host <addr>     Listen address (default 127.0.0.1). Anything else requires a password.
  --version         Print the version

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
function openBrowser(url) {
  if (flag('--no-browser') || process.env.PENNYSTEAD_NO_BROWSER === '1') return;
  const [cmd, a] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, a, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* no browser available: the URL is printed below */ }
}

(async () => {
  const { start } = require('./server');
  const { DATA_DIR } = require('./lib/config');
  const port = +process.env.PENNYSTEAD_PORT || +process.env.PORT || 3456;
  try {
    const s = await start({ port });
    console.log(`\n  Pennystead ${VERSION} is running\n\n    Open:  ${s.url}\n    Data:  ${DATA_DIR}\n\n  Keep this window open while you use Pennystead.\n  Close it (or press Ctrl+C) to quit.\n`);
    openBrowser(s.url);
    const quit = () => s.stop().then(() => process.exit(0));
    process.on('SIGINT', quit); process.on('SIGTERM', quit);
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      // Is it Pennystead itself? Then just bring it up instead of failing.
      const r = await fetch(`http://127.0.0.1:${port}/api/ping`).then((x) => x.json()).catch(() => null);
      if (r?.app === 'pennystead') { console.log(`Pennystead is already running at http://localhost:${port}. Opening it.`); openBrowser(`http://localhost:${port}`); process.exit(0); }
      console.error(`Port ${port} is used by another program. Close it, or start Pennystead with --port <another number>.`);
    } else console.error(`Pennystead could not start: ${e.message}`);
    process.exit(1);
  }
})();
