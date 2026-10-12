// Open Pennystead in its own window (no tabs or address bar) using a Chromium-based browser's app mode,
// so it looks and behaves like a desktop app. Falls back to the default browser when none is installed.
const fs = require('fs');
const path = require('path');

function candidates() {
  const env = process.env;
  if (process.platform === 'win32') {
    const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean);
    const rel = [['Microsoft Edge', 'Microsoft\\Edge\\Application\\msedge.exe'], ['Google Chrome', 'Google\\Chrome\\Application\\chrome.exe'], ['Brave', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe']];
    return rel.flatMap(([name, r]) => roots.map((root) => [name, path.join(root, r)]));
  }
  if (process.platform === 'darwin') {
    const apps = [['Google Chrome', 'Google Chrome'], ['Microsoft Edge', 'Microsoft Edge'], ['Brave', 'Brave Browser'], ['Chromium', 'Chromium']];
    return apps.flatMap(([name, app]) => ['/Applications', path.join(env.HOME || '', 'Applications')].map((d) => [name, path.join(d, `${app}.app`, 'Contents', 'MacOS', app)]));
  }
  const bins = [['Google Chrome', 'google-chrome'], ['Google Chrome', 'google-chrome-stable'], ['Chromium', 'chromium'], ['Chromium', 'chromium-browser'], ['Microsoft Edge', 'microsoft-edge'], ['Brave', 'brave-browser']];
  return bins.flatMap(([name, b]) => (env.PATH || '').split(path.delimiter).filter(Boolean).map((d) => [name, path.join(d, b)]));
}

/** The first installed Chromium-based browser: { name, exe }, or null. */
function find() {
  for (const [name, exe] of candidates()) { try { if (fs.statSync(exe).isFile()) return { name, exe }; } catch { /* not here */ } }
  return null;
}

/** The command that opens `url` as an app window, or null. */
function appCommand(url) {
  const b = find();
  return b ? [b.exe, [`--app=${url}`, '--new-window']] : null;
}

module.exports = { find, appCommand };
