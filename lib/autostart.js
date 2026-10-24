// "Start Pennystead when I log in", for the packaged app. Writes the standard per-user autostart entry of each OS.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { PACKAGED } = require('./config');

const exe = process.execPath;
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const plist = () => path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.pennystead.app.plist');
const desktop = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'pennystead.desktop');
const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function status() {
  if (!PACKAGED) return { supported: false, enabled: false, reason: 'Available in the installed app.' };
  try {
    if (process.platform === 'win32') { execFileSync('reg', ['query', RUN_KEY, '/v', 'Pennystead'], { stdio: 'ignore', windowsHide: true }); return { supported: true, enabled: true }; }
  } catch { return { supported: true, enabled: false }; }
  if (process.platform === 'darwin') return { supported: true, enabled: fs.existsSync(plist()) };
  if (process.platform === 'linux') return { supported: true, enabled: fs.existsSync(desktop()) };
  return { supported: false, enabled: false, reason: 'Not supported on this system.' };
}

// Desktop Entry Exec quoting: inside double quotes, \ " ` $ are backslash-escaped, and % is written as %%.
const desktopQuote = (p) => `"${String(p).replace(/[\\"`$]/g, '\\$&').replace(/%/g, '%%')}"`;
function set(enabled) {
  if (!PACKAGED) throw Object.assign(new Error('Start-at-login is available in the installed app.'), { status: 400 });
  if (process.platform === 'win32') {
    // The Windows app has no console window, so it can start directly (older versions went through a hidden PowerShell).
    if (enabled) execFileSync('reg', ['add', RUN_KEY, '/v', 'Pennystead', '/t', 'REG_SZ', '/d', `"${exe}" --no-browser`, '/f'], { stdio: 'ignore', windowsHide: true });
    else { try { execFileSync('reg', ['delete', RUN_KEY, '/v', 'Pennystead', '/f'], { stdio: 'ignore', windowsHide: true }); } catch { /* already gone */ } }
  } else if (process.platform === 'darwin') {
    if (enabled) {
      fs.mkdirSync(path.dirname(plist()), { recursive: true });
      fs.writeFileSync(plist(), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.pennystead.app</string><key>ProgramArguments</key><array><string>${xml(exe)}</string><string>--no-browser</string></array><key>RunAtLoad</key><true/></dict></plist>\n`);
    } else fs.rmSync(plist(), { force: true });
  } else if (process.platform === 'linux') {
    if (enabled) {
      fs.mkdirSync(path.dirname(desktop()), { recursive: true });
      fs.writeFileSync(desktop(), `[Desktop Entry]\nType=Application\nName=Pennystead\nExec=${desktopQuote(exe)} --no-browser\nX-GNOME-Autostart-enabled=true\n`);
    } else fs.rmSync(desktop(), { force: true });
  } else throw Object.assign(new Error('Not supported on this system.'), { status: 400 });
  return status();
}
module.exports = { status, set };
