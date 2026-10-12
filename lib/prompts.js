// Guided reviews for Claude: MCP prompts that show up as one-click actions in Claude Desktop (the "+" menu → Pennystead).
// Each prompt tells Claude which Pennystead tools to call and what a useful answer looks like. They only read data.
const { today } = require('./dates');

const STYLE = 'Use amounts in my base currency, short sections with headings, and a table where it helps. Only state what the data shows; if something is missing (no budgets, too little history), say so in one line instead of guessing. End with at most 3 concrete actions, most valuable first.';
const prevMonth = (m) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 2, 1)); return d.toISOString().slice(0, 7); };

const PROMPTS = {
  monthly_review: {
    title: 'Monthly money review',
    description: 'How the month went: income, spending, savings rate, budgets, anything unusual, and what to do next.',
    arguments: [{ name: 'month', description: 'Month to review as YYYY-MM (default: last full month)', required: false }],
    text: ({ month }) => {
      const m = /^\d{4}-\d{2}$/.test(month || '') ? month : prevMonth(today().slice(0, 7));
      return `Do my monthly money review for ${m}.\n\nCall monthly_summary (12 months), spending_by_category for ${m} (from ${m}-01 to the month's last day) and for ${prevMonth(m)}, budget_status for ${m}, anomalies and subscriptions.\n\nCover:\n1. Headline: income, spending, amount saved and savings rate for ${m}, against ${prevMonth(m)} and the 3-month average.\n2. The 3 categories that changed most and why, if the transactions show it (use search_transactions to check).\n3. Budgets that went over or came close.\n4. Anything unusual worth a look.\n\n${STYLE}`;
    },
  },
  find_savings: {
    title: 'Find money I am wasting',
    description: 'Subscriptions, price increases, overlapping services and growing categories, with yearly savings.',
    arguments: [],
    text: () => `Find money I could save.\n\nCall subscriptions, anomalies, monthly_summary and spending_by_category for the last 90 days and for the 90 days before that.\n\nLook for: subscriptions that went up in price, overlapping services (several streaming or software subscriptions), costly ones, duplicate charges, and categories growing fastest. For each idea give the yearly saving in money. Rank by yearly saving and total it. Do not suggest cutting rent, utilities, insurance or loan payments.\n\n${STYLE}`,
  },
  budget_checkup: {
    title: 'Budget check-up',
    description: 'Which budgets are on track, which will run over, and budgets that need a new amount.',
    arguments: [],
    text: () => `Check my budgets for this month.\n\nCall budget_status (current month and the previous 3 months) and spending_by_category for the last 3 months.\n\nFor each budget: on track, at risk or over, with the projection for the month end. Point out budgets that are always far under (too generous) or always over (unrealistic), and suggest a new amount based on the last 3 months. Mention big spending categories that have no budget.\n\n${STYLE}`,
  },
  net_worth_report: {
    title: 'Net worth report',
    description: 'Where my net worth stands, how it changed this year, and what drove it.',
    arguments: [],
    text: () => `Give me a net worth report.\n\nCall net_worth, net_worth_history (range YTD and 1Y) and manual_assets.\n\nCover: total, liquid and illiquid net worth today; the change this year and over 12 months; what drove it (saving from income, investment gains or losses, changes in property, vehicle or pension values, debt paid down); and any asset whose value is old and should be updated.\n\n${STYLE}`,
  },
  tidy_categories: {
    title: 'Tidy up my categories',
    description: 'Merchants still uncategorized, with Pennystead\'s suggestions, to confirm in the app.',
    arguments: [],
    text: () => `Help me categorize my uncategorized merchants.\n\nCall review_queue. List each merchant with its total, Pennystead's suggested category and how sure it is. Where there is no suggestion, propose a category from my existing ones (from the list in review_queue) and say why. Then tell me to confirm them in Pennystead under Review: you cannot change categories yourself.\n\n${STYLE}`,
  },
};

const list = () => Object.entries(PROMPTS).map(([name, p]) => ({ name, title: p.title, description: p.description, arguments: p.arguments }));
function get(name, args = {}) {
  const p = PROMPTS[name];
  if (!p) throw new Error('Unknown prompt ' + name);
  return { description: p.description, messages: [{ role: 'user', content: { type: 'text', text: p.text(args || {}) } }] };
}
module.exports = { list, get, PROMPTS };
