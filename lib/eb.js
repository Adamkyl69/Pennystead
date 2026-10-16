// Enable Banking API client (JWT signed locally with your private key).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const settings = require('./settings');

const API = 'https://api.enablebanking.com';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function configured() { return !!settings.enableBanking(); }

function jwt() {
  const { appId, privateKey: key } = settings.enableBanking();
  const iat = Math.floor(Date.now() / 1000);
  const head = b64({ typ: 'JWT', alg: 'RS256', kid: appId });
  const body = b64({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat, exp: iat + 3600 });
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url');
  return `${head}.${body}.${sig}`;
}

async function eb(method, url, body) {
  if (!configured()) throw new Error('Enable Banking is not set up yet. Add your Application ID and private key under Settings → Connections.');
  const res = await fetch(API + url, {
    method,
    headers: { Authorization: `Bearer ${jwt()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw Object.assign(new Error(data.message || res.statusText), { status: res.status, data });
  return data;
}

/**
 * Every booked transaction since `from`. strategy 'longest' asks Enable Banking for as much history as the bank allows
 * (date_from is then only a hint). Pages can be empty and still carry a continuation key; a key seen twice ends the loop.
 */
async function allTransactions(uid, from, strategy) {
  const out = [], seen = new Set();
  let key;
  do {
    const q = new URLSearchParams({ date_from: from, transaction_status: 'BOOK' });
    if (strategy) q.set('strategy', strategy);
    if (key) q.set('continuation_key', key);
    const r = await eb('GET', `/accounts/${uid}/transactions?${q}`);
    out.push(...(r.transactions || []));
    seen.add(key);
    key = r.continuation_key;
  } while (key && !seen.has(key));
  return out;
}

module.exports = { eb, configured, allTransactions };
