// Pennystead web server: UI + JSON API. Listens on localhost only unless explicitly told otherwise (and then a password is mandatory).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { paths, DATA_DIR, PACKAGED, loadConfig, writeAtomic, saveConfig } = require('./lib/config');
const { eb, configured } = require('./lib/eb');
const { sync, coverage } = require('./lib/sync');
const { updatePrices } = require('./lib/prices');
const core = require('./lib/core');
const goals = require('./lib/goals');
const goalChecks = require('./lib/goalchecks');
const manual = require('./lib/manual');
const backup = require('./lib/backup');
const gdrive = require('./lib/gdrive');
const importer = require('./lib/importer');
const J = require('./lib/journal');
const store = require('./lib/store');
const demo = require('./lib/demo');
const settings = require('./lib/settings');
const auth = require('./lib/auth');
const security = require('./lib/security');
const assets = require('./lib/assets');
const autostart = require('./lib/autostart');
const VERSION = require('./lib/version');
const updater = require('./lib/updater');
const llm = require('./lib/llm');

const CONSENT_DAYS = +process.env.CONSENT_DAYS || 90;
const hasSession = () => fs.existsSync(paths.session);
const HttpError = (status, message) => Object.assign(new Error(message), { status });
// Sample data and real data never mix: clearing the sample data must never be able to remove something you added yourself.
const notInDemo = () => { if (demo.isDemo()) throw HttpError(409, 'You are viewing sample data. Clear it first (top bar → Clear sample data) before adding your own.'); };

const readRaw = (req, max = 200e6) => new Promise((ok, bad) => { const c = []; let n = 0; req.on('data', (d) => { n += d.length; if (n > max) { bad(HttpError(413, 'File too large')); req.destroy(); } else c.push(d); }); req.on('end', () => ok(Buffer.concat(c))); req.on('error', bad); });
async function readBody(req) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw HttpError(415, 'Expected application/json');
  const raw = await readRaw(req, 1e6);
  try { return raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { throw HttpError(400, 'Invalid JSON'); }
}

let pendingState = null, syncing = null;
const runSync = (opts) => (syncing ??= sync(opts).finally(() => (syncing = null)));

async function start({ port = +process.env.PENNYSTEAD_PORT || +process.env.PORT || 3456, host = process.env.PENNYSTEAD_HOST || '127.0.0.1' } = {}) {
  const exposed = !security.loopback(host);
  if (exposed && !auth.required()) throw new Error(`Refusing to listen on ${host} without a password. Set PENNYSTEAD_PASSWORD (or set a password in Settings → Security first), or listen on localhost only.`);
  const hosts = security.allowedHosts(port);
  // Enable Banking only accepts https redirect addresses. By default the bank sends you to a tiny relay page on GitHub
  // Pages (docs/callback.html), which forwards straight to Pennystead on this computer; the port travels in `state`.
  // Settings → Connections can change it, and REDIRECT_URL overrides it.
  const RELAY = 'https://adamkyl69.github.io/Pennystead/callback.html';
  const redirectUrl = () => process.env.REDIRECT_URL || loadConfig().bankRedirect || RELAY;
  const LOCAL_CALLBACK = `http://localhost:${port}/callback`;
  /** Finish a bank connection from the code and state the bank returned (by redirect, or pasted by the user). */
  async function finishConnect(q) {
    if (q.error) throw HttpError(400, `Your bank did not complete the connection: ${q.error_description || q.error}. Start again from Settings → Banks.`);
    if (!q.code || !pendingState || q.state !== pendingState) throw HttpError(400, 'This link does not match the connection you started (or it was already used). Start again from Settings → Banks.');
    pendingState = null;
    writeAtomic(paths.session, JSON.stringify(await eb('POST', '/sessions', { code: q.code }), null, 2), { mode: 0o600 });
    await runSync({ full: true }).catch((e) => console.error('initial sync failed:', e.message)); // right after approval is when banks allow the most history
  }
  const GOOGLE_REDIRECT = `http://localhost:${port}/oauth/google/callback`;

  const send = (res, code, body, type = 'application/json', extra = {}) => {
    res.writeHead(code, security.headers({ 'Content-Type': type, ...extra }));
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };
  const json = (res, code, obj, extra) => send(res, code, obj, 'application/json', extra);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`), P = url.pathname, METHOD = req.method, q = Object.fromEntries(url.searchParams);
    const ip = req.socket.remoteAddress || '';
    try {
      const blocked = security.check(req, hosts);
      if (blocked) return json(res, blocked.status, { error: blocked.message });

      // ----- public routes (no login needed) -----
      if (P === '/api/ping') return json(res, 200, { app: 'pennystead', version: VERSION });
      if (P === '/api/auth/status') return json(res, 200, { required: auth.required(), authenticated: auth.authenticated(req) });
      if (P === '/api/login' && METHOD === 'POST') {
        const wait = auth.locked(ip);
        if (wait) return json(res, 429, { error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} minutes.` }, { 'Retry-After': String(wait) });
        const { password } = await readBody(req);
        // Checked again after the body arrives: requests sent in parallel would otherwise all pass the first check.
        const again = auth.locked(ip);
        if (again) return json(res, 429, { error: `Too many attempts. Try again in ${Math.ceil(again / 60)} minutes.` }, { 'Retry-After': String(again) });
        if (!auth.verify(password)) { auth.failed(ip); return json(res, 401, { error: 'Wrong password.' }); }
        auth.succeeded(ip);
        return json(res, 200, { ok: true }, { 'Set-Cookie': auth.setCookie(auth.newSession()) });
      }
      if (P === '/api/logout' && METHOD === 'POST') { auth.logout(req); return json(res, 200, {}, { 'Set-Cookie': auth.clearCookie() }); }
      const PUBLIC_FILES = ['/login', '/login.js', '/favicon.svg', '/manifest.webmanifest'];
      if (PUBLIC_FILES.includes(P)) {
        const a = assets.get(P === '/login' ? 'login.html' : P);
        return a ? send(res, 200, a.body, a.type) : send(res, 404, 'Not found', 'text/plain');
      }

      // ----- everything else needs a login when a password is set -----
      if (!auth.authenticated(req)) {
        if (P.startsWith('/api/')) return json(res, 401, { error: 'Login required', login: true });
        res.writeHead(302, security.headers({ Location: '/login' })); return res.end();
      }

      if (P === '/api/auth/password' && METHOD === 'POST') {
        const b = await readBody(req);
        if (process.env.PENNYSTEAD_PASSWORD) throw HttpError(400, 'The password is set by the PENNYSTEAD_PASSWORD environment variable.');
        if (auth.required() && !auth.verify(b.current)) throw HttpError(403, 'Current password is wrong.');
        // Only a string sets a password and only an explicit null removes it: a missing field must not switch login off.
        if (b.password !== null && typeof b.password !== 'string') throw HttpError(400, 'Send the new password, or null to remove it.');
        if (b.password === null && exposed) throw HttpError(400, 'A password is required while Pennystead listens on the network.');
        auth.setPassword(b.password);
        return json(res, 200, { required: auth.required() }, b.password ? { 'Set-Cookie': auth.setCookie(auth.newSession()) } : { 'Set-Cookie': auth.clearCookie() });
      }

      // ----- app state & data -----
      if (P === '/api/state') {
        const all = store.txs(), accounts = Object.values(store.accounts()).map((a) => ({ name: a.name, label: a.label, currency: a.currency, lastSync: a.lastSync || null, imported: !!a.imported, iban: a.iban ? a.iban.slice(-4) : null, history: coverage('assets:bank:' + a.name, all) }));
        return json(res, 200, { ...(await core.state()), goalCheck: goalChecks.unseen(), update: updater.summary(), connectPending: !!pendingState, version: VERSION, packaged: PACKAGED, dataDir: DATA_DIR, authRequired: auth.required(), hasData: !demo.isEmpty(), canConnect: configured(), canPrices: !!settings.alphaVantage(), ai: settings.openRouter() ? { model: settings.openRouter().model } : null, demo: demo.isDemo(), accounts, redirectUrl: redirectUrl(), port });
      }
      if (P === '/api/overview') return json(res, 200, await core.overview());
      if (P === '/api/history') return json(res, 200, await core.wealthHistory(q.range));
      if (P === '/api/spending') return json(res, 200, await core.spending(q));
      if (P === '/api/transactions') return json(res, 200, await core.transactionsPage(q));
      if (P === '/api/review') return json(res, 200, await core.review(q));
      if (P === '/api/review/hide' && METHOD === 'POST') { const b = await readBody(req); return json(res, 200, core.setHidden(b.kind, b.id, b.hide !== false)); }
      if (P === '/api/assets') return json(res, 200, await core.wealth());
      if (P === '/api/categories') { if (METHOD === 'POST') { core.addCategory((await readBody(req)).account); return json(res, 200, {}); } return json(res, 200, await core.categories()); }
      if (P === '/api/rules') { if (METHOD === 'PUT') return json(res, 200, core.setRules((await readBody(req)).rules)); return json(res, 200, loadConfig().rules); }
      if (P === '/api/budget' && METHOD === 'PUT') { const b = await readBody(req); core.setBudget(b.category, b.amount, b.period); return json(res, 200, {}); }
      if (P === '/api/transactions/category' && METHOD === 'POST') { const b = await readBody(req); return json(res, 200, core.setOverrides(b.ids, b.category)); }
      if (P === '/api/transactions/delete' && METHOD === 'POST') { const b = await readBody(req); return json(res, 200, core.deleteTransactions(b.ids)); }
      if (P === '/api/transactions/restore' && METHOD === 'POST') { const b = await readBody(req); return json(res, 200, core.restoreTransactions(b.batch || null)); }
      if (P === '/api/transactions/deleted' && METHOD === 'GET') return json(res, 200, core.deletedBatches());
      if (P === '/api/override' && METHOD === 'POST') { const b = await readBody(req); core.setOverride(b.id, b.category); return json(res, 200, {}); }
      if (P === '/api/review/assign-many' && METHOD === 'POST') return json(res, 200, core.assignMerchants((await readBody(req)).items));
      if (P === '/api/review/assign' && METHOD === 'POST') { const b = await readBody(req); core.assignMerchant(b.merchant, b.category); return json(res, 200, {}); }

      // ----- sample data (first run) -----
      if (P === '/api/demo/load' && METHOD === 'POST') { if (!demo.isEmpty()) throw HttpError(409, 'You already have data. Sample data can only be loaded into an empty Pennystead.'); return json(res, 200, demo.generate()); }
      if (P === '/api/demo/clear' && METHOD === 'POST') { if (!demo.isDemo()) throw HttpError(409, 'Only sample data can be cleared from here.'); demo.clear(); return json(res, 200, {}); }

      // ----- connections (credentials entered in the UI) -----
      if (P === '/api/settings' && METHOD === 'GET') return json(res, 200, { ...settings.status(), redirectUrl: redirectUrl(), relayUrl: RELAY, redirectFromEnv: !!process.env.REDIRECT_URL, connectPending: !!pendingState, googleRedirectUrl: GOOGLE_REDIRECT });
      const sm = P.match(/^\/api\/settings\/(enablebanking|alphavantage|google|openrouter)$/);
      if (sm && METHOD === 'PUT') { const b = await readBody(req); ({ enablebanking: settings.setEnableBanking, alphavantage: () => settings.setAlphaVantage(b.apiKey), google: settings.setGoogle, openrouter: settings.setOpenRouter })[sm[1]](b); return json(res, 200, settings.status()); }
      if (sm && METHOD === 'DELETE') { settings.clear(sm[1]); return json(res, 200, settings.status()); }
      if (P === '/api/settings/base' && METHOD === 'POST') { const b = await readBody(req); return json(res, 200, b.keep ? core.confirmBase() : core.setBase(b.base)); }
      if (P === '/api/settings/test-bank' && METHOD === 'POST') {
        const r = await eb('GET', '/aspsps?country=FI&psu_type=personal').catch((e) => { throw HttpError(400, `Enable Banking rejected these credentials: ${e.message}`); });
        return json(res, 200, { ok: true, banks: (r.aspsps || []).length });
      }
      if (P === '/api/quit' && METHOD === 'POST') {
        if (!PACKAGED && process.env.PENNYSTEAD_ALLOW_QUIT !== '1') throw HttpError(403, 'Quit is only available in the installed app.');
        json(res, 200, { ok: true }); setTimeout(() => process.exit(0), 200); return;
      }
      // ----- updates -----
      if (P === '/api/update' && METHOD === 'GET') return json(res, 200, q.refresh || !updater.status() ? await updater.check() : updater.status());
      if (P === '/api/update/auto' && METHOD === 'POST') { updater.setAuto((await readBody(req)).on === true); return json(res, 200, { auto: updater.auto() }); }
      if (P === '/api/update/install' && METHOD === 'POST') {
        const r = await updater.install().catch((e) => { throw HttpError(400, e.message); });
        json(res, 200, { ok: true, ...r });
        setTimeout(() => process.exit(0), 300); // the new version takes over the port (and the open window reloads)
        return;
      }
      if (P === '/api/goals/checks') {
        if (METHOD === 'POST') return json(res, 200, goalChecks.run({ force: true }) || { none: true });
        const c = loadConfig();
        return json(res, 200, { checks: goalChecks.all(), unseen: goalChecks.unseen(), mode: c.goalChecks || 'monthly' });
      }
      if (P === '/api/goals/checks/mode' && METHOD === 'POST') { const { mode } = await readBody(req); if (!['monthly', 'off'].includes(mode)) throw HttpError(400, 'mode must be "monthly" or "off"'); const c = loadConfig(); c.goalChecks = mode; saveConfig(c); return json(res, 200, { mode }); }
      const cs = P.match(/^\/api\/goals\/checks\/(\d{4}-\d{2})\/seen$/);
      if (cs && METHOD === 'POST') { goalChecks.markSeen(cs[1]); return json(res, 200, {}); }
      if (P === '/api/goals') {
        if (METHOD === 'POST') return json(res, 200, goals.create(await readBody(req)));
        return json(res, 200, goals.list());
      }
      const gm = P.match(/^\/api\/goals\/([a-f0-9]{8})$/);
      if (gm && METHOD === 'PUT') return json(res, 200, goals.update(gm[1], await readBody(req)));
      if (gm && METHOD === 'DELETE') { goals.remove(gm[1]); return json(res, 200, {}); }
      if (P === '/api/mcp-prompts') return json(res, 200, require('./lib/prompts').list());
      if (P === '/api/mcp-config') {
        const custom = !!(process.env.PENNYSTEAD_DATA || process.env.DATA_DIR);
        const command = process.execPath, args = PACKAGED ? ['--mcp'] : [path.join(__dirname, 'mcp.js')];
        if (custom && PACKAGED) args.push('--data-dir', DATA_DIR);
        const env = !PACKAGED && custom ? { PENNYSTEAD_DATA: DATA_DIR } : undefined;
        const entry = { command, args, ...(env ? { env } : {}) };
        const q = (x) => (/[\s"]/.test(x) ? `"${x.replace(/"/g, '\\"')}"` : x);
        return json(res, 200, { command, args, desktop: JSON.stringify({ mcpServers: { pennystead: entry } }, null, 2), claudeCode: `claude mcp add pennystead -- ${[command, ...args].map(q).join(' ')}`, dataDir: DATA_DIR });
      }
      if (P === '/api/window') {
        if (METHOD === 'POST') { const { mode } = await readBody(req); if (!['app', 'browser'].includes(mode)) throw HttpError(400, 'mode must be "app" or "browser"'); const c = loadConfig(); c.window = mode; saveConfig(c); }
        return json(res, 200, { mode: loadConfig().window, browser: require('./lib/window').find()?.name || null });
      }
      if (P === '/api/autostart') { if (METHOD === 'POST') return json(res, 200, autostart.set((await readBody(req)).enabled)); return json(res, 200, autostart.status()); }

      // ----- bank connection -----
      if (P === '/api/banks') {
        const r = await eb('GET', `/aspsps?country=${encodeURIComponent(q.country || 'FI')}&psu_type=personal`);
        return json(res, 200, (r.aspsps || []).map((b) => ({ name: b.name, country: b.country })));
      }
      if (P === '/api/connect' && METHOD === 'POST') {
        notInDemo();
        const { name, country } = await readBody(req);
        pendingState = `${port}-${crypto.randomUUID()}`; // the relay page reads the port from here
        const r = await eb('POST', '/auth', { access: { valid_until: new Date(Date.now() + CONSENT_DAYS * 864e5).toISOString() }, aspsp: { name, country }, state: pendingState, redirect_url: redirectUrl(), psu_type: 'personal' });
        return json(res, 200, { url: r.url });
      }
      if (P === '/callback') {
        notInDemo();
        try { await finishConnect(q); } catch (e) { return send(res, e.status || 500, `${e.message}`, 'text/plain; charset=utf-8'); }
        res.writeHead(302, security.headers({ Location: '/#/banks' })); return res.end();
      }
      // Fallback when the bank's page does not bring you back: paste the address it ended on.
      if (P === '/api/connect/finish' && METHOD === 'POST') {
        notInDemo();
        const raw = String((await readBody(req)).url || '').trim();
        let params;
        try { params = new URLSearchParams(raw.includes('?') ? raw.slice(raw.indexOf('?') + 1).split('#')[0] : raw); } catch { throw HttpError(400, 'That does not look like the address from your bank.'); }
        await finishConnect(Object.fromEntries(params));
        return json(res, 200, { ok: true });
      }
      if (P === '/api/connect/redirect' && METHOD === 'POST') {
        const { url } = await readBody(req), c = loadConfig();
        if (url && !/^https:\/\/[^\s]+$/.test(url) && url !== LOCAL_CALLBACK) throw HttpError(400, 'The redirect address must start with https:// (Enable Banking does not accept http).');
        c.bankRedirect = url || null; saveConfig(c);
        return json(res, 200, { redirectUrl: redirectUrl() });
      }
      if (P === '/api/sync' && METHOD === 'POST') { notInDemo(); const b = await readBody(req).catch(() => ({})); return json(res, 200, await runSync({ full: b?.full === true })); }
      if (P === '/api/prices' && METHOD === 'POST') return json(res, 200, await updatePrices());
      if (P === '/api/disconnect' && METHOD === 'POST') { fs.rmSync(paths.session, { force: true }); return json(res, 200, {}); }

      // ----- import -----
      if (P === '/api/import/upload' && METHOD === 'POST') return json(res, 200, importer.upload(await readRaw(req, 31e6), decodeURIComponent(req.headers['x-filename'] || 'upload.csv')));
      if (P === '/api/import/reparse' && METHOD === 'POST') { const b = await readBody(req); return json(res, 200, importer.reparse(b.importId, b)); }
      if (P === '/api/import/preview' && METHOD === 'POST') { const b = await readBody(req); return json(res, 200, importer.preview(b.importId, b.mapping, b.account, b.options || {})); }
      if (P === '/api/import/commit' && METHOD === 'POST') { notInDemo(); const b = await readBody(req); return json(res, 200, importer.commit(b.importId, b.mapping, b.account, b.options || {})); }
      if (P === '/api/import/ai-map' && METHOD === 'POST') { const b = await readBody(req); return json(res, 200, await importer.aiMapping(b.importId).catch((e) => { throw HttpError(400, e.message); })); }
      if (P === '/api/import/ai-categories' && METHOD === 'POST') { const b = await readBody(req); return json(res, 200, await importer.aiCategories(b.importId, b.mapping, b.account, b.options || {}).catch((e) => { throw HttpError(400, e.message); })); }
      // ----- AI (OpenRouter) -----
      if (P === '/api/ai/test' && METHOD === 'POST') return json(res, 200, await llm.test().catch((e) => { throw HttpError(400, e.message); }));
      if (P === '/api/ai/chat' && METHOD === 'POST') { const b = await readBody(req); return json(res, 200, await llm.chat(b.messages, b.memory || {}).catch((e) => { throw HttpError(400, e.message); })); }
      if (P === '/api/ai/prompts' && METHOD === 'GET') return json(res, 200, require('./lib/prompts').list().map((x) => ({ ...x, text: require('./lib/prompts').get(x.name).messages[0].content.text })));
      if (P === '/api/import/history' && METHOD === 'GET') return json(res, 200, importer.history());
      if (P === '/api/import/undo' && METHOD === 'POST') return json(res, 200, importer.undo((await readBody(req)).id));

      // ----- backups -----
      if (P === '/oauth/google/callback') {
        let dest = '/#/backups';
        try { if (q.error) throw new Error(q.error); await gdrive.finishAuth(q.code, q.state); backup.updateConfig({ drive: { enabled: true } }); }
        catch (e) { dest = '/#/backups?gerr=' + encodeURIComponent(e.message); }
        res.writeHead(302, security.headers({ Location: dest })); return res.end();
      }
      if (P === '/api/backup' && METHOD === 'GET') return json(res, 200, await backup.status());
      if (P === '/api/backup/config' && METHOD === 'PUT') return json(res, 200, backup.updateConfig(await readBody(req)));
      if (P === '/api/backup/run' && METHOD === 'POST') return json(res, 200, await backup.runBackup({ force: true }));
      if (P === '/api/backup/passphrase' && METHOD === 'POST') { backup.setPassphrase((await readBody(req)).passphrase ?? null); return json(res, 200, {}); }
      if (P === '/api/backup/drive' && METHOD === 'GET') return json(res, 200, await gdrive.list());
      if (P === '/api/export.xlsx' && METHOD === 'GET') {
        const buf = await require('./lib/export').workbook();
        res.writeHead(200, security.headers({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="pennystead-${require('./lib/dates').today()}.xlsx"` }));
        return res.end(buf);
      }
      if (P === '/api/backup/download' && METHOD === 'GET') {
        if (!/^(pennystead|pre-restore)-[\w.-]+\.bak(\.enc)?$/.test(q.name || '')) throw HttpError(400, 'Invalid name');
        const f = path.join(backup.localDir(), q.name);
        if (!fs.existsSync(f)) throw HttpError(404, 'Not found');
        res.writeHead(200, security.headers({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${q.name}"` }));
        return res.end(fs.readFileSync(f));
      }
      if (P === '/api/backup/restore' && METHOD === 'POST') { const b = await readBody(req); return json(res, 200, b.source === 'drive' ? await backup.restoreDrive(b.id, b.passphrase) : backup.restoreLocal(b.name, b.passphrase)); }
      if (P === '/api/backup/restore-upload' && METHOD === 'POST') return json(res, 200, backup.applyBackup(await readRaw(req), req.headers['x-passphrase'] || undefined));
      if (P === '/api/backup/google/connect' && METHOD === 'GET') return json(res, 200, { url: gdrive.beginAuth(GOOGLE_REDIRECT) });
      if (P === '/api/backup/google/disconnect' && METHOD === 'POST') { backup.updateConfig({ drive: { enabled: false } }); await gdrive.disconnect(); return json(res, 200, {}); }

      // ----- manual assets -----
      const m = P.match(/^\/api\/manual(?:\/([a-z0-9-]+)(?:\/(value|close|reopen)(?:\/(\d{4}-\d{2}-\d{2}))?)?)?$/);
      if (m) {
        const [, id, sub, date] = m, body = METHOD === 'GET' || METHOD === 'DELETE' ? {} : await readBody(req);
        let out;
        if (!id && METHOD === 'POST') { notInDemo(); out = manual.create(body, loadConfig().base); }
        else if (id && !sub && METHOD === 'PATCH') out = manual.update(id, body);
        else if (id && !sub && METHOD === 'DELETE') manual.remove(id);
        else if (id && sub === 'value' && METHOD === 'POST') out = manual.record(id, body);
        else if (id && sub === 'value' && METHOD === 'DELETE' && date) out = manual.removeValuation(id, date);
        else if (id && sub === 'close' && METHOD === 'POST') out = manual.close(id, body.date);
        else if (id && sub === 'reopen' && METHOD === 'POST') out = manual.reopen(id);
        else throw HttpError(405, 'Unsupported');
        J.writeDerived();
        return json(res, 200, out || {});
      }

      // ----- static UI -----
      if (METHOD === 'GET' || METHOD === 'HEAD') {
        const a = assets.get(P === '/' ? 'index.html' : P);
        if (a) return send(res, 200, a.body, a.type);
      }
      send(res, 404, 'Not found', 'text/plain');
    } catch (e) {
      json(res, e.status || (e.constructor === Error && !e.data ? 400 : 500), { error: e.message });
    }
  });

  // Keep data fresh: sync on start and every 6 hours while connected; scheduled backups every 10 minutes.
  const timers = [];
  const tick = () => hasSession() && runSync().catch((e) => console.error('sync failed:', e.message));
  // The monthly goal check: hourly is enough to catch the first run of a new month; it does nothing otherwise.
  const gtick = () => { try { goalChecks.run(); } catch (e) { console.error('goal check failed:', e.message); } };
  // Updates: one anonymous request to GitHub shortly after start and every 12 hours, unless turned off. Installed app only.
  const utick = () => PACKAGED && updater.auto() && updater.check().catch(() => {});
  if (PACKAGED) updater.cleanup();
  const btick = () => backup.runBackup().then((r) => r.filter((x) => x.error).forEach((x) => console.error(`backup (${x.dest}) failed: ${x.error}`))).catch((e) => console.error('backup failed:', e.message));

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      timers.push(setInterval(tick, 6 * 3600e3), setInterval(btick, 10 * 60e3), setTimeout(btick, 30e3), setTimeout(tick, 1000), setInterval(gtick, 3600e3), setTimeout(gtick, 60e3), setTimeout(utick, 20e3), setInterval(utick, 12 * 3600e3));
      timers.forEach((t) => t.unref());
      resolve({ server, port, host, url: `http://localhost:${port}`, stop: () => new Promise((r) => { timers.forEach(clearTimeout); server.close(() => r()); server.closeAllConnections?.(); }) });
    });
  });
}

module.exports = { start };
if (require.main === module) start().then((s) => console.log(`Pennystead: ${s.url}  (data: ${DATA_DIR})`)).catch((e) => { console.error(e.message); process.exit(1); });
