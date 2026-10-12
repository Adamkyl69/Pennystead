// Category suggestions that learn from you, computed on this computer from your own categorized transactions.
//
// It learns which words point to which category: a word counts as evidence only when every merchant you have
// categorized that uses it is in the same category. "lidl" (always groceries) is evidence; "helsinki" (groceries,
// rent and shopping) is not. The first word of a merchant, usually the brand, weighs most: "LIDL 1234 ESPOO" matches
// "LIDL HELSINKI" on "lidl". A merchant sharing no such word gets no suggestion rather than a guess.
const { ascii } = require('./journal-text');

const STOP = new Set(['the', 'and', 'for', 'from', 'with', 'payment', 'purchase', 'card', 'pos', 'visa', 'mastercard', 'debit', 'credit', 'sepa', 'transfer', 'ref', 'www', 'com', 'net', 'org', 'ltd', 'inc', 'gmbh', 'llc', 'oyj', 'plc', 'online', 'eur', 'usd', 'gbp']);
const tokens = (text) => { const out = []; for (const w of ascii(text).toLowerCase().split(/[^a-z0-9]+/)) if (w.length >= 3 && !/^\d+$/.test(w) && !STOP.has(w) && !out.includes(w)) out.push(w); return out; };
const usable = (c) => /^(expenses|income):/.test(c) && !c.endsWith(':uncategorized');
const BRAND = 3, OTHER = 1;

/** Learn word → category evidence from transactions that already have a real category (one vote per merchant). */
function train(txs) {
  const words = new Map(); // word -> Map(category -> { merchants:Set, first:boolean, example })
  for (const t of txs) {
    if (!usable(t.category)) continue;
    tokens(t.desc || '').forEach((w, i) => {
      const byCat = words.get(w) || words.set(w, new Map()).get(w);
      const e = byCat.get(t.category) || byCat.set(t.category, { merchants: new Set(), first: false, example: t.desc }).get(t.category);
      e.merchants.add(t.merchant); if (i === 0) e.first = true;
    });
  }
  return { words };
}

/**
 * { category, confidence (0–1), because: an example you categorized } or null.
 * amount: negative for money out; an expense is never suggested an income category or the other way round.
 */
function suggest(model, text, amount) {
  const kind = amount < 0 ? 'expenses:' : 'income:', score = new Map(), why = new Map();
  let brand = false;
  tokens(text).forEach((w, i) => {
    const byCat = model.words.get(w);
    if (!byCat || byCat.size !== 1) return; // unseen, or used in more than one category: not evidence
    const [[category, e]] = byCat;
    if (!category.startsWith(kind)) return;
    const isBrand = i === 0 && e.first, weight = (isBrand ? BRAND : OTHER) * Math.min(3, e.merchants.size);
    score.set(category, (score.get(category) || 0) + weight);
    if (!why.has(category) || isBrand) why.set(category, e.example);
    if (isBrand) brand = true;
  });
  if (!score.size) return null;
  const [category, top] = [...score].reduce((a, b) => (b[1] > a[1] ? b : a)), total = [...score.values()].reduce((s, x) => s + x, 0);
  // Agreement between the clues, discounted when the brand word itself was never seen.
  const confidence = Math.round((top / total) * (brand ? 1 : 0.7) * 100) / 100;
  return { category, confidence, because: why.get(category) };
}

module.exports = { train, suggest, tokens };
