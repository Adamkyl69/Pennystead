// Privacy filter for data leaving this machine via MCP.
// REDACT=light (default): mask IBANs, emails and long digit runs.
// REDACT=full: additionally pseudonymize merchant/payee names (stable per run) and disable raw hledger access.
// REDACT=off: no filtering.
const crypto = require('crypto');
const mode = (process.env.REDACT || 'light').toLowerCase();
const salt = crypto.randomBytes(8).toString('hex');
const names = new Map();
const NAME_KEYS = new Set(['desc', 'merchant', 'name', 'creditor', 'debtor', 'counterparty', 'key', 'payee', 'label']);

const mask = (s) => s
  // IBANs in any case, with or without the spaces they are usually printed with.
  .replace(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/gi, (m) => `IBAN…${m.replace(/ /g, '').slice(-4)}`)
  .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
  // Card and account numbers, also when grouped ("4111 1111 1111 1111", "1234-5678-9012").
  .replace(/\b\d{4}(?:[ -]\d{4}){2,4}\b/g, (m) => `…${m.slice(-4)}`)
  .replace(/\b\d{8,}\b/g, (m) => `…${m.slice(-4)}`);
const alias = (s) => { if (!names.has(s)) names.set(s, 'Merchant-' + crypto.createHash('sha1').update(salt + s).digest('hex').slice(0, 5)); return names.get(s); };

function redact(v, key) {
  if (mode === 'off') return v;
  if (typeof v === 'string') return mode === 'full' && NAME_KEYS.has(key) ? alias(v) : mask(v);
  if (Array.isArray(v)) return v.map((x) => redact(x, key));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x, k)]));
  return v;
}
module.exports = { redact, mode };
