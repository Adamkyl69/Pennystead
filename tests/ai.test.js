const { dir } = require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

// A fake OpenRouter. Each test sets `reply` to decide what the "model" answers; every request body is kept.
let reply = null, status = 200;
const seen = [];
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const body = JSON.parse(b); seen.push({ body, auth: req.headers.authorization });
    res.writeHead(status, { 'Content-Type': 'application/json' });
    if (status !== 200) return res.end(JSON.stringify({ error: { code: status, message: status === 401 ? 'No auth credentials found' : 'boom' } }));
    const msg = typeof reply === 'function' ? reply(body) : reply;
    res.end(JSON.stringify({ model: body.model, choices: [{ message: msg }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
});

let settings, llm, imp, core, demo;
test.before(async () => {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.PENNYSTEAD_LLM_URL = `http://127.0.0.1:${srv.address().port}/v1/chat/completions`;
  settings = require('../lib/settings'); llm = require('../lib/llm'); imp = require('../lib/importer'); core = require('../lib/core'); demo = require('../lib/demo');
  demo.generate();
  assert.ok(dir);
});
test.after(() => srv.close());

test('settings: key and model are checked, the key is never shown, the model keeps OpenRouter suffixes', () => {
  assert.throws(() => settings.setOpenRouter({ apiKey: 'sk-or-v1-abcdef123456', model: 'claude haiku' }), /model/);
  assert.throws(() => settings.setOpenRouter({ apiKey: '', model: 'anthropic/claude-haiku-4.5' }), /API key/);
  assert.throws(() => settings.setOpenRouter({ apiKey: 'sk-or-v1-abcdef123456', model: 'anthropic/claude-haiku-5.5:batch' }), /batch service.*anthropic\/claude-haiku-5\.5$/);
  settings.setOpenRouter({ apiKey: 'sk-or-v1-abcdef123456', model: 'anthropic/claude-haiku-5.5:nitro' });
  assert.deepEqual(settings.status().openrouter, { configured: true, model: 'anthropic/claude-haiku-5.5:nitro', source: 'saved' });
  assert.ok(!JSON.stringify(settings.status()).includes('abcdef123456'));
  settings.setOpenRouter({ apiKey: '', model: 'anthropic/claude-haiku-4.5' }); // empty key keeps the saved one
  assert.equal(settings.openRouter().apiKey, 'sk-or-v1-abcdef123456');
});

test('chat: the model calls Pennystead tools, gets real (masked) data back, and answers', async () => {
  seen.length = 0;
  reply = (body) => (body.messages.some((m) => m.role === 'tool')
    ? { role: 'assistant', content: 'Your net worth is **175,590 EUR**.' }
    : { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'net_worth', arguments: '{}' } }] });
  const r = await llm.chat([{ role: 'user', content: 'What is my net worth?' }]);
  assert.match(r.reply, /net worth/);
  assert.deepEqual(r.steps.map((s) => s.tool), ['net_worth']);
  assert.equal(seen[0].auth, 'Bearer sk-or-v1-abcdef123456');
  assert.equal(seen[0].body.model, 'anthropic/claude-haiku-4.5');
  assert.ok(seen[0].body.tools.some((t) => t.function.name === 'search_transactions'));
  assert.ok(!seen[0].body.tools.some((t) => t.function.name === 'record_valuation'), 'read-only');
  const toolMsg = seen[1].body.messages.find((m) => m.role === 'tool');
  assert.equal(JSON.parse(toolMsg.content).netWorth, (await core.wealth()).netWorth);
});

test('chat: a tool error goes back to the model instead of failing; API errors become plain advice', async () => {
  reply = (body) => (body.messages.some((m) => m.role === 'tool') ? { role: 'assistant', content: 'That tool failed.' } : { role: 'assistant', content: '', tool_calls: [{ id: 'x', type: 'function', function: { name: 'no_such_tool', arguments: '{bad json' } }] });
  const r = await llm.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(r.steps[0].ok, false);
  status = 401;
  await assert.rejects(llm.chat([{ role: 'user', content: 'hi' }]), /Check the API key/);
  status = 200;
  await assert.rejects(llm.chat([]), /Ask a question/);
});

test('import: AI reads a messy statement (title rows, split debit/credit, comma decimals) and the preview is right', async () => {
  const file = Buffer.from([
    'Nordbank Oyj;;;;;',
    'Account statement;FI21 1234 5600 0007 85;;;;',
    'Period 1.9.2026 - 30.9.2026;;;;;',
    ';;;;;',
    'Kirjauspäivä;Arvopäivä;Saaja/Maksaja;Pano;Otto;Saldo',
    '02.09.2026;02.09.2026;PALKKA ACME OY;3 400,00;;5 400,00',
    '03.09.2026;03.09.2026;K-MARKET KAMPPI;;45,20;5 354,80',
    '05.09.2026;04.09.2026;HSL MOBIILI;;3,10;5 351,70',
    '06.09.2026;06.09.2026;ALKO KAMPPI;;21,90;5 329,80',
    ';;Yhteensä;3 400,00;70,20;',
  ].join('\n'));
  const d = imp.upload(file, 'nordbank.csv');
  seen.length = 0;
  reply = { role: 'assistant', content: 'Here you go:\n{"sheet": null, "headerRow": 5, "date": "A", "desc": "C", "message": null, "mode": "split", "amount": null, "debit": "E", "credit": "D", "direction": null, "invert": false, "currency": null, "category": null, "balance": "F", "decimal": ",", "dateFormat": "DMY", "notes": "Finnish statement: Pano is money in, Otto is money out."}' };
  const m = await imp.aiMapping(d.importId);
  const prompt = seen[0].body.messages[1].content;
  assert.ok(!prompt.includes('5600 0007 85'), 'the IBAN is masked before it is sent');
  assert.match(prompt, /K-MARKET KAMPPI/);
  assert.equal(m.headerRow, 5); assert.equal(m.mapping.mode, 'split'); assert.equal(m.mapping.debit, 4); assert.equal(m.mapping.credit, 3);
  assert.match(m.ai.notes, /Pano/);
  const p = imp.preview(d.importId, m.mapping, { name: 'Nordbank', currency: 'EUR' }, {});
  assert.equal(p.counts.toImport, 4);
  assert.deepEqual([p.totals.in, p.totals.out], [3400, 70.2]);
  assert.ok(p.balanceCheck.ok, 'amounts agree with the file\'s own balance column');
});

test('import: AI categorizes merchants the rules do not know, only into existing categories, and it is saved', async () => {
  const file = Buffer.from('Date,Payee,Amount\n2026-09-02,ZORBLAX OY HELSINKI,-6.50\n2026-09-03,QWERTY GADGETS,-120.00\n2026-09-04,MYSTERY CO,-9.99\n2026-09-05,FREELANCE CLIENT AB,800.00\n');
  const d = imp.upload(file, 'misc.csv'), acct = { name: 'Spare', currency: 'EUR' };
  const before = imp.preview(d.importId, d.mapping, acct, {});
  assert.equal(before.uncategorized, 4);
  seen.length = 0;
  reply = { role: 'assistant', content: JSON.stringify({ categories: { 'ZORBLAX OY HELSINKI': 'expenses:food:restaurants', 'QWERTY GADGETS': 'expenses:made-up', 'MYSTERY CO': null, 'FREELANCE CLIENT AB': 'expenses:shopping' } }) };
  const r = await imp.aiCategories(d.importId, d.mapping, acct);
  assert.deepEqual(r, { categorized: 1, asked: 4 }, 'invented categories and wrong directions are refused');
  assert.ok(!/-6\.50|120/.test(seen[0].body.messages[1].content), 'amounts are not sent for categorizing');
  const after = imp.preview(d.importId, d.mapping, acct, {});
  assert.equal(after.aiCategorized, 1);
  assert.equal(after.sample.find((x) => x.desc.startsWith('ZORBLAX')).category, 'expenses:food:restaurants');
  imp.commit(d.importId, d.mapping, acct);
  const t = (await core.transactions()).find((x) => x.desc.startsWith('ZORBLAX'));
  assert.equal(t.category, 'expenses:food:restaurants');
});

test('every tool the AI can call actually runs', async () => {
  const tools = require('../lib/tools');
  for (const t of tools.list()) {
    if (t.name === 'hledger_query') continue;
    const out = await tools.call(t.name, t.name === 'net_worth_history' ? { range: '3M' } : {});
    assert.ok(out != null, t.name);
  }
});
