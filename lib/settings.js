// Credentials for external services, entered in the UI and kept in data/secrets.json (owner-only, never backed up, never sent to the browser).
// Environment variables still take precedence, so Docker and developer setups work unchanged.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { paths, ROOT } = require('./config');

const read = () => { try { return JSON.parse(fs.readFileSync(paths.secrets, 'utf8')); } catch { return {}; } };
function write(o) { fs.writeFileSync(paths.secrets + '.tmp', JSON.stringify(o, null, 2), { mode: 0o600 }); fs.renameSync(paths.secrets + '.tmp', paths.secrets); }
const env = process.env;

function enableBanking() {
  const s = read().enablebanking || {}, appId = env.APP_ID || s.appId;
  let key = s.privateKey || null;
  if (env.KEY_PATH) { try { key = fs.readFileSync(path.resolve(ROOT, env.KEY_PATH), 'utf8'); } catch { key = null; } }
  return appId && key ? { appId: String(appId).trim(), privateKey: key } : null;
}
const alphaVantage = () => env.ALPHAVANTAGE_API_KEY || read().alphavantage?.apiKey || null;
function google() {
  const s = read().google || {}, clientId = env.GOOGLE_CLIENT_ID || s.clientId, clientSecret = env.GOOGLE_CLIENT_SECRET || s.clientSecret;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

function setEnableBanking({ appId, privateKey }) {
  appId = String(appId || '').trim(); privateKey = String(privateKey || '').trim();
  if (!appId || appId.length > 100) throw new Error('Enter the Application ID shown in the Enable Banking control panel.');
  let k;
  try { k = crypto.createPrivateKey(privateKey); } catch { throw new Error('That does not look like a private key. Choose the .pem file you downloaded when you registered the application.'); }
  if (k.asymmetricKeyType !== 'rsa') throw new Error('Enable Banking uses an RSA key. This key is a different type.');
  write({ ...read(), enablebanking: { appId, privateKey: privateKey + '\n' } });
}
function setAlphaVantage(apiKey) { apiKey = String(apiKey || '').trim(); if (!/^[\w-]{6,64}$/.test(apiKey)) throw new Error('That does not look like an Alpha Vantage API key.'); write({ ...read(), alphavantage: { apiKey } }); }
function setGoogle({ clientId, clientSecret }) {
  clientId = String(clientId || '').trim(); clientSecret = String(clientSecret || '').trim();
  if (!clientId.endsWith('.apps.googleusercontent.com')) throw new Error('The Client ID should end in .apps.googleusercontent.com.');
  if (clientSecret.length < 8) throw new Error('Enter the Client secret.');
  write({ ...read(), google: { clientId, clientSecret } });
}
function clear(name) { const s = read(); delete s[{ enablebanking: 'enablebanking', alphavantage: 'alphavantage', google: 'google' }[name]]; write(s); }

/** Safe summary for the UI: IDs are shown, secrets never are. */
function status() {
  const s = read(), eb = enableBanking(), g = google();
  return {
    enablebanking: { configured: !!eb, appId: eb?.appId || null, source: env.APP_ID ? 'environment' : s.enablebanking ? 'saved' : null },
    alphavantage: { configured: !!alphaVantage(), source: env.ALPHAVANTAGE_API_KEY ? 'environment' : s.alphavantage ? 'saved' : null },
    google: { configured: !!g, clientId: g?.clientId || null, source: env.GOOGLE_CLIENT_ID ? 'environment' : s.google ? 'saved' : null },
  };
}
module.exports = { enableBanking, alphaVantage, google, setEnableBanking, setAlphaVantage, setGoogle, clear, status };
