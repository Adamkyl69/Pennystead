// The MCP protocol (JSON-RPC) shared by both ways in: stdin/stdout (`Pennystead --mcp`, see mcp.js) and the optional
// local HTTP address (POST /mcp with a token, Settings → MCP server).
const prompts = require('./prompts');
const tools = require('./tools');

const INSTRUCTIONS = 'Private personal finance data from Pennystead. Amounts: negative = money out. Base currency is in net_worth/overview. Internal transfers between the person\'s own accounts are not spending or income.';

/** Answers one JSON-RPC message; null for a notification (nothing to send back). */
async function handle(msg, { write = false } = {}) {
  if (!msg || typeof msg !== 'object') return null; // not a JSON-RPC message
  const { id, method, params } = msg;
  if (id === undefined) return null; // notification
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  try {
    if (method === 'initialize') return ok({ protocolVersion: params?.protocolVersion || '2025-03-26', capabilities: { tools: {}, prompts: {} }, serverInfo: { name: 'pennystead', version: require('./version') }, instructions: INSTRUCTIONS });
    if (method === 'ping') return ok({});
    if (method === 'prompts/list') return ok({ prompts: prompts.list() });
    if (method === 'prompts/get') return ok(prompts.get(params?.name, params?.arguments));
    if (method === 'tools/list') return ok({ tools: tools.list({ write }).map(({ name, description, inputSchema, write: w }) => ({ name, description, inputSchema, annotations: { readOnlyHint: !w } })) });
    if (method === 'tools/call') {
      try {
        const res = await tools.call(params.name, params.arguments || {}, { write });
        return ok({ content: [{ type: 'text', text: JSON.stringify(res) }] });
      } catch (e) { return ok({ isError: true, content: [{ type: 'text', text: e.message }] }); }
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
  } catch (e) { return { jsonrpc: '2.0', id, error: { code: -32603, message: e.message } }; }
}

module.exports = { handle };
