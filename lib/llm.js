// AI through OpenRouter (your own key, any model it offers): chat with your data, read messy import files, categorize.
// What leaves this computer: your question, and what the model asks Pennystead's read-only tools for (account numbers
// and card numbers masked). For imports: the first rows of the file. For categories: merchant names and amounts' signs.
const settings = require('./settings');
const tools = require('./tools');
const { loadConfig } = require('./config');
const { today } = require('./dates');

const URL_ = () => process.env.PENNYSTEAD_LLM_URL || 'https://openrouter.ai/api/v1/chat/completions';
const MAX_ROUNDS = 10, MAX_TOOL_CHARS = 40000;

function configured() { return !!settings.openRouter(); }

/** One OpenRouter call. Returns the assistant message ({ content, tool_calls }) and usage. */
async function complete(messages, { tools: fns, temperature, maxTokens = 4000, timeout = 120000 } = {}) {
  const cfg = settings.openRouter();
  if (!cfg) throw new Error('AI is not set up yet. Add your OpenRouter API key and model under Settings → Connections.');
  const body = { model: cfg.model, messages, max_tokens: maxTokens };
  if (temperature != null) body.temperature = temperature;
  if (fns?.length) { body.tools = fns; body.tool_choice = 'auto'; }
  let r;
  try {
    r = await fetch(URL_(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://github.com/Adamkyl69/Pennystead', 'X-Title': 'Pennystead' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
    });
  } catch (e) { throw new Error(e.name === 'TimeoutError' ? 'The AI took too long to answer. Try again, or pick a faster model.' : `Could not reach OpenRouter: ${e.message}`); }
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = null; }
  if (!r.ok || data?.error) {
    const msg = data?.error?.message || text.slice(0, 200) || r.statusText;
    const hint = /batch/i.test(msg) && /:batch$/i.test(cfg.model) ? ` Remove ":batch" from the model name under Settings → Connections (use ${cfg.model.replace(/:batch$/i, '')}).` : r.status === 401 ? ' Check the API key under Settings → Connections.' : r.status === 402 ? ' Your OpenRouter account is out of credit.' : r.status === 404 || /model/i.test(msg) ? ` Check the model name ("${cfg.model}") on openrouter.ai/models.` : r.status === 429 ? ' Too many requests; wait a moment.' : '';
    throw new Error(`OpenRouter: ${msg}.${hint}`);
  }
  const choice = data?.choices?.[0];
  if (!choice?.message) throw new Error('OpenRouter returned no answer.');
  return { message: choice.message, usage: data.usage || null, model: data.model || cfg.model };
}

/** Checks the key and model with a tiny request. */
async function test() {
  const r = await complete([{ role: 'user', content: 'Reply with the single word OK.' }], { maxTokens: 20, timeout: 45000 });
  return { ok: true, model: r.model, reply: String(r.message.content || '').slice(0, 40) };
}

// ---------- chat with your data ----------
const toolDefs = () => tools.list().map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
const system = () => `You are the assistant inside Pennystead, a private personal-finance app. Today is ${today()}. ${loadConfig().base ? `The user's main currency is ${loadConfig().base}.` : 'The user has not set a main currency yet; give amounts with the currency shown in the data.'}
Answer questions about the user's own money using the tools: they read the user's real data (transactions, spending, budgets, subscriptions, goals, net worth). Always call tools for facts; never invent numbers. Amounts: negative = money out.\nFor totals, rankings and per-month figures use aggregate (exact, any data size) rather than adding up transactions yourself; to compare periods use compare_periods. When you do not know how the bank writes a merchant, find it with merchants first. search_transactions pages through rows (has_more/next_offset); fetch more pages only when the user needs the individual rows.
Be concise: short paragraphs or bullet points, a markdown table when comparing numbers, amounts with the currency. If the data cannot answer something, say so in one line. You cannot change anything in the app: for categories, point the user to the Review page; for imports, to Import.`;

const KEEP = 12, SUMMARIZE_AT = 24; // recent messages sent in full; older ones are folded into a running summary
const clean = (h) => (Array.isArray(h) ? h : []).filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim()).map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));

/**
 * Runs the model with the tools until it answers. history: the whole conversation as plain text turns
 * [{role:'user'|'assistant', content}]. A long conversation is not cut off: once it passes SUMMARIZE_AT messages, the older
 * part is summarized (memory.summary covers the first memory.upTo messages) and the client sends that back next time.
 * Returns { reply, steps: [{ tool, args, ok }], memory }.
 */
async function chat(history, memory = {}) { return tools.shared(() => chatInner(history, memory)); }
async function chatInner(history, memory) {
  const all = clean(history);
  let summary = typeof memory.summary === 'string' ? memory.summary.slice(0, 6000) : '', upTo = Math.min(Math.max(+memory.upTo || 0, 0), all.length);
  if (!summary) upTo = 0;
  if (all.length - upTo > SUMMARIZE_AT) {
    const fold = all.slice(upTo, all.length - KEEP);
    const { message } = await complete([{ role: 'system', content: 'Summarize this part of a conversation between a user and their personal-finance assistant for the assistant to remember: the questions asked, the key figures and conclusions found (with amounts and dates), and anything the user said about their plans or preferences. At most 250 words, plain bullet points.' },
      { role: 'user', content: (summary ? `Summary so far:\n${summary}\n\nThen:\n` : '') + fold.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n') }], { temperature: 0, maxTokens: 700 });
    summary = String(message.content || '').trim().slice(0, 6000); upTo = all.length - KEEP;
  }
  const turns = all.slice(upTo);
  if (!turns.length || turns[turns.length - 1].role !== 'user') throw new Error('Ask a question first.');
  const sys = system() + (summary ? `\n\nEarlier in this conversation (summary):\n${summary}` : '');
  const messages = [{ role: 'system', content: sys }, ...turns], steps = [], defs = toolDefs(), memoryOut = { summary, upTo };
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const { message } = await complete(messages, { tools: defs });
    const calls = message.tool_calls || [];
    if (!calls.length) return { reply: String(message.content || '').trim() || '(The model returned an empty answer.)', steps, memory: memoryOut };
    messages.push({ role: 'assistant', content: message.content || null, tool_calls: calls });
    for (const c of calls) {
      let args = {}, out, ok = true;
      try { args = c.function?.arguments ? JSON.parse(c.function.arguments) : {}; } catch { args = {}; }
      try { out = JSON.stringify(await tools.call(c.function?.name, args)); } catch (e) { ok = false; out = JSON.stringify({ error: e.message }); }
      if (out.length > MAX_TOOL_CHARS) out = out.slice(0, MAX_TOOL_CHARS) + '…(truncated: ask for a narrower date range or a smaller limit)';
      steps.push({ tool: c.function?.name, args, ok });
      messages.push({ role: 'tool', tool_call_id: c.id, content: out });
    }
  }
  // Too many rounds: ask for an answer with what it has.
  const { message } = await complete([...messages, { role: 'user', content: 'Answer now with what you have found.' }]);
  return { reply: String(message.content || '').trim(), steps, memory: memoryOut };
}

// ---------- structured answers (imports, categories) ----------
/** Asks for JSON and reads the first JSON object in the answer (models without a JSON mode still work). */
async function json(prompt, { maxTokens = 4000 } = {}) {
  const { message } = await complete([{ role: 'system', content: 'You turn messy bank data into structured JSON. Reply with one JSON object only, no prose, no code fences.' }, { role: 'user', content: prompt }], { temperature: 0, maxTokens });
  const s = String(message.content || ''), i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i < 0 || j <= i) throw new Error('The AI did not return a usable answer. Try again or pick another model.');
  try { return JSON.parse(s.slice(i, j + 1)); } catch { throw new Error('The AI answer was not valid JSON. Try again or pick another model.'); }
}

module.exports = { configured, complete, test, chat, json };
