// ---------- Overview ----------
/** "Prices are 12 days old" warning. On the Assets page it updates in place; elsewhere it links there. */
function staleBanner(w, id) {
  const s = w.stalePrices || [];
  if (!s.length) return '';
  const list = s.slice(0, 4).map((x) => `${esc(x.commodity)} (${x.days} days)`).join(', ') + (s.length > 4 ? ` and ${s.length - 4} more` : '');
  return `<div class="banner"><span class="warn">Old prices, so these values may be off: ${list}</span>${id ? `<a id="${id}">Update prices</a>` : '<a href="#/assets">Update prices →</a>'}</div>`;
}
const ov = { range: '1Y', flow: 12, tab: 'month' };
pages.overview = {
  title: 'Overview',
  async render(el) {
    if (!ST.hasData) return welcome(el);
    const [o, h] = await Promise.all([api('/api/overview'), api('/api/history?range=' + ov.range)]);
    const w = o.wealth, t = o.thisMonth, l = o.lastMonth;
    const ratio = (a, b) => (b ? `${Math.round((a / b) * 100)}% of last month` : '—');
    const parts = w.illiquidParts.map((p) => `${esc(p.name)} ${money(p.value)}`).join(', ');
    const first = h.net[0]?.value ?? 0, last = h.net[h.net.length - 1]?.value ?? 0, lf = h.liquid[0]?.value ?? 0, ll = h.liquid[h.liquid.length - 1]?.value ?? 0;
    const rangeName = { '1M': 'last month', '3M': 'last 3 months', YTD: 'this year', '1Y': 'last year', All: 'all time' }[ov.range];
    const tabs = { month: 'This month', recent: 'Recent transactions', accounts: `Accounts` };
    el.innerHTML = `
      ${ST.reviewCount ? `<div class="banner"><span>${ST.reviewCount} item${ST.reviewCount === 1 ? '' : 's'} need your review (unknown merchants, unusual charges)</span><a href="#/review">Review →</a></div>` : ''}
      ${staleBanner(w)}
      ${goalCheckBanner(ST.goalCheck)}
      <div class="kpis">
        ${kpi('Net worth', money(w.netWorth), `Illiquid ${money(w.illiquid)}`, `${parts || 'No illiquid assets'}${w.secured ? `, minus ${money(w.secured)} secured debt` : ''}`)}
        ${kpi('Liquid net worth', money(w.liquid), `Cash ${money(w.cash)} · investments ${money(w.investmentsValue + w.liquidManual)}`, w.unsecured ? `After ${money(w.unsecured)} owed` : 'No unsecured debt')}
        ${kpi('Spent this month', money(t.spend), ratio(t.spend, l.spend), `Last month: ${money(l.spend)}`)}
        ${kpi('Income this month', money(t.income), ratio(t.income, l.income), `Last month: ${money(l.income)}`)}
      </div>
      ${card('Net worth over time', `<span class="${last - first >= 0 ? 'good' : 'bad'}">${money(last - first, BASE, { sign: true })}</span> total, <span class="${ll - lf >= 0 ? 'good' : 'bad'}">${money(ll - lf, BASE, { sign: true })}</span> liquid ${rangeName}`, '<div class="chart" id="nw"></div><div id="nwl"></div>', seg('range', ['1M', '3M', 'YTD', '1Y', 'All'].map((x) => [x, x]), ov.range))}
      ${card('Cash flow', `Income, expenses and net per month · last ${ov.flow} months`, '<div class="chart" id="cf"></div>' + legend([{ name: 'Income', color: 'var(--s1)' }, { name: 'Expenses', color: 'var(--s2)' }, { name: 'Net', color: 'var(--text)' }]), seg('flow', [[12, 'Last 12 months'], [6, 'Last 6 months'], [3, 'Last 3 months']], ov.flow))}
      <div class="tabs">${seg('tab', Object.entries(tabs), ov.tab)}<a class="btn" href="#/spending">Spending details</a></div>
      <div class="tbl" id="tabBody"></div>`;
    const hasLiquid = h.liquid.length === h.net.length && h.liquid.length > 0;
    const series = [{ name: 'Net worth', color: 'var(--s1)', points: h.net.map((p) => ({ x: p.date, y: p.value })) }];
    if (hasLiquid) series.push({ name: 'Liquid net worth', color: 'var(--s2)', points: h.liquid.map((p) => ({ x: p.date, y: p.value })) });
    lineChart($('#nw', el), { series, fmtX: dayLabel });
    $('#nwl', el).innerHTML = legend(series.map((s) => ({ name: s.name, color: s.color })));
    flowChart($('#cf', el), { months: o.cashflow.slice(-ov.flow) });
    onSeg(el, 'range', (v) => { ov.range = v; go(); }); onSeg(el, 'flow', (v) => { ov.flow = +v; go(); }); onSeg(el, 'tab', (v) => { ov.tab = v; go(); });
    const body = $('#tabBody', el);
    if (ov.tab === 'month') {
      const max = Math.max(1, ...o.categories.map((c) => c.amount));
      body.innerHTML = o.categories.length ? `<table><thead><tr><th>Category</th><th style="width:40%"></th><th class="n">Spent</th><th class="n">Last month</th><th class="n">3-mo avg</th></tr></thead><tbody>${o.categories.map((c) => `<tr class="click" data-goto="#/spending?parent=${esc(c.key)}"><td>${esc(leaf(c.key))}</td><td><div class="track"><div class="fill" style="width:${(c.amount / max) * 100}%"></div></div></td><td class="n">${money(c.amount)}</td><td class="n muted">${money(c.last)}</td><td class="n muted">${money(c.avg)}</td></tr>`).join('')}</tbody></table>` : '<p class="empty" style="padding:16px">No spending this month.</p>';
    } else if (ov.tab === 'recent') body.innerHTML = txTable(o.recent.slice(0, 15), false);
    else body.innerHTML = `<table><thead><tr><th>Account</th><th>Number</th><th class="n">Balance</th></tr></thead><tbody>${o.accounts.map((a) => `<tr><td>${esc(a.name)}</td><td class="muted">${esc(a.account.split(':').pop())}</td><td class="n">${money(a.value)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">No bank accounts yet.</td></tr>'}</tbody></table>`;
  },
};

function welcome(el) {
  const tile = (title, text, action) => `<div class="card" style="margin:0;display:flex;flex-direction:column;gap:8px"><h2>${title}</h2><div class="muted" style="flex:1;font-size:13px">${text}</div>${action}</div>`;
  el.innerHTML = `<div style="max-width:1100px;margin:24px auto"><h1 style="font-size:24px;margin:0 0 6px">Welcome to Pennystead</h1>
    <p class="muted" style="margin:0 0 20px;font-size:14px">A private dashboard for your money. Everything stays on this computer. Pick how you want to start:</p>
    <div class="kpis" style="grid-template-columns:repeat(auto-fit,minmax(250px,1fr))">
      ${tile('Import a statement', 'Load a CSV or Excel export from your bank. The quickest way to see your own numbers; no account setup needed.', '<a class="btn primary" href="#/import">Import a file</a>')}
      ${tile('Connect your bank', 'Sync balances and transactions automatically (read-only) through Enable Banking. Needs a free developer account, about 10 minutes the first time.', '<a class="btn" href="#/connections">Set up bank sync</a>')}
      ${tile('Track assets by hand', 'Add property, a car, a pension or a loan and record its value whenever it changes.', '<a class="btn" href="#/assets">Add an asset</a>')}
      ${tile('Look around first', 'Fill Pennystead with made-up sample data to explore every page. You can clear it in one click.', '<button class="btn" id="loadDemo">Load sample data</button>')}</div>
    <p class="muted" style="font-size:12px;margin-top:20px">Tip: turn on encrypted <a href="#/backups">backups</a> early, and a <a href="#/security">password</a> if other people use this computer.</p></div>`;
  $('#loadDemo', el).onclick = async () => { await run(() => api('/api/demo/load', 'POST'), 'Sample data loaded'); go(); };
}

function txTable(rows, editable, cats = []) {
  return `<table><thead><tr><th>Date</th><th>Counterparty</th><th>Category</th>${editable ? '<th>Account</th>' : ''}<th class="n">Amount</th></tr></thead><tbody>${rows.map((x) => `<tr><td class="muted" style="white-space:nowrap">${esc(x.date)}</td><td>${esc(x.desc)}</td>
    <td>${editable ? `<select data-tx="${esc(x.id)}">${catOptions(cats, x.category)}</select>` : `<span class="muted">${esc(catLabel(x.category))}</span>`}</td>${editable ? `<td class="muted">${esc(x.account.split(':').pop())}</td>` : ''}
    <td class="n ${x.amount < 0 ? '' : 'good'}">${money2(x.amount, x.cur)}</td></tr>`).join('') || `<tr><td colspan="5" class="empty">Nothing here yet.</td></tr>`}</tbody></table>`;
}

// ---------- Spending ----------
const sp = { period: 'month', count: 12, group: 'category', account: '', parent: 'expenses', selected: null, recurring: false };
const COUNTS = { week: [[12, 'Last 12 weeks'], [26, 'Last 26 weeks']], month: [[6, 'Last 6 months'], [12, 'Last 12 months'], [24, 'Last 24 months']], quarter: [[4, 'Last 4 quarters'], [8, 'Last 8 quarters']], year: [[3, 'Last 3 years'], [5, 'Last 5 years']] };
pages.spending = {
  title: 'Spending',
  async render(el) {
    const q = new URLSearchParams((location.hash.split('?')[1] || ''));
    if (q.get('parent')) { sp.parent = q.get('parent'); sp.group = 'category'; sp.selected = null; history.replaceState(null, '', '#/spending'); }
    const r = await api('/api/spending?' + new URLSearchParams({ period: sp.period, count: sp.count, group: sp.group, account: sp.account, parent: sp.parent }));
    const sel = sp.selected && r.keys.includes(sp.selected) ? sp.selected : r.current, T = r.tables[sel];
    const pl = (k) => keyLabel(k, sp.period);
    const crumbs = sp.parent.split(':').map((s, i, a) => ({ key: a.slice(0, i + 1).join(':'), name: i === 0 ? 'All spending' : catLabel(a.slice(0, i + 1).join(':')).split(' › ').pop() }));
    const isUnc = (g) => g.key.endsWith(':uncategorized');
    const ranked = r.groups.filter((g) => !isUnc(g)), shown = [...ranked.slice(0, 6), ...r.groups.filter(isUnc)], color = {};
    ranked.slice(0, 6).forEach((g, i) => (color[g.key] = COLORS[i]));
    shown.filter(isUnc).forEach((g) => (color[g.key] = 'var(--other)'));
    const hasOther = ranked.length > 6, otherGroups = ranked.slice(6);
    const gs = shown.map((g) => ({ ...g, color: color[g.key], name: nameOf(g, r) }));
    if (hasOther) gs.push({ key: '__other', name: 'Other', color: 'var(--other)' });
    const buckets = r.buckets.map((b) => { const grp = { ...b.groups }; if (hasOther) { grp.__other = otherGroups.reduce((s, g) => s + (grp[g.key] || 0), 0); otherGroups.forEach((g) => delete grp[g.key]); } return { ...b, groups: grp }; });
    const accOpts = `<option value="">All accounts</option>${r.accounts.map((a) => `<option value="${esc(a)}" ${a === sp.account ? 'selected' : ''}>${esc(a.split(':').pop())}</option>`).join('')}`;
    const bud = T.budget;
    el.innerHTML = `
      <div class="bar">${seg('period', [['week', 'Week'], ['month', 'Month'], ['quarter', 'Quarter'], ['year', 'Year']], sp.period)}
        <select id="count">${COUNTS[sp.period].map(([v, l]) => `<option value="${v}" ${+v === +sp.count ? 'selected' : ''}>${l}</option>`).join('')}</select>
        ${seg('group', [['category', 'Category'], ['vendor', 'Vendor'], ['account', 'Account']], sp.group)}
        <select id="acc">${accOpts}</select><button class="btn ${sp.recurring ? 'primary' : ''}" id="rec">⟳ Recurring</button></div>
      ${sp.recurring ? '<div id="recBody"></div>' : `
      <div class="crumb">${crumbs.map((c, i) => (i < crumbs.length - 1 ? `<a data-crumb="${esc(c.key)}">${esc(c.name)}</a> › ` : esc(c.name))).join('')}</div>
      <div class="kpis" style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr))">
        ${kpi(`Spent · ${esc(pl(sel))}`, money(T.total), `${esc(crumbs[crumbs.length - 1].name)}`, `${T.rows.length} ${sp.group === 'vendor' ? 'vendors' : sp.group === 'account' ? 'accounts' : 'categories'} with spending`)}
        ${bud ? kpi(bud.over > 0 ? 'Over budget' : 'Under budget', money(Math.abs(bud.over)), `${bud.pct}% of ${money(bud.total)} used`, `${bud.overCount} over · ${money(bud.unbudgeted)} unbudgeted`, bud.over > 0 ? 'bad' : 'good') : kpi('Budget', '—', r.yearly.length ? 'No monthly budgets in this view' : 'No budgets in this view', r.yearly.length ? 'Yearly budgets are tracked below' : sp.group === 'category' ? 'Set one from the table below' : 'Budgets apply to the Category view')}
        ${kpi('vs 3-period average', T.vsAvg == null ? '—' : pct(T.vsAvg), T.vsAvg == null ? '' : T.vsAvg <= 0 ? 'Spending less' : 'Spending more', `Reference: ${money(T.avg3)}`, T.vsAvg > 0 ? 'bad' : 'good')}
      </div>
      ${card('Spending per period', `By ${sp.group} · click a bar to inspect that period`, '<div class="chart" id="sb"></div>' + legend(gs))}
      <h3 style="font-size:14px;margin:0 0 8px">${esc(pl(sel))} by ${sp.group}</h3>
      <div class="tbl"><table><thead><tr><th>Name</th><th class="n">Amount</th><th class="n">3-period avg</th><th style="width:22%">Budget</th><th class="n">vs prev</th><th class="n">vs avg</th><th class="n">Count</th></tr></thead><tbody>
      ${T.rows.map((x) => `<tr class="${x.drill ? 'click' : ''}" ${x.drill ? `data-drill="${esc(x.key)}"` : ''}><td><span class="sw" style="background:${color[x.key] || 'var(--other)'}"></span>${esc(nameOf(x, r))}${x.drill ? ' <span class="muted">›</span>' : ''}</td><td class="n">${money(x.amount)}</td><td class="n muted">${money(x.avg)}</td>
        <td>${sp.group === 'category' ? (x.budget ? `<div data-budget="${esc(x.key)}" data-amt="${x.budget.amount}" data-kind="${x.budget.kind}" style="cursor:pointer" title="Click to change">${budgetBar(x.budget)}</div>` : `<a class="muted" style="cursor:pointer" data-setbudget="${esc(x.key)}">+ Set budget</a>`) : ''}</td>
        <td class="n">${delta(x.vsPrev)}</td><td class="n">${delta(x.vsAvg)}</td><td class="n muted">${x.count}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No spending in this period.</td></tr>'}</tbody></table></div>
      ${yearlyCard(r.yearly)}
      ${card('Top vendors', `Last ${r.keys.length} ${sp.period}s`, `<table><tbody>${r.vendors.map((v) => `<tr><td>${esc(v.name)}<div class="muted" style="font-size:11px">${v.count} × avg ${money(v.avg)}</div></td><td>${sparkline(v.series)}</td><td class="n">${money(v.total)}</td></tr>`).join('') || '<tr><td class="empty">No vendors.</td></tr>'}</tbody></table>`)}`}`;
    onSeg(el, 'period', (v) => { sp.period = v; sp.count = COUNTS[v][Math.min(1, COUNTS[v].length - 1)][0]; sp.selected = null; go(); });
    onSeg(el, 'group', (v) => { sp.group = v; if (v !== 'category') sp.parent = 'expenses'; go(); });
    $('#count', el).onchange = (e) => { sp.count = +e.target.value; go(); };
    $('#acc', el).onchange = (e) => { sp.account = e.target.value; go(); };
    $('#rec', el).onclick = () => { sp.recurring = !sp.recurring; go(); };
    if (sp.recurring) return recurringView($('#recBody', el), r.recurring);
    stackedBars($('#sb', el), { buckets, groups: gs, selected: sel, labelOf: pl, onSelect: (k) => { sp.selected = k; go(); } });
    $$('[data-crumb]', el).forEach((a) => (a.onclick = () => { sp.parent = a.dataset.crumb; sp.group = 'category'; go(); }));
    $$('[data-drill]', el).forEach((tr) => (tr.onclick = (e) => { if (e.target.closest('[data-budget],[data-setbudget]')) return; sp.parent = tr.dataset.drill; go(); }));
    $$('[data-budget],[data-setbudget]', el).forEach((n) => (n.onclick = async (e) => {
      e.stopPropagation();
      const key = n.dataset.budget || n.dataset.setbudget;
      const prefill = n.dataset.kind === 'year' ? `${n.dataset.amt}/y` : n.dataset.amt && sp.period === 'month' ? n.dataset.amt : '';
      const v = prompt(`Budget for ${catLabel(key)} (${BASE}).\nMonthly by default; add "/y" for a yearly budget, e.g. 3000/y.\nLeave empty to remove.`, prefill);
      if (v === null) return;
      const parsed = v.trim() === '' ? { amount: null, period: 'month' } : parseBudget(v);
      if (!parsed) return toast('Use a number like 450, or 3000/y for yearly');
      await run(() => api('/api/budget', 'PUT', { category: key, ...parsed }), 'Budget saved'); go();
    }));
  },
};
const YSTAT = { over: ['over budget', 'bad'], on_track_to_exceed: ['on pace to exceed', 'warn'], warn: ['nearly used', 'warn'], ok: ['on track', 'good'] };
function yearlyCard(list) {
  if (!list.length) return '';
  return card(`Yearly budgets · ${esc((ST.today || '').slice(0, 4))}`, 'Year-to-date spending against the annual amount. The marker shows where you would be if spending were even through the year.',
    list.map((b) => {
      const max = Math.max(b.budget, b.spent, 1), st = YSTAT[b.status];
      return `<div style="margin-bottom:14px"><div class="row" style="justify-content:space-between"><span>${esc(catLabel(b.category))} <span class="pill ${st[1]}">${st[0]}</span></span><span class="${b.pct > 100 ? 'bad' : ''}">${money(b.spent)} / ${money(b.budget)}</span></div>
        <div class="track" style="margin:6px 0 4px"><div class="fill ${b.pct > 100 ? 'over' : ''}" style="width:${Math.min(100, (b.spent / max) * 100)}%"></div><div class="pace" title="Even pace: ${money(b.pace)}" style="left:${Math.min(99.5, (b.pace / max) * 100)}%"></div></div>
        <div class="muted" style="font-size:12px">${b.remaining >= 0 ? `${money(b.remaining)} left` : `${money(-b.remaining)} over`} · even pace ${money(b.pace)} · projected year-end ${money(b.projected)}</div></div>`;
    }).join(''));
}
const nameOf = (g, r) => (r.group === 'category' ? leaf(g.key) || 'Other' : r.group === 'account' ? g.key.split(':').pop() : g.name);

function recurringView(el, s) {
  const flag = { price_increase: ['price up', 'warn'], new: ['new', ''], duplicate_charge: ['duplicate charge', 'bad'], overlap: ['overlaps similar subs', 'warn'], expensive: ['costly', 'warn'] };
  const row = (x) => `<tr><td>${esc(x.merchant)}<div>${x.flags.map((f) => `<span class="pill ${flag[f]?.[1] || ''}" style="margin-right:4px">${esc(flag[f]?.[0] || f)}</span>`).join('')}</div></td><td class="muted">${esc(catLabel(x.category))}</td><td>${esc(x.period)}</td><td class="n">${money2(x.amount)}</td><td class="n">${money(x.perYear)}</td><td class="muted">${esc(x.nextExpected || 'lapsed')}</td></tr>`;
  const table = (rows) => `<div class="tbl"><table><thead><tr><th>Service</th><th>Category</th><th>Every</th><th class="n">Charge</th><th class="n">Per year</th><th>Next</th></tr></thead><tbody>${rows.map(row).join('')}</tbody></table></div>`;
  el.innerHTML = `<div class="kpis">${kpi('Subscriptions / month', money(s.monthlyTotal), `${s.active.length} active`, '')}${kpi('Subscriptions / year', money(s.yearlyTotal), '', '')}${kpi('Fixed bills', money(s.bills.reduce((a, b) => a + b.perMonth, 0)), `${s.bills.length} detected`, 'rent, utilities, insurance…')}</div>
    <h3 style="font-size:14px;margin:0 0 8px">Subscriptions</h3>${s.active.length ? table(s.active) : '<p class="empty">None detected yet.</p>'}
    ${s.bills.length ? `<h3 style="font-size:14px;margin:0 0 8px">Recurring bills</h3>${table(s.bills)}` : ''}${s.lapsed.length ? `<h3 style="font-size:14px;margin:0 0 8px">Lapsed (no recent charge)</h3>${table(s.lapsed)}` : ''}`;
}

// ---------- Manual assets & liabilities (shared by Assets / Liabilities pages) ----------
const ASSET_TYPES = [['property', 'Property'], ['vehicle', 'Vehicle'], ['pension', 'Pension / retirement'], ['crypto', 'Crypto'], ['savings', 'Savings outside bank sync'], ['business', 'Business / private equity'], ['collectible', 'Collectibles'], ['other', 'Other']];
const LIAB_TYPES = [['loan', 'Mortgage / secured loan'], ['credit', 'Credit / unsecured debt']];
const todayISO = () => ST.today || new Date().toISOString().slice(0, 10);

function manualForm(kind) {
  const liab = kind === 'liability';
  return `<form id="addForm" class="form" hidden style="margin:0 0 16px;padding-bottom:16px;border-bottom:1px solid var(--line)">
    <label>Name<input type="text" name="name" required maxlength="60" placeholder="${liab ? 'Mortgage' : 'Flat, Helsinki'}"></label>
    <label>Type<select name="type">${(liab ? LIAB_TYPES : ASSET_TYPES).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
    <label>Currency<input type="text" name="currency" value="${esc(BASE)}" maxlength="5" style="text-transform:uppercase"></label>
    <label>${liab ? 'Current balance owed' : 'Current value'}<input type="number" name="value" step="any" min="0" required></label>
    <label>As of<input type="date" name="date" value="${todayISO()}"></label>
    <p class="muted" style="grid-column:1/-1;margin:-2px 0 0;font-size:12px">Your net worth history includes this item from this date. To show it earlier, set an earlier date, or record older values afterwards.</p>
    ${liab ? '' : '<label>Cost basis (optional)<input type="number" name="cost" step="any" min="0"></label><label>Acquired (optional)<input type="date" name="acquired"></label>'}
    ${liab ? '<label class="chk"><input type="checkbox" name="secured" checked> Secured against an asset</label>' : '<label class="chk"><input type="checkbox" name="liquid"> Liquid (can be sold quickly)</label>'}
    <label>Notes<input type="text" name="notes" maxlength="300"></label>
    <div class="row"><button class="btn primary">Add</button><button type="button" class="btn" id="cancelAdd">Cancel</button></div></form>`;
}

function manualTable(items, kind) {
  const liab = kind === 'liability', live = items.filter((a) => !a.closed), closed = items.filter((a) => a.closed);
  const row = (a) => {
    const vals = [...a.valuations].reverse().map((v) => v.value);
    const stale = a.staleDays > 90 && !a.closed;
    const chg = a.change ? `<span class="${(liab ? -a.change.amount : a.change.amount) >= 0 ? 'good' : 'bad'}">${money(a.change.amount, a.currency, { sign: true })}${a.change.pct != null ? ` (${pct(Math.round(a.change.pct * 10) / 10)})` : ''}</span>` : '<span class="muted">—</span>';
    const gain = a.gain ? `<span class="${a.gain.amount >= 0 ? 'good' : 'bad'}">${money(a.gain.amount, a.currency, { sign: true })}${a.gain.pct != null ? ` (${pct(Math.round(a.gain.pct))})` : ''}</span>` : '<span class="muted">—</span>';
    return `<tr class="click" data-toggle="${a.id}"><td>${esc(a.name)}<span class="tag">${esc(a.typeLabel)}</span>${liab ? `<span class="tag">${a.secured ? 'secured' : 'unsecured'}</span>` : a.liquid ? '<span class="tag">liquid</span>' : ''}${stale ? `<span class="pill warn" style="margin-left:6px">${a.staleDays}d old</span>` : ''}</td>
      <td>${sparkline(vals, 70, 20)}</td><td class="n">${a.latest ? money(a.latest.value, a.currency) : '—'}${a.currency !== BASE && a.valueBase != null ? `<div class="muted" style="font-size:11px">≈ ${money(Math.abs(a.valueBase))}</div>` : ''}</td>
      <td class="n">${chg}</td>${liab ? '' : `<td class="n">${gain}</td>`}<td class="muted">${esc(a.latest?.date || '—')}</td><td class="n"><button class="btn sm">Update ▾</button></td></tr>
      <tr data-detail="${a.id}" hidden><td colspan="${liab ? 6 : 7}" style="background:var(--card2)">
        <form data-upd="${a.id}" class="row" style="margin-bottom:10px"><input type="number" name="value" step="any" min="0" required placeholder="${liab ? 'New balance' : 'New value'} (${esc(a.currency)})" style="width:170px"><input type="date" name="date" value="${todayISO()}"><input type="text" name="note" placeholder="Note (optional)" style="width:200px"><button class="btn primary sm">Save value</button></form>
        <table style="min-width:0"><tbody>${a.valuations.map((v) => `<tr><td class="muted" style="padding:3px 10px">${esc(v.date)}</td><td class="n" style="padding:3px 10px">${money(v.value, a.currency, { d: 2 })}</td><td class="muted" style="padding:3px 10px">${esc(v.note || '')}</td><td class="n" style="padding:3px 10px"><button class="btn sm" data-rmval="${a.id}|${v.date}" title="Delete this entry">×</button></td></tr>`).join('')}</tbody></table>
        <div class="row" style="margin-top:10px">${a.closed ? `<button class="btn sm" data-reopen="${a.id}">Reopen</button>` : `<button class="btn sm" data-close="${a.id}">${liab ? 'Mark as repaid' : 'Mark as sold / closed'}</button>`}<button class="btn sm danger" data-del="${a.id}">Delete…</button></div></td></tr>`;
  };
  const head = `<thead><tr><th>Name</th><th></th><th class="n">${liab ? 'Owed' : 'Value'}</th><th class="n">Since last</th>${liab ? '' : '<th class="n">Gain vs cost</th>'}<th>Updated</th><th></th></tr></thead>`;
  return `<div class="tbl" style="margin:0"><table>${head}<tbody>${live.map(row).join('') || `<tr><td colspan="7" class="empty">${liab ? 'No liabilities yet. Add a mortgage or loan to include it in net worth.' : 'Nothing yet. Add property, a car, a pension or any asset you want to track.'}</td></tr>`}</tbody></table></div>
    ${closed.length ? `<details style="margin-top:12px"><summary class="muted" style="cursor:pointer">${closed.length} ${liab ? 'repaid' : 'sold / closed'}</summary><div class="tbl" style="margin:8px 0 0"><table>${head}<tbody>${closed.map(row).join('')}</tbody></table></div></details>` : ''}`;
}

function wireManual(root, kind) {
  const form = $('#addForm', root);
  const open = $('#addBtn', root);
  if (open) open.onclick = () => { form.hidden = !form.hidden; };
  if ($('#cancelAdd', root)) $('#cancelAdd', root).onclick = () => (form.hidden = true);
  if (form) {
    const typeSel = form.elements.type, sync = () => {
      const t = typeSel.value;
      if (form.elements.secured) form.elements.secured.checked = t !== 'credit';
      if (form.elements.liquid) form.elements.liquid.checked = t === 'crypto' || t === 'savings';
    };
    typeSel.onchange = sync; sync();
  }
  if (form) form.onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form)), liab = kind === 'liability';
    const body = { ...f, currency: (f.currency || BASE).toUpperCase(), kind, ...(liab ? { secured: !!f.secured } : { liquid: !!f.liquid }) };
    await run(() => api('/api/manual', 'POST', body), 'Added'); go();
  };
  $$('[data-toggle]', root).forEach((tr) => (tr.onclick = (e) => { if (e.target.closest('button') && !e.target.closest('.btn.sm')) return; const d = $(`[data-detail="${tr.dataset.toggle}"]`, root); d.hidden = !d.hidden; }));
  $$('[data-upd]', root).forEach((f) => (f.onsubmit = async (e) => { e.preventDefault(); await run(() => api(`/api/manual/${f.dataset.upd}/value`, 'POST', Object.fromEntries(new FormData(f))), 'Value saved'); go(); }));
  $$('[data-rmval]', root).forEach((b) => (b.onclick = async () => { const [id, d] = b.dataset.rmval.split('|'); await run(() => api(`/api/manual/${id}/value/${d}`, 'DELETE'), 'Removed'); go(); }));
  $$('[data-close]', root).forEach((b) => (b.onclick = async () => { await run(() => api(`/api/manual/${b.dataset.close}/close`, 'POST', {}), 'Closed'); go(); }));
  $$('[data-reopen]', root).forEach((b) => (b.onclick = async () => { await run(() => api(`/api/manual/${b.dataset.reopen}/reopen`, 'POST', {}), 'Reopened'); go(); }));
  $$('[data-del]', root).forEach((b) => (b.onclick = async () => { if (!confirm('Delete this item and its whole value history?')) return; await run(() => api(`/api/manual/${b.dataset.del}`, 'DELETE'), 'Deleted'); go(); }));
}

// ---------- Assets ----------
pages.assets = {
  title: 'Assets',
  async render(el) {
    const w = await api('/api/assets');
    const acctName = Object.fromEntries((ST.accounts || []).map((a) => [`assets:bank:${a.name}`, a.label || a.name]));
    const cashRows = w.accounts.filter((a) => /^assets:(bank|cash)/.test(a.account));
    const assets = w.manual.filter((a) => a.kind === 'asset');
    const totalAssets = w.cash + w.investmentsValue + w.liquidManual + w.illiquidAssets;
    const inv = w.investments, invTotal = inv.reduce((s, x) => s + x.value, 0), invCost = inv.reduce((s, x) => s + x.cost, 0);
    el.innerHTML = `
      <div class="kpis">${kpi('Total assets', money(totalAssets), `${assets.filter((a) => !a.closed).length} manual · ${cashRows.length} cash accounts · ${inv.length} holdings`)}${kpi('Liquid', money(w.cash + w.investmentsValue + w.liquidManual), 'Cash, investments, liquid assets')}${kpi('Illiquid', money(w.illiquidAssets), w.illiquidParts.map((p) => `${esc(p.name)} ${money(p.value)}`).join(', ') || '—')}</div>
      ${w.unpriced.length ? `<div class="banner"><span class="warn">No price/FX rate for: ${esc(w.unpriced.join(', '))}</span><a id="px1">Update prices</a></div>` : ''}
      ${staleBanner(w, 'px2')}
      ${card('Cash &amp; bank accounts', 'Synced from your bank, plus foreign-currency cash from config', `<div class="tbl" style="margin:0"><table><tbody>${cashRows.map((a) => `<tr><td>${esc(acctName[a.account] || (a.account.startsWith('assets:cash:') ? a.account.split(':').pop().toUpperCase() + ' cash' : a.account.split(':').slice(1).join(' › ')))}</td><td class="n">${money(a.value)}</td></tr>`).join('') || '<tr><td class="empty">No accounts yet.</td></tr>'}</tbody></table></div>`)}
      ${card('Investments', 'Stocks and funds from config.json holdings, valued at the latest price', inv.length ? `<div class="tbl" style="margin:0"><table><thead><tr><th>Holding</th><th class="n">Qty</th><th class="n">Value</th><th class="n">Cost</th><th class="n">Gain</th></tr></thead><tbody>${inv.map((x) => `<tr><td>${esc(x.symbol)}</td><td class="n">${x.qty}</td><td class="n">${money(x.value)}</td><td class="n muted">${money(x.cost)}</td><td class="n ${x.pl >= 0 ? 'good' : 'bad'}">${money(x.pl, BASE, { sign: true })}${x.plPct != null ? ` (${pct(x.plPct)})` : ''}</td></tr>`).join('')}<tr><td><b>Total</b></td><td></td><td class="n"><b>${money(invTotal)}</b></td><td class="n muted">${money(invCost)}</td><td class="n ${invTotal >= invCost ? 'good' : 'bad'}"><b>${money(invTotal - invCost, BASE, { sign: true })}</b></td></tr></tbody></table></div>` : '<p class="empty">No holdings yet. Add them under <code>holdings</code> in data/config.json.</p>', `<button class="btn" id="px">Update prices</button>`)}
      ${card('Manual assets', 'Property, vehicles, pension, crypto wallets… record a value whenever you like. History builds your net worth chart.', manualForm('asset') + manualTable(assets, 'asset'), '<button class="btn primary" id="addBtn">+ Add asset</button>')}`;
    wireManual(el, 'asset');
    const px = async () => { const r = await run(() => api('/api/prices', 'POST')); toast(r.errors?.length ? r.errors[0] : `Updated ${r.updated.length} prices`); go(); };
    $('#px', el).onclick = px; for (const id of ['#px1', '#px2']) if ($(id, el)) $(id, el).onclick = px;
  },
};

// ---------- Liabilities ----------
pages.liabilities = {
  title: 'Liabilities',
  async render(el) {
    const w = await api('/api/assets'), items = w.manual.filter((a) => a.kind === 'liability');
    el.innerHTML = `<div class="kpis">${kpi('Total owed', money(w.secured + w.unsecured), `${items.filter((a) => !a.closed).length} active`)}${kpi('Secured debt', money(w.secured), 'Mortgages and loans against an asset — reduces illiquid net worth')}${kpi('Unsecured debt', money(w.unsecured), 'Credit and personal loans — reduces liquid net worth')}</div>
      ${card('Loans &amp; debts', 'Record the balance whenever it changes; your net worth history follows.', manualForm('liability') + manualTable(items, 'liability'), '<button class="btn primary" id="addBtn">+ Add liability</button>')}`;
    wireManual(el, 'liability');
  },
};

// ---------- Transactions ----------
const tx = { q: '', account: '', category: '', from: '', to: '', limit: 100 };
pages.transactions = {
  title: 'Transactions',
  async render(el) {
    const first = await api('/api/transactions?limit=1');
    el.innerHTML = `<div class="bar"><input type="search" id="q" placeholder="Search counterparty…" value="${esc(tx.q)}" style="min-width:220px">
      <select id="acc"><option value="">All accounts</option>${first.accounts.map((a) => `<option value="${esc(a)}" ${a === tx.account ? 'selected' : ''}>${esc(a.split(':').pop())}</option>`).join('')}</select>
      <select id="cat"><option value="">All categories</option>${catOptions(first.categories, tx.category)}</select>
      <input type="date" id="from" value="${tx.from}" title="From"><input type="date" id="to" value="${tx.to}" title="To"><a class="btn right" href="#/import">Import…</a></div>
      <div class="tbl" id="txBody"></div><div id="more" style="text-align:center;margin-bottom:24px"></div>`;
    const cats = first.categories;
    let seq = 0;
    const load = async () => {
      const mine = ++seq, r = await api('/api/transactions?' + new URLSearchParams(tx));
      if (mine !== seq) return; // a newer search was typed while this one loaded
      $('#txBody', el).innerHTML = txTable(r.rows, true, cats);
      $('#more', el).innerHTML = r.total > r.rows.length ? `<button class="btn" id="moreBtn">Show more (${r.total - r.rows.length} left)</button>` : `<span class="muted">${r.total} transactions</span>`;
      if ($('#moreBtn', el)) $('#moreBtn', el).onclick = () => { tx.limit += 100; load(); };
      $$('[data-tx]', el).forEach((s) => (s.onchange = async () => { await run(() => api('/api/override', 'POST', { id: s.dataset.tx, category: s.value }), 'Category updated'); loadState().then(() => renderSide('transactions')); }));
    };
    let t; const reload = () => { tx.limit = 100; load(); };
    $('#q', el).oninput = (e) => { tx.q = e.target.value; clearTimeout(t); t = setTimeout(reload, 250); };
    for (const [id, k] of [['acc', 'account'], ['cat', 'category'], ['from', 'from'], ['to', 'to']]) $('#' + id, el).onchange = (e) => { tx[k] = e.target.value; reload(); };
    load();
  },
};

// ---------- Goals ----------
const GOAL_WORD = { reached: 'reached', on_track: 'on track', behind: 'behind', projected: 'progressing', not_reachable: 'not growing', no_history: 'no history yet' };
/** The monthly goal check on the Overview: one line per goal, status changes called out, until dismissed. */
function goalCheckBanner(c) {
  if (!c) return '';
  const line = (g) => {
    const moved = g.statusBefore && g.statusBefore !== g.status;
    const verb = moved ? (['on_track', 'reached'].includes(g.status) ? `<span class="good">back ${GOAL_WORD[g.status]}</span>` : `<span class="bad">slipped to ${GOAL_WORD[g.status]}</span>`) : `<span class="${GOAL_STATUS[g.status][0]}">${GOAL_WORD[g.status]}</span>`;
    const extra = g.status === 'behind' && g.neededMonthly != null ? `, needs ${money(g.neededMonthly)}/month (you save ${money(g.monthlyUsed ?? 0)})` : g.change != null ? ` (${money(g.change, BASE, { sign: true })} since last check)` : '';
    return `<b>${esc(g.name)}</b> ${verb}${extra}`;
  };
  return `<div class="banner" id="goalCheck"><span>${esc(monthName(c.month))} goal check: ${c.goals.map(line).join(' · ')}</span><span class="row"><a href="#/goals">Goals →</a><button class="btn sm" data-seen="${esc(c.month)}">Dismiss</button></span></div>`;
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-seen]');
  if (!b) return;
  await api(`/api/goals/checks/${b.dataset.seen}/seen`, 'POST', {}); ST.goalCheck = null; b.closest('.banner').remove();
});
const GOAL_STATUS = { reached: ['good', 'Reached'], on_track: ['good', 'On track'], behind: ['bad', 'Behind'], projected: ['', 'No deadline'], not_reachable: ['bad', 'Not growing'], no_history: ['', 'Not enough history'] };
const goalUi = { editing: null };
const monthName = (m) => (m ? new Date(m + '-01T00:00:00Z').toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }) : '');
function goalSentence(g) {
  const pace = g.monthlyUsed == null ? '' : `${money(g.monthlyUsed)}/month${g.monthly == null ? ' (your pace over the last 6 months)' : ' (the amount you set)'}${g.growth ? ` plus ${g.growth}% a year growth` : ''}`;
  if (g.status === 'reached') return `You have reached this goal: ${money(g.current)} of ${money(g.target)}.`;
  if (g.status === 'no_history') return 'There is not enough history yet to project. Set a monthly saving amount to see a projection.';
  if (g.status === 'not_reachable') return `At ${pace} this balance is not growing, so the target is out of reach. ${g.neededMonthly != null ? `To get there by ${monthName(g.deadlineMonth)} you need ${money(g.neededMonthly)}/month.` : 'Set a monthly saving amount to see when you would get there.'}`;
  const when = `At ${pace} you reach it in <b>${monthName(g.reachDate)}</b>`;
  if (!g.by) return `${when}.`;
  const diff = (Date.parse(g.deadlineMonth + '-01') - Date.parse(g.reachDate + '-01')) / (30.44 * 864e5), months = Math.round(Math.abs(diff));
  return `${when}, ${months ? `${months} month${months === 1 ? '' : 's'} ${diff >= 0 ? 'before' : 'after'}` : 'right at'} your ${monthName(g.deadlineMonth)} deadline. You need <b>${money(g.neededMonthly)}/month</b> to make it.`;
}
pages.goals = {
  title: 'Goals',
  async render(el) {
    const [r, ch] = await Promise.all([api('/api/goals'), api('/api/goals/checks')]), gs = r.goals, ed = gs.find((g) => g.id === goalUi.editing);
    const last = ch.checks.at(-1), record = (id) => ch.checks.flatMap((c) => c.goals.filter((g) => g.id === id).map((g) => ({ month: c.month, ...g }))).slice(-12);
    const form = `<form id="goalForm" class="form" ${gs.length && !ed && !goalUi.adding ? 'hidden' : ''} style="margin-bottom:14px">
        <label>Goal<input type="text" name="name" required maxlength="60" placeholder="House deposit" value="${esc(ed?.name || '')}"></label>
        <label>Target (${esc(BASE)})<input type="number" name="target" required min="1" step="any" value="${ed?.target ?? ''}"></label>
        <label>By (optional)<input type="date" name="by" value="${esc(ed?.by || '')}"></label>
        <label>Track<select name="source" id="gSource">${r.sources.map((s) => `<option value="${esc(s.id)}" ${(ed?.source || 'liquid') === s.id ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select></label>
        <label>Starting point<select name="start"><option value="all" ${ed?.start !== 'new' ? 'selected' : ''}>Count what is already there</option><option value="new" ${ed?.start === 'new' ? 'selected' : ''}>Only what I add from today</option></select></label>
        ${ed?.start === 'new' ? `<label class="chk"><input type="checkbox" name="resetStart"> Restart counting from today (started ${esc(ed.startDate || '')})</label>` : ''}
        <div id="gAccounts" style="grid-column:1/-1" ${(ed?.source || 'liquid') === 'accounts' ? '' : 'hidden'}>
          <div class="muted" style="font-size:12px;margin-bottom:6px">Which accounts hold this goal's money? If an account also holds other goals, say how much of it is for this one.</div>
          ${r.accounts.length ? `<div class="tbl" style="margin:0"><table><tbody>${r.accounts.map((a) => { const l = ed?.accounts?.find((x) => x.account === a.account); return `<tr><td><label class="chk row" style="margin:0"><input type="checkbox" data-acct="${esc(a.account)}" ${l ? 'checked' : ''}> ${esc(a.label)}</label></td>
            <td><select data-share="${esc(a.account)}"><option value="rest" ${!l || l.share === 'rest' ? 'selected' : ''}>All of it (what other goals leave)</option><option value="amount" ${l?.share === 'amount' ? 'selected' : ''}>Up to an amount</option><option value="percent" ${l?.share === 'percent' ? 'selected' : ''}>A percentage</option></select></td>
            <td><input type="number" data-val="${esc(a.account)}" min="0" step="any" style="width:110px" value="${l?.value ?? ''}" placeholder="${l?.share === 'percent' ? '%' : esc(BASE)}" ${!l || l.share === 'rest' ? 'hidden' : ''}></td></tr>`; }).join('')}</tbody></table></div>` : '<p class="empty">No accounts yet: connect a bank, import a statement or add an asset first.</p>'}
        </div>
        <label>Monthly saving (blank = your real pace)<input type="number" name="monthly" step="any" value="${ed?.monthly ?? ''}" placeholder="auto"></label>
        <label>Expected yearly return %<input type="number" name="growth" step="0.1" min="-50" max="50" value="${ed?.growth || ''}" placeholder="0"></label>
        <div class="row"><button class="btn primary">${ed ? 'Save goal' : 'Add goal'}</button>${ed || gs.length ? '<button type="button" class="btn" id="goalCancel">Cancel</button>' : ''}</div></form>`;
    el.innerHTML = `
      ${card('Savings goals', 'Set a target, optionally a date, and the balance it tracks. Progress comes from your real balances; the projection continues the pace you have actually been saving at.', form + (gs.length ? '' : '<p class="empty">No goals yet. Add your first one above, for example an emergency fund of three months of spending.</p>'), gs.length ? '<button class="btn primary sm" id="goalAdd">+ Add goal</button>' : '')}
      ${r.allocations.length ? card('Where your goal money sits', 'How each account is divided between the goals that use it, as of today.', `<div class="tbl" style="margin:0"><table><thead><tr><th>Account</th><th class="n">Balance</th><th>Goals</th><th class="n">Not earmarked</th></tr></thead><tbody>${r.allocations.map((a) => `<tr><td>${esc(a.label)}</td><td class="n">${money(a.balance)}</td><td>${a.parts.map((p) => `${esc(p.name)} <b>${money(p.amount)}</b> <span class="muted">(${p.share === 'rest' ? 'what is left' : p.share === 'amount' ? `up to ${money(p.value)}` : `${p.value}%`})</span>`).join('<br>')}${a.short ? `<div class="bad" style="font-size:12px">Short by ${money(a.short)}: the amounts earmarked add up to more than the balance.</div>` : ''}</td><td class="n">${a.unallocated ? money(a.unallocated) : '—'}</td></tr>`).join('')}</tbody></table></div>`) : ''}
      ${gs.length ? `<div class="banner"><span><b>Monthly check</b> · ${ch.mode === 'off' ? 'off' : `every goal is checked at the start of each month${last ? `; last checked ${esc(new Date(last.at).toLocaleDateString())}` : ''}`}</span><span class="row"><label class="chk row" style="margin:0"><input type="checkbox" id="gcMode" ${ch.mode !== 'off' ? 'checked' : ''}> Monthly</label><button class="btn sm" id="gcNow">Check now</button></span></div>` : ''}
      ${gs.map((g) => { const [cls, label] = GOAL_STATUS[g.status], rec = record(g.id); return card(`${esc(g.name)} <span class="pill ${cls}" style="margin-left:8px;vertical-align:middle">${label}</span>`, `${esc(g.sourceLabel)}${g.start === 'new' ? ` · counting from ${esc(g.startDate)}` : ''}${g.by ? ` · by ${esc(monthName(g.deadlineMonth))}` : ''}`,
        `<div class="row" style="justify-content:space-between;margin-bottom:6px"><span><b>${money(g.current)}</b> <span class="muted">of ${money(g.target)}</span></span><span class="muted">${g.pct}%</span></div>
         <div class="track" style="height:8px;margin-bottom:12px" role="progressbar" aria-valuenow="${g.pct}" aria-valuemin="0" aria-valuemax="100" aria-label="${esc(g.name)} progress"><div class="fill" style="width:${g.pct}%;background:var(--s1)"></div></div>
         <p style="margin:0 0 12px;font-size:13px">${goalSentence(g)}</p>
         <div class="chart" id="gc-${g.id}"></div><div id="gl-${g.id}"></div>
         ${rec.length ? `<h3 style="font-size:13px;margin:14px 0 6px">Track record</h3><div class="row" style="flex-wrap:wrap;gap:6px">${rec.map((x) => `<span class="pill ${GOAL_STATUS[x.status][0]}" title="${esc(`${monthName(x.month)}: ${money(x.current)} of ${money(x.target)}${x.change != null ? `, ${money(x.change, BASE, { sign: true })} since the check before` : ''}`)}">${esc(keyLabel(x.month))} · ${GOAL_STATUS[x.status][1]}${x.change != null ? ` · ${money(x.change, BASE, { sign: true })}` : ''}</span>`).join('')}</div>` : ''}`,
        `<span class="row"><button class="btn sm" data-gedit="${g.id}">Edit</button><button class="btn sm danger" data-gdel="${g.id}">Delete</button></span>`); }).join('')}`;
    for (const g of gs) {
      const pts = g.points, idx = (m) => pts.findIndex((p) => p.month === m), now = pts.map((p) => p.actual != null).lastIndexOf(true); // this month: the last one with a real balance
      const series = [{ name: 'Saved', color: 'var(--s1)', points: pts.map((p) => ({ x: p.month, y: p.actual })) }];
      if (g.status !== 'reached' && pts.some((p, i) => i > now && p.projected != null)) series.push({ name: g.monthly == null ? 'Projected at your pace' : 'Projected', color: 'var(--s1)', dash: true, points: pts.map((p) => ({ x: p.month, y: p.projected })) });
      if (pts.some((p, i) => i > now && p.needed != null)) series.push({ name: 'Needed to hit the date', color: 'var(--s2)', dash: true, points: pts.map((p) => ({ x: p.month, y: p.needed })) });
      const marks = [{ i: now, label: 'Today' }]; if (g.deadlineMonth && idx(g.deadlineMonth) > now) marks.push({ i: idx(g.deadlineMonth), label: 'Deadline' });
      lineChart($(`#gc-${g.id}`, el), { series, fmtX: (m) => keyLabel(m), refs: [{ y: g.target, label: `Target ${money(g.target)}` }], marks, height: 230 });
      $(`#gl-${g.id}`, el).innerHTML = legend([...series.map((s) => ({ name: s.name, color: s.color, dash: s.dash })), { name: 'Target', color: 'var(--text2)', ref: true }]);
    }
    if ($('#gcMode', el)) $('#gcMode', el).onchange = async (e) => { await run(() => api('/api/goals/checks/mode', 'POST', { mode: e.target.checked ? 'monthly' : 'off' }), e.target.checked ? 'Monthly checks on' : 'Monthly checks off'); go(); };
    if ($('#gcNow', el)) $('#gcNow', el).onclick = async () => { await run(() => api('/api/goals/checks', 'POST', {}), 'Goals checked'); go(); };
    const f = $('#goalForm', el);
    $('#gSource', el).onchange = (e) => { $('#gAccounts', el).hidden = e.target.value !== 'accounts'; };
    $$('[data-share]', el).forEach((s) => (s.onchange = () => { const v = $(`[data-val="${CSS.escape(s.dataset.share)}"]`, el); v.hidden = s.value === 'rest'; v.placeholder = s.value === 'percent' ? '%' : BASE; }));
    if ($('#goalAdd', el)) $('#goalAdd', el).onclick = () => { goalUi.editing = null; goalUi.adding = true; go(); };
    if ($('#goalCancel', el)) $('#goalCancel', el).onclick = () => { goalUi.editing = null; goalUi.adding = false; go(); };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(f));
      body.resetStart = !!body.resetStart;
      if (body.source === 'accounts') body.accounts = $$('[data-acct]', el).filter((c) => c.checked).map((c) => ({ account: c.dataset.acct, share: $(`[data-share="${CSS.escape(c.dataset.acct)}"]`, el).value, value: $(`[data-val="${CSS.escape(c.dataset.acct)}"]`, el).value }));
      if (ed) await run(() => api(`/api/goals/${ed.id}`, 'PUT', body), 'Goal saved'); else await run(() => api('/api/goals', 'POST', body), 'Goal added');
      goalUi.editing = null; goalUi.adding = false; go();
    };
    $$('[data-gedit]', el).forEach((b) => (b.onclick = () => { goalUi.editing = b.dataset.gedit; goalUi.adding = false; go(); }));
    $$('[data-gdel]', el).forEach((b) => (b.onclick = async () => { if (!confirm('Delete this goal? Your balances are not affected.')) return; await run(() => api(`/api/goals/${b.dataset.gdel}`, 'DELETE'), 'Goal deleted'); go(); }));
  },
};

// ---------- Review ----------
const SEV = { high: 'var(--bad)', medium: 'var(--warn)', low: 'var(--muted)' };
const ANOM = { unusual_amount: 'Unusually large', new_merchant: 'New merchant', duplicate_charge: 'Possible duplicate', category_spike: 'Spending spike', price_increase: 'Price increase' };
pages.review = {
  title: 'Review',
  async render(el) {
    const r = await api('/api/review');
    const an = r.anomalies;
    const sure = r.merchants.filter((m) => m.suggestion?.confidence >= 0.8); // "Accept all" only takes the confident ones
    el.innerHTML = `
      ${card('Merchants to categorize', 'No rule matched these. Pick a category once and every matching transaction, past and future, follows. Suggestions are learned from what you have already categorized, on this computer.', r.merchants.length ? `<div class="tbl" style="margin:0"><table><thead><tr><th>Merchant</th><th class="n">Transactions</th><th class="n">Total</th><th>Last</th><th>Category</th><th></th></tr></thead><tbody>${r.merchants.map((m) => `<tr><td>${esc(m.name)}${m.suggestion ? `<div class="muted" style="font-size:12px">Suggested: ${esc(catLabel(m.suggestion.category))} · ${Math.round(m.suggestion.confidence * 100)}% sure · like ${esc(m.suggestion.because)}</div>` : ''}</td><td class="n">${m.count}</td><td class="n">${money(m.total)}</td><td class="muted">${esc(m.last)}</td>
        <td><select data-m="${esc(m.merchant)}"><option value="">Choose…</option>${catOptions(r.categories.filter((c) => !c.account.endsWith(':uncategorized')), m.suggestion?.category || '', m.dir === 'in' ? 'income' : 'expense')}<option value="__new">＋ New category…</option></select></td><td class="n"><button class="btn sm primary" data-save="${esc(m.merchant)}">Apply</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">Everything is categorized. 🎉</p>', sure.length ? `<button class="btn primary sm" id="acceptAll">Accept ${sure.length} suggestion${sure.length === 1 ? '' : 's'}</button>` : '')}
      ${card(`Unusual activity (${an.length})`, 'Large or odd charges, duplicates, spikes and price increases.', an.length ? an.map((x) => `<div class="an"><div class="row" style="justify-content:space-between"><span><span class="sw" style="background:${SEV[x.severity]};border-radius:50%"></span><b>${esc(ANOM[x.type])}</b> · ${esc(x.type === 'category_spike' ? catLabel(x.desc) : x.desc)}</span><span>${money2(x.amount)}</span></div><div class="muted" style="font-size:12px;margin-left:17px">${esc(x.date)} · ${esc(x.detail)}</div></div>`).join('') : '<p class="empty">Nothing unusual lately.</p>')}
      ${card('Subscriptions worth a second look', 'Price rises, duplicate charges, overlapping services and costly ones.', (() => { const f = r.subscriptions.active.filter((s) => s.flags.some((x) => x !== 'new')); return f.length ? `<div class="tbl" style="margin:0"><table><tbody>${f.map((s) => `<tr><td>${esc(s.merchant)}</td><td>${s.flags.map((x) => `<span class="pill ${x === 'duplicate_charge' ? 'bad' : 'warn'}" style="margin-right:4px">${esc(x.replace('_', ' '))}</span>`).join('')}</td><td class="n">${money2(s.amount)} / ${esc(s.period.replace('ly', ''))}</td><td class="n muted">${money(s.perYear)}/yr</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No flags.</p>'; })())}`;
    $$('select[data-m]', el).forEach((s) => (s.onchange = () => {
      if (s.value !== '__new') return;
      const name = prompt('New category, e.g. expenses:hobbies or income:side-gig'); 
      if (!name) { s.value = ''; return; }
      const acct = name.includes(':') ? name.toLowerCase().replace(/\s+/g, '-') : `${s.closest('tr') && /income/.test(s.innerHTML) ? 'income' : 'expenses'}:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      const o = document.createElement('option'); o.value = acct; o.textContent = catLabel(acct); s.insertBefore(o, s.lastChild); s.value = acct;
    }));
    if ($('#acceptAll', el)) $('#acceptAll', el).onclick = async () => {
      if (!confirm(`Create rules for these ${sure.length} merchants?\n\n${sure.map((m) => `${m.name} → ${catLabel(m.suggestion.category)}`).join('\n')}`)) return;
      await run(() => api('/api/review/assign-many', 'POST', { items: sure.map((m) => ({ merchant: m.merchant, category: m.suggestion.category })) }), `${sure.length} merchants categorized`); go();
    };
    $$('[data-save]', el).forEach((b) => (b.onclick = async () => {
      const sel = $(`select[data-m="${CSS.escape(b.dataset.save)}"]`, el);
      if (!sel.value) return toast('Choose a category first');
      await run(async () => { await api('/api/categories', 'POST', { account: sel.value }); await api('/api/review/assign', 'POST', { merchant: b.dataset.save, category: sel.value }); }, 'Rule created and transactions updated'); go();
    }));
  },
};

// ---------- Categories ----------
pages.categories = {
  title: 'Categories',
  async render(el) {
    const cats = await api('/api/categories');
    const group = (kind, title) => `<h3 style="font-size:14px;margin:0 0 8px">${title}</h3><div class="tbl"><table><thead><tr><th>Category</th><th>Account</th>${kind === 'expense' ? '<th class="n">Budget</th>' : ''}</tr></thead><tbody>${cats.filter((c) => c.kind === kind).map((c) => `<tr><td>${esc(c.label)}</td><td class="muted">${esc(c.account)}</td>${kind === 'expense' ? `<td class="n"><span class="row" style="justify-content:flex-end;flex-wrap:nowrap"><input type="number" min="0" step="any" value="${c.budget ?? ''}" placeholder="—" data-budget="${esc(c.account)}" style="width:100px;text-align:right"><select data-bper="${esc(c.account)}"><option value="month" ${c.budgetPeriod !== 'year' ? 'selected' : ''}>per month</option><option value="year" ${c.budgetPeriod === 'year' ? 'selected' : ''}>per year</option></select></span></td>` : ''}</tr>`).join('')}</tbody></table></div>`;
    el.innerHTML = `<div class="bar"><input type="text" id="newCat" placeholder="expenses:hobbies" style="width:260px"><button class="btn" id="addCat">Add category</button><span class="muted">Use colons for sub-categories, e.g. expenses:food:takeaway. Budgets on a parent cover its children. Choose per month or per year.</span></div>${group('expense', 'Expenses')}${group('income', 'Income')}`;
    $('#addCat', el).onclick = async () => { await run(() => api('/api/categories', 'POST', { account: $('#newCat', el).value.trim().toLowerCase() }), 'Category added'); go(); };
    $$('input[data-budget]', el).forEach((i) => {
      const per = $(`select[data-bper="${CSS.escape(i.dataset.budget)}"]`, el);
      const save = () => run(() => api('/api/budget', 'PUT', { category: i.dataset.budget, amount: i.value === '' ? null : +i.value, period: per.value }), 'Budget saved');
      i.onchange = save; per.onchange = () => { if (i.value !== '') save(); };
    });
  },
};

// ---------- Rules ----------
pages.rules = {
  title: 'Rules',
  async render(el) {
    const [rules, cats] = await Promise.all([api('/api/rules'), api('/api/categories')]);
    const draw = () => {
      el.innerHTML = `<div class="bar"><span class="muted">First matching rule wins. Patterns are case-insensitive regular expressions tested against counterparty and message text.</span><span class="right row"><button class="btn" id="addRule">+ Add rule</button><button class="btn primary" id="saveRules">Save &amp; re-categorize</button></span></div>
        <div class="tbl"><table><thead><tr><th style="width:36px">#</th><th>Pattern</th><th>Category</th><th>Direction</th><th></th></tr></thead><tbody>${rules.map((r, i) => `<tr><td class="muted">${i + 1}</td><td><input type="text" data-f="match|${i}" value="${esc(r.match)}" style="width:100%;min-width:220px"></td>
        <td><select data-f="account|${i}">${catOptions(cats, r.account)}${cats.some((c) => c.account === r.account) ? '' : `<option selected>${esc(r.account)}</option>`}</select></td>
        <td><select data-f="dir|${i}"><option value="">Any</option><option value="out" ${r.dir === 'out' ? 'selected' : ''}>Money out</option><option value="in" ${r.dir === 'in' ? 'selected' : ''}>Money in</option></select></td>
        <td class="n"><button class="btn sm" data-up="${i}">↑</button> <button class="btn sm" data-down="${i}">↓</button> <button class="btn sm danger" data-rm="${i}">×</button></td></tr>`).join('')}</tbody></table></div>`;
      $$('[data-f]', el).forEach((n) => (n.onchange = () => { const [k, i] = n.dataset.f.split('|'); if (k === 'dir' && !n.value) delete rules[i].dir; else rules[i][k] = n.value; }));
      $$('[data-up]', el).forEach((b) => (b.onclick = () => { const i = +b.dataset.up; if (i) [rules[i - 1], rules[i]] = [rules[i], rules[i - 1]]; draw(); }));
      $$('[data-down]', el).forEach((b) => (b.onclick = () => { const i = +b.dataset.down; if (i < rules.length - 1) [rules[i + 1], rules[i]] = [rules[i], rules[i + 1]]; draw(); }));
      $$('[data-rm]', el).forEach((b) => (b.onclick = () => { rules.splice(+b.dataset.rm, 1); draw(); }));
      $('#addRule', el).onclick = () => { rules.unshift({ match: '', account: 'expenses:shopping' }); draw(); };
      $('#saveRules', el).onclick = async () => { await run(() => api('/api/rules', 'PUT', { rules: rules.filter((r) => r.match) }), 'Saved · transactions re-categorized'); loadState().then(() => renderSide('rules')); };
    };
    draw();
  },
};

// ---------- Banks ----------
pages.banks = {
  title: 'Banks',
  async render(el) {
    const mask = (s) => (s ? `••••${esc(s.slice(-4))}` : '—');
    const mon = (m) => new Date(m.slice(0, 7) + '-01T00:00:00Z').toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
    // Consecutive empty months read as one range: "Dec 2025 – Sep 2026".
    const gapText = (g) => { const out = []; for (const m of g) { const l = out[out.length - 1], d = new Date(m + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() - 1); if (l && l[1] === d.toISOString().slice(0, 7)) l[1] = m; else out.push([m, m]); } return out.map(([a, b]) => (a === b ? mon(a) : `${mon(a)} – ${mon(b)}`)).join(', '); };
    const histCell = (h) => (!h?.count ? '<span class="muted">none yet</span>' : `${esc(mon(h.first))} – ${esc(mon(h.last))} <span class="muted">· ${h.count} transactions</span>${h.gaps.length ? ` <span class="warn">· ${h.gaps.length} empty month${h.gaps.length > 1 ? 's' : ''}</span>` : ''}`);
    const gapped = (ST.accounts || []).filter((a) => !a.imported && a.history?.gaps?.length);
    el.innerHTML = `
      ${ST.demo ? '<div class="banner"><span>You are looking at generated demo data. Nothing here is real.</span></div>' : ''}
      ${card('Bank connection', ST.connected ? `${esc(ST.bank?.name || 'Connected')} · consent valid until ${esc((ST.validUntil || '').slice(0, 10))}` : 'Connect through Enable Banking (read-only access to balances and transactions).',
        ST.connected ? `<div class="tbl" style="margin:0"><table><thead><tr><th>Account</th><th>Number</th><th>Currency</th><th>History</th><th>Last sync</th></tr></thead><tbody>${(ST.accounts || []).map((a) => `<tr><td>${esc(a.label || a.name)}</td><td class="muted">${mask(a.iban)}</td><td>${esc(a.currency || '')}</td><td>${histCell(a.history)}</td><td class="muted">${a.imported ? 'imported file' : esc(a.lastSync || '—')}</td></tr>`).join('')}</tbody></table></div>
          ${gapped.length ? `<div class="banner" style="margin-top:12px"><span><b>Some months have no transactions.</b> ${gapped.map((a) => `${esc(a.label || a.name)}: ${esc(gapText(a.history.gaps))}`).join(' · ')}. The bank may have sent only part of your history. Try <b>Fetch full history</b>. If the months are still empty, banks often release older history only in the first minutes after you approve access: <b>Disconnect</b>, connect again, and Pennystead fetches everything straight away. You can also <a href="#/import">import a statement file</a> for those months into the same account (duplicates are skipped).</span></div>` : ''}
          <div class="row" style="margin-top:12px"><button class="btn primary" id="syncNow">Sync now</button><button class="btn" id="syncFull">Fetch full history</button><button class="btn danger" id="off">Disconnect</button></div>`
        : ST.demo ? '<p class="empty">Demo mode: connecting is disabled.</p>' : ST.canConnect ? `<div class="row"><select id="country">${['FI', 'SE', 'NO', 'DK', 'DE', 'FR', 'GB', 'NL', 'ES', 'IT', 'PL', 'EE', 'LV', 'LT', 'TR'].map((c) => `<option>${c}</option>`).join('')}</select><select id="bank" style="min-width:240px"></select><button class="btn primary" id="go">Connect</button></div><p class="muted">You will approve read-only access at your bank, then return here.</p>`
        : '<p class="empty">To connect a bank, first add your Enable Banking credentials. <a href="#/connections">Set up in Connections →</a></p>')}
      ${!ST.connected && ST.connectPending ? card('Finish connecting', 'Approved access at your bank but did not come back here? Copy the full address from your browser\'s address bar on the page you ended on, and paste it below.', '<form id="finForm" class="row"><input type="text" name="url" placeholder="https://…?code=…&amp;state=…" style="min-width:320px;flex:1" required><button class="btn primary">Finish</button></form>') : ''}
      ${card('Prices &amp; exchange rates', ST.canPrices ? 'Alpha Vantage key saved.' : 'Add a free Alpha Vantage key in <a href="#/connections">Connections</a> to fetch stock prices and exchange rates.', '<button class="btn" id="px">Update prices now</button>')}`;
    if ($('#syncNow', el)) $('#syncNow', el).onclick = async () => { const r = await run(() => api('/api/sync', 'POST')); toast(`Synced: ${r.reduce((s, x) => s + x.added, 0)} new`); go(); };
    if ($('#syncFull', el)) $('#syncFull', el).onclick = async () => {
      const r = await run(() => api('/api/sync', 'POST', { full: true }));
      const added = r.reduce((s, x) => s + x.added, 0), left = r.filter((x) => x.gaps?.length);
      toast(left.length ? `Fetched ${added} more transactions. Some months are still empty: the bank did not send them.` : `Fetched ${added} more transactions. No empty months.`);
      go();
    };
    if ($('#off', el)) $('#off', el).onclick = async () => { if (confirm('Disconnect? Your history stays; syncing stops until you reconnect.')) { await api('/api/disconnect', 'POST'); go(); } };
    if ($('#go', el)) {
      const load = async () => { $('#bank', el).innerHTML = '<option>Loading…</option>'; try { const b = await api('/api/banks?country=' + $('#country', el).value); $('#bank', el).innerHTML = b.map((x) => `<option>${esc(x.name)}</option>`).join(''); } catch (e) { toast(e.message); } };
      $('#country', el).onchange = load; load();
      $('#go', el).onclick = async () => { const r = await run(() => api('/api/connect', 'POST', { name: $('#bank', el).value, country: $('#country', el).value })); if (r.url) location.href = r.url; };
    }
    $('#px', el).onclick = async () => { const r = await run(() => api('/api/prices', 'POST')); toast(r.errors?.length ? r.errors[0] : `Updated ${r.updated.length} prices`); };
    if ($('#finForm', el)) $('#finForm', el).onsubmit = async (e) => { e.preventDefault(); await run(() => api('/api/connect/finish', 'POST', { url: e.target.url.value }), 'Bank connected'); go(); };
  },
};

// ---------- Updates ----------
pages.updates = {
  title: 'Updates',
  async render(el) {
    el.innerHTML = '<p class="muted">Checking for updates…</p>';
    const draw = (u) => {
      const when = u.publishedAt ? new Date(u.publishedAt).toLocaleDateString() : '';
      const mb = u.size ? ` (${Math.round(u.size / 1048576)} MB)` : '';
      const head = u.available ? `Version ${esc(u.latest)} is available${when ? ` · released ${esc(when)}` : ''}` : u.error ? '' : u.latest ? 'You have the newest version.' : 'No published version yet.';
      el.innerHTML = `
        ${card(`Pennystead ${esc(u.current)}`, head,
          `${u.error ? `<p class="warn" style="margin:0 0 10px">${esc(u.error)}</p>` : ''}
           ${u.available && u.notes ? `<details open><summary class="muted">What's new</summary><pre style="white-space:pre-wrap;font:inherit;margin:8px 0 0">${esc(u.notes)}</pre></details>` : ''}
           ${u.available ? (u.cannotInstall ? `<p class="warn">${esc(u.cannotInstall)}</p>` : `<p class="muted" style="font-size:13px">Pennystead downloads the new version${mb}, checks it against the checksum published with it, installs it and restarts. Your data is not touched. Takes about a minute.</p><button class="btn primary" id="install">Install ${esc(u.latest)} and restart</button>`) : ''}
           <div class="row" style="margin-top:14px"><button class="btn" id="checkNow">Check now</button>
             <label class="chk row"><input type="checkbox" id="auto" ${u.auto ? 'checked' : ''}> Check automatically (one anonymous request to GitHub at start and every 12 hours)</label>
             ${u.page ? `<a class="right" href="${esc(u.page)}" target="_blank" rel="noopener">Releases page →</a>` : ''}</div>
           <p class="muted" style="font-size:12px;margin:10px 0 0">Last checked ${esc(new Date(u.checkedAt).toLocaleString())}.</p>`)}`;
      $('#checkNow', el).onclick = async () => draw(await run(() => api('/api/update?refresh=1')));
      $('#auto', el).onchange = async (e) => { await run(() => api('/api/update/auto', 'POST', { on: e.target.checked }), e.target.checked ? 'Automatic checks on' : 'Automatic checks off'); };
      if ($('#install', el)) $('#install', el).onclick = async (e) => {
        if (!confirm(`Install Pennystead ${u.latest} now? Pennystead restarts when it is done.`)) return;
        e.target.disabled = true; e.target.textContent = 'Downloading and installing…';
        try { await api('/api/update/install', 'POST'); } catch (err) { toast(err.message); e.target.disabled = false; e.target.textContent = `Install ${u.latest} and restart`; return; }
        el.innerHTML = card('Restarting…', `Installing Pennystead ${esc(u.latest)}. This page reloads by itself.`, '<p class="muted" id="wait">Waiting for the new version to start…</p>');
        // Wait for the new version to answer, then reload into it.
        const t0 = Date.now();
        const poll = async () => {
          const r = await fetch('/api/ping', { cache: 'no-store' }).then((x) => x.json()).catch(() => null);
          if (r?.version && r.version !== u.current) return location.reload();
          if (Date.now() - t0 > 180e3) { $('#wait').innerHTML = 'The new version has not started yet. Open Pennystead again from your Start menu, Applications folder or app launcher.'; return; }
          setTimeout(poll, 1500);
        };
        setTimeout(poll, 2000);
      };
    };
    try { draw(await api('/api/update')); } catch (e) { el.innerHTML = `<div class="card bad">${esc(e.message)}</div>`; }
  },
};

// ---------- Backups ----------
const INTERVALS = [['off', 'Off (manual only)'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['on-change', 'Whenever data changes']];
const when = (iso) => (iso ? `${new Date(iso).toLocaleString()} (${ago(iso)})` : 'never');
pages.backups = {
  title: 'Backups',
  async render(el) {
    const qs = new URLSearchParams(location.hash.split('?')[1] || '');
    if (qs.get('gerr')) { toast('Google Drive: ' + qs.get('gerr')); history.replaceState(null, '', '#/backups'); }
    const b = await api('/api/backup'), c = b.config, st = b.state, g = b.google;
    const statusLine = (s) => (s?.lastError ? `<span class="bad">Failed: ${esc(s.lastError)}</span>` : s?.lastAt ? `Last backup ${esc(when(s.lastAt))} · ${bytes(s.lastSize || 0)}${s.encrypted ? ' · encrypted' : ' · <span class="warn">not encrypted</span>'}` : 'No backup yet');
    const passMsg = b.passphrase.set
      ? `<span class="good">Encryption on</span> (passphrase from ${b.passphrase.source === 'env' ? 'the BACKUP_PASSPHRASE environment variable' : 'a local file in the data folder'}).`
      : '<span class="warn">No passphrase set: backups are not encrypted, and uploads to Google Drive are blocked until you set one.</span>';
    el.innerHTML = `
      ${card('Schedule', 'Backups run in the background while Pennystead is running. Scheduled runs skip when nothing has changed.', `<div class="row"><label class="muted">Back up</label><select id="interval">${INTERVALS.map(([v, l]) => `<option value="${v}" ${c.interval === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <label class="muted" style="margin-left:12px">Keep last</label><input type="number" id="keep" min="1" max="365" value="${c.keep}" style="width:72px"><span class="muted">locally</span><span class="right"><a class="btn" href="/api/export.xlsx" download>Download Excel copy</a> <button class="btn primary" id="runNow">Back up now</button></span></div>
        <p class="muted" style="margin:10px 0 0;font-size:12px">The backup file (<code>.bak</code>) holds everything (transactions, rules, goals, settings) and restores Pennystead exactly; it is encrypted when you set a passphrase. The Excel copy is for reading: every transaction, today's balances and spending by month. It cannot be restored from and is <b>not encrypted</b>, so keep it somewhere private.</p>`)}
      ${card('Encryption', 'Backups contain your complete financial history. Encrypt them with a passphrase (AES-256).', `<p style="margin:0 0 10px">${passMsg}</p>
        ${b.passphrase.source === 'env' ? '' : `<form id="passForm" class="row"><input type="password" name="p" placeholder="${b.passphrase.set ? 'New passphrase' : 'Choose a passphrase (8+ characters)'}" minlength="8" autocomplete="new-password" style="width:280px"><button class="btn">${b.passphrase.set ? 'Change' : 'Set passphrase'}</button>${b.passphrase.set ? '<button type="button" class="btn danger" id="clearPass">Remove</button>' : ''}</form>`}
        <p class="muted" style="margin:10px 0 0;font-size:12px"><b>If you lose this passphrase, encrypted backups cannot be recovered.</b> Store it in a password manager. It is never included in a backup. After changing it, older backups still need the old one.</p>`)}
      <div class="two">
        ${card('Local folder', statusLine(st.local), `<div class="row" style="margin-bottom:8px"><label class="chk row"><input type="checkbox" id="localOn" ${c.local.enabled ? 'checked' : ''}> Enabled</label><label class="chk row" style="margin-left:14px"><input type="checkbox" id="localExcel" ${c.local.excel ? 'checked' : ''}> Also save an Excel copy</label></div>
          <div class="row"><input type="text" id="localDir" value="${esc(c.local.dir)}" placeholder="${esc(b.local.dir)}" style="flex:1;min-width:200px"><button class="btn" id="saveDir">Save folder</button></div>
          <p class="muted" style="margin:10px 0 0;font-size:12px">Currently: <code>${esc(b.local.dir)}</code>. ${b.local.insideData ? '<span class="warn">This is inside the data folder, on the same disk, so it will not survive a disk failure.</span> ' : ''}Tip: choose a folder on another drive, or one synced by Google Drive for desktop, Dropbox or iCloud.${c.local.excel ? ' With "Also save an Excel copy", each backup writes a matching <code>.xlsx</code> here too (the same number are kept).' : ''}${st.local?.excelError ? ` <span class="bad">Excel copy failed: ${esc(st.local.excelError)}</span>` : ''}</p>`)}
        ${card('Google Drive', g.connected ? `Connected${g.account ? ' as ' + esc(g.account) : ''} · ${statusLine(st.drive)}` : 'Upload encrypted backups to your own Google Drive.',
          !g.configured ? `<p class="muted" style="margin:0 0 8px">Google Drive needs a one-time setup (about 5 minutes):</p><ol class="muted" style="margin:0;padding-left:18px;font-size:13px;line-height:1.6"><li>In <b>console.cloud.google.com</b> create a project and enable the <b>Google Drive API</b>.</li><li>OAuth consent screen: type External, add your Google account as a test user, then <b>Publish app</b> (otherwise Google expires the connection after 7 days; the "unverified app" warning is normal for personal use).</li><li>Credentials → Create OAuth client ID → <b>Desktop app</b>.</li><li>Enter the client ID and secret under <a href="#/connections">Settings → Connections</a>, then come back here to connect.</li></ol><p class="muted" style="font-size:12px;margin:8px 0 0">Pennystead only requests the <code>drive.file</code> permission: it can see only the "Pennystead Backups" folder it creates, never the rest of your Drive.</p>`
          : !g.connected ? '<button class="btn primary" id="gConnect">Connect Google Drive</button><p class="muted" style="font-size:12px;margin:10px 0 0">You will be sent to Google to approve access to a "Pennystead Backups" folder only.</p>'
          : `<div class="row" style="margin-bottom:8px"><label class="chk row"><input type="checkbox" id="driveOn" ${c.drive.enabled ? 'checked' : ''}> Enabled</label><label class="muted" style="margin-left:12px">Keep last</label><input type="number" id="driveKeep" min="1" max="365" value="${c.drive.keep}" style="width:72px"></div><button class="btn danger" id="gOff">Disconnect</button>`)}
      </div>
      <div style="height:16px"></div>
      ${card('Available backups', 'Restoring replaces your current data. A safety copy of the current data is saved first.', '<div class="tbl" style="margin:0" id="blist"></div>')}
      ${card('Restore from a file', 'Use a backup file downloaded earlier or copied from another computer.', `<form id="upForm" class="row"><input type="file" name="f" accept=".bak,.enc" required><input type="password" name="p" placeholder="Passphrase (if encrypted)" style="width:220px"><button class="btn">Restore</button></form>`)}`;

    // ----- backup list (local now, Drive when it arrives) -----
    let driveRows = null, driveErr = null;
    const draw = () => {
      const rows = [...b.local.files.map((f) => ({ ...f, where: 'Local', id: f.name })), ...(driveRows || []).map((f) => ({ ...f, where: 'Google Drive', encrypted: f.name.endsWith('.enc') }))].sort((x, y) => y.createdAt.localeCompare(x.createdAt));
      $('#blist', el).innerHTML = `<table><thead><tr><th>Backup</th><th>Where</th><th>Created</th><th class="n">Size</th><th></th></tr></thead><tbody>${rows.map((r) => `<tr><td>${r.safety ? '<span class="tag" style="margin:0 6px 0 0">safety copy</span>' : ''}${r.encrypted ? '🔒 ' : ''}<span class="muted">${esc(r.name)}</span></td><td>${esc(r.where)}</td><td>${esc(when(r.createdAt))}</td><td class="n">${bytes(r.size)}</td>
        <td class="n">${r.where === 'Local' ? `<a class="btn sm" href="/api/backup/download?name=${encodeURIComponent(r.name)}">Download</a> ` : ''}<button class="btn sm" data-restore="${esc(r.where)}|${esc(r.id)}|${r.encrypted ? 1 : 0}">Restore</button></td></tr>`).join('') || '<tr><td colspan="5" class="empty">No backups yet. Click “Back up now”.</td></tr>'}</tbody></table>${driveErr ? `<p class="bad" style="padding:0 12px;font-size:12px">Google Drive: ${esc(driveErr)}</p>` : ''}`;
      $$('[data-restore]', el).forEach((btn) => (btn.onclick = async () => {
        const [where, id, enc] = btn.dataset.restore.split('|');
        if (!confirm('Replace ALL current data with this backup?\n\nA safety copy of your current data is saved first, and your bank connection is not affected.')) return;
        let pass; if (enc === '1' && !b.passphrase.set) { pass = prompt('This backup is encrypted. Enter its passphrase:'); if (!pass) return; }
        const r = await run(() => api('/api/backup/restore', 'POST', where === 'Local' ? { source: 'local', name: id, passphrase: pass } : { source: 'drive', id, passphrase: pass }));
        toast(`Restored ${r.restored} files. Safety copy: ${r.safetyBackup}`); setTimeout(() => location.reload(), 900);
      }));
    };
    draw();
    if (g.connected) api('/api/backup/drive').then((l) => { driveRows = l; draw(); }).catch((e) => { driveErr = e.message; draw(); });

    // ----- actions -----
    const saveCfg = (patch, msg = 'Saved') => run(() => api('/api/backup/config', 'PUT', patch), msg).then(() => go()).catch(() => go());
    $('#interval', el).onchange = (e) => saveCfg({ interval: e.target.value });
    $('#keep', el).onchange = (e) => saveCfg({ keep: +e.target.value });
    $('#localOn', el).onchange = (e) => saveCfg({ local: { enabled: e.target.checked } });
    $('#localExcel', el).onchange = (e) => saveCfg({ local: { excel: e.target.checked } }, e.target.checked ? 'Each backup now also saves an Excel copy (not encrypted)' : 'Excel copies off');
    $('#saveDir', el).onclick = () => saveCfg({ local: { dir: $('#localDir', el).value } }, 'Folder saved');
    $('#runNow', el).onclick = async (e) => {
      e.target.disabled = true; e.target.textContent = 'Backing up…';
      try { const r = await api('/api/backup/run', 'POST'); const bad = r.filter((x) => x.error); toast(bad.length ? `${bad[0].dest}: ${bad[0].error}` : r.length ? `Backed up to ${r.map((x) => x.dest).join(' and ')}` : 'No destinations enabled'); } catch (er) { toast(er.message); }
      go();
    };
    if ($('#passForm', el)) $('#passForm', el).onsubmit = async (e) => { e.preventDefault(); await run(() => api('/api/backup/passphrase', 'POST', { passphrase: new FormData(e.target).get('p') }), 'Passphrase saved'); go(); };
    if ($('#clearPass', el)) $('#clearPass', el).onclick = async () => { if (confirm('Remove the passphrase? New backups will be unencrypted, and Google Drive uploads will stop. Existing encrypted backups still need the old passphrase.')) { await api('/api/backup/passphrase', 'POST', { passphrase: null }); go(); } };
    if ($('#gConnect', el)) $('#gConnect', el).onclick = async () => { const r = await run(() => api('/api/backup/google/connect')); location.href = r.url; };
    if ($('#gOff', el)) $('#gOff', el).onclick = async () => { if (confirm('Disconnect Google Drive? Existing backups stay in your Drive.')) { await api('/api/backup/google/disconnect', 'POST'); go(); } };
    if ($('#driveOn', el)) $('#driveOn', el).onchange = (e) => saveCfg({ drive: { enabled: e.target.checked } });
    if ($('#driveKeep', el)) $('#driveKeep', el).onchange = (e) => saveCfg({ drive: { keep: +e.target.value } });
    $('#upForm', el).onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target.f.files[0], pass = e.target.p.value;
      if (!f || !confirm(`Replace ALL current data with "${f.name}"? A safety copy of the current data is saved first.`)) return;
      const r = await run(async () => { const res = await fetch('/api/backup/restore-upload', { method: 'POST', headers: pass ? { 'x-passphrase': pass } : {}, body: await f.arrayBuffer() }); const j = await res.json(); if (!res.ok) throw new Error(j.error); return j; });
      toast(`Restored ${r.restored} files. Safety copy: ${r.safetyBackup}`); setTimeout(() => location.reload(), 900);
    };
  },
};

// ---------- Import (CSV / Excel) ----------
const IMP_STATUS = { new: ['new', 'good'], duplicate: ['duplicate', ''], possible_duplicate: ['possible duplicate', 'warn'], overlap: ['overlaps bank sync', 'warn'] };
const imp = { d: null, step: 'upload', pv: null, done: null, account: '__new', newName: '', newCur: '', opts: {}, balance: '' };

pages.import = {
  title: 'Import',
  async render(el, { from } = {}) {
    // Arriving from another page starts a fresh import; in-wizard navigation (from === 'import') keeps its state.
    if (from !== 'import' && !imp.justDone) Object.assign(imp, { step: 'upload', d: null, done: null, pv: null });
    if (imp.step === 'upload') return impUpload(el);
    if (imp.step === 'map') return impMap(el);
    if (imp.step === 'preview') return impPreview(el);
    return impDone(el);
  },
};

// Clicking "Import" in the sidebar while already on the Import page starts over (the hash would not change).
document.addEventListener('click', (e) => {
  if (e.target.closest('a.nav[href="#/import"]') && location.hash.startsWith('#/import')) { Object.assign(imp, { step: 'upload', d: null, pv: null, done: null }); go(); }
});

async function impUpload(el) {
  const hist = await api('/api/import/history');
  el.innerHTML = `
    ${card('Import transactions', 'Load historical data from a CSV or Excel (.xlsx) export of your bank. You will map the columns, check a preview, and nothing is saved until you confirm. Every import can be undone.',
      `<label id="drop" tabindex="0" role="button" style="display:block;border:1.5px dashed var(--line);border-radius:10px;padding:34px 16px;text-align:center;cursor:pointer;color:var(--text2)">
        <div style="font-size:15px;color:var(--text)">Drop a file here or click to choose</div><div class="muted" style="margin-top:6px;font-size:12px">.csv, .tsv, .txt, .xlsx · up to 30 MB · comma, semicolon or tab separated · UTF-8 or Windows-1252</div>
        <input type="file" id="file" accept=".csv,.tsv,.txt,.xlsx,.xlsm,text/csv" class="sr-only"></label>
      <p class="muted" style="margin:10px 0 0;font-size:12px">Tip: if your bank offers several formats, pick CSV. Old <code>.xls</code> files: open in Excel and Save As .xlsx or CSV. Importing the same file twice is safe: duplicates are detected.</p>`)}
    ${card('Past imports', 'Undo removes exactly the transactions an import added and restores the account balance.', hist.length ? `<div class="tbl" style="margin:0"><table><thead><tr><th>File</th><th>Account</th><th class="n">Added</th><th>Period</th><th>Imported</th><th></th></tr></thead><tbody>${hist.map((h) => `<tr><td>${esc(h.file)}</td><td>${esc(h.account)}</td><td class="n">${h.added}</td><td class="muted">${esc(h.from || '')} → ${esc(h.to || '')}</td><td class="muted">${esc(new Date(h.at).toLocaleString())}</td><td class="n">${h.undoneAt ? '<span class="muted">undone</span>' : `<button class="btn sm danger" data-undo="${esc(h.id)}">Undo</button>`}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No imports yet.</p>')}`;
  const send = async (file) => {
    if (!file) return;
    toast(`Reading ${file.name}…`);
    try {
      const r = await fetch('/api/import/upload', { method: 'POST', headers: { 'x-filename': encodeURIComponent(file.name) }, body: await file.arrayBuffer() });
      const j = await r.json(); if (!r.ok) throw new Error(j.error);
      Object.assign(imp, { d: j, step: 'map', pv: null, opts: {}, balance: '', newName: file.name.replace(/\.[^.]+$/, ''), newCur: j.base });
      const pa = j.profileAccount; imp.account = pa?.uid && j.accounts.some((a) => a.uid === pa.uid) ? pa.uid : j.accounts.length ? j.accounts[0].uid : '__new';
      if (pa?.name) { imp.account = '__new'; imp.newName = pa.name; imp.newCur = pa.currency || j.base; }
      go();
    } catch (e) { toast(e.message); }
  };
  const drop = $('#drop', el);
  $('#file', el).onchange = (e) => send(e.target.files[0]);
  drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#file', el).click(); } };
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.style.borderColor = 'var(--accent)'; }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.style.borderColor = 'var(--line)'; }));
  drop.addEventListener('drop', (e) => send(e.dataTransfer.files[0]));
  $$('[data-undo]', el).forEach((b) => (b.onclick = async () => { if (!confirm('Undo this import? The transactions it added will be removed.')) return; await run(() => api('/api/import/undo', 'POST', { id: b.dataset.undo }), 'Import undone'); go(); }));
}

const colSel = (name, d, val, optional = true) => `<select name="${name}">${optional ? '<option value="">(none)</option>' : '<option value="">Choose…</option>'}${d.headers.map((h, i) => `<option value="${i}" ${val === i ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select>`;

function impMap(el) {
  const d = imp.d, m = d.mapping;
  const acct = imp.account, selAcct = d.accounts.find((a) => a.uid === acct);
  el.innerHTML = `
    <div class="crumb"><a id="back">← Choose another file</a></div>
    ${card(esc(d.filename), `${d.kind === 'xlsx' ? 'Excel workbook' : `CSV · ${esc(d.encoding)} · delimiter “${d.delimiter === '\t' ? 'tab' : esc(d.delimiter)}”`} · ${d.rowCount} data rows${d.fromProfile ? ' · <span class="good">using the mapping you saved for this layout</span>' : ''}`, `
      <div class="row" style="margin-bottom:12px">
        ${d.sheets ? `<label class="muted">Sheet</label><select id="sheet">${d.sheets.map((n, i) => `<option value="${i}" ${i === d.sheet ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>` : `<label class="muted">Delimiter</label><select id="delim">${[[',', 'comma ,'], [';', 'semicolon ;'], ['\t', 'tab'], ['|', 'pipe |']].map(([v, l]) => `<option value="${v}" ${d.delimiter === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`}
        <label class="muted" style="margin-left:10px">Header is on row</label><input type="number" id="hrow" min="0" value="${d.headerRow}" style="width:70px"><span class="muted" style="font-size:12px">(rows above it, such as account info, are ignored; 0 = the file has no header row)</span></div>
      <div class="tbl" style="margin:0"><table><thead><tr>${d.headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${d.sample.map((r) => `<tr>${r.map((c) => `<td class="muted" style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`)}
    <form id="mapForm">
    ${card('Where should these go?', 'Pick the account the transactions belong to.', `<div class="form">
        <label style="grid-column:span 2">Account<select name="account">${d.accounts.map((a) => `<option value="${esc(a.uid)}" ${a.uid === acct ? 'selected' : ''}>${esc(a.label)} (${esc(a.currency)}${a.synced ? ', bank-synced' : a.imported ? ', imported' : ''})</option>`).join('')}<option value="__new" ${acct === '__new' ? 'selected' : ''}>＋ New account…</option></select></label>
        <label id="nn" ${acct === '__new' ? '' : 'hidden'}>New account name<input type="text" name="newName" value="${esc(imp.newName)}" maxlength="60"></label>
        <label id="nc" ${acct === '__new' ? '' : 'hidden'}>Currency<input type="text" name="newCur" value="${esc(imp.newCur)}" maxlength="3" style="text-transform:uppercase"></label>
        <label id="bal" ${acct === '__new' || selAcct?.imported ? '' : 'hidden'}>Balance after the last row <span class="muted">(optional)</span><input type="number" name="balance" step="any" value="${esc(imp.balance)}" placeholder="${m.balance != null ? 'taken from the Balance column' : 'e.g. 8765.50'}"></label></div>
        ${selAcct?.synced ? '<p class="muted" style="margin:10px 0 0;font-size:12px">This account is synced from your bank. Rows older than the first synced transaction are added as history; the balance stays exactly as the bank reports it. Rows that overlap the synced period are skipped by default.</p>' : ''}`)}
    ${card('Match the columns', 'We guessed these from the headers. Adjust anything that looks wrong.', `<div class="form">
        <label>Date${colSel('date', d, m.date, false)}</label>
        <label>Date format<select name="dateFormat"><option value="auto" ${m.dateFormat === 'auto' ? 'selected' : ''}>Auto-detect</option><option value="DMY" ${m.dateFormat === 'DMY' ? 'selected' : ''}>Day first (31/12/2024)</option><option value="MDY" ${m.dateFormat === 'MDY' ? 'selected' : ''}>Month first (12/31/2024)</option></select></label>
        <label>Description / counterparty${colSel('desc', d, m.desc)}</label>
        <label>Message / reference (optional)${colSel('message', d, m.message)}</label>
        <label>Amounts are in<select name="mode"><option value="single" ${m.mode === 'single' ? 'selected' : ''}>One column (negative = money out)</option><option value="split" ${m.mode === 'split' ? 'selected' : ''}>Separate debit and credit columns</option><option value="dir" ${m.mode === 'dir' ? 'selected' : ''}>Amount + a direction column</option></select></label>
        <label data-mode="single dir">Amount${colSel('amount', d, m.amount)}</label>
        <label data-mode="dir">Direction (debit/credit)${colSel('direction', d, m.direction)}</label>
        <label data-mode="split">Debit / paid out${colSel('debit', d, m.debit)}</label>
        <label data-mode="split">Credit / paid in${colSel('credit', d, m.credit)}</label>
        <label>Number format<select name="decimal"><option value="auto" ${m.decimal === 'auto' ? 'selected' : ''}>Auto-detect</option><option value="." ${m.decimal === '.' ? 'selected' : ''}>1,234.56 (dot decimal)</option><option value="," ${m.decimal === ',' ? 'selected' : ''}>1.234,56 (comma decimal)</option></select></label>
        <label>Currency column (optional)${colSel('currency', d, m.currency)}</label>
        <label>Category column (optional)${colSel('category', d, m.category)}</label>
        <label>Balance column (optional)${colSel('balanceCol', d, m.balance)}</label>
        <label class="chk"><input type="checkbox" name="invert" ${m.invert ? 'checked' : ''}> Flip signs (expenses are positive in my file)</label>
        <label class="chk" id="uc"><input type="checkbox" name="useCategory" ${imp.opts.useCategory ? 'checked' : ''}> Use the category column when it matches one of my categories</label></div>`)}
    <div class="row" style="margin-bottom:24px"><button class="btn primary" id="toPreview">Preview →</button><span class="muted" style="font-size:12px">Nothing is saved yet.</span></div></form>`;

  const form = $('#mapForm', el), sync = () => {
    const mode = form.elements.mode.value;
    $$('[data-mode]', form).forEach((l) => (l.hidden = !l.dataset.mode.split(' ').includes(mode)));
    const a = form.elements.account.value, ac = d.accounts.find((x) => x.uid === a);
    $('#nn', form).hidden = $('#nc', form).hidden = a !== '__new'; $('#bal', form).hidden = !(a === '__new' || ac?.imported);
    $('#uc', form).hidden = form.elements.category.value === '';
  };
  form.onchange = (e) => { if (e.target.name === 'account') { impCollect(form); imp.d.mapping = { ...imp.mapping }; go(); return; } sync(); }; sync();
  $('#back', el).onclick = () => { imp.step = 'upload'; imp.d = null; go(); };
  const reparse = async (patch) => { imp.d = await run(() => api('/api/import/reparse', 'POST', { importId: d.importId, ...patch })); go(); };
  if ($('#sheet', el)) $('#sheet', el).onchange = (e) => reparse({ sheet: +e.target.value });
  if ($('#delim', el)) $('#delim', el).onchange = (e) => reparse({ delimiter: e.target.value, headerRow: +$('#hrow', el).value });
  $('#hrow', el).onchange = (e) => reparse({ headerRow: +e.target.value, sheet: d.sheet ?? undefined, delimiter: d.delimiter ?? undefined });
  form.onsubmit = async (e) => { e.preventDefault(); await impCollect(form); await impRunPreview(); };
}

const num = (v) => (v === '' || v == null ? null : +v);
function impCollect(form) {
  const f = form.elements, d = imp.d;
  imp.mapping = { date: num(f.date.value), dateFormat: f.dateFormat.value, desc: num(f.desc.value), message: num(f.message.value), mode: f.mode.value, amount: num(f.amount.value), direction: num(f.direction.value), debit: num(f.debit.value), credit: num(f.credit.value), decimal: f.decimal.value, currency: num(f.currency.value), category: num(f.category.value), balance: num(f.balanceCol.value), invert: f.invert.checked };
  imp.account = f.account.value; imp.newName = f.newName.value; imp.newCur = f.newCur.value.toUpperCase(); imp.balance = f.balance.value;
  imp.opts = { ...imp.opts, useCategory: f.useCategory.checked && imp.mapping.category != null };
}
const impAccountBody = () => (imp.account === '__new' ? { name: imp.newName, currency: imp.newCur } : { uid: imp.account });
const impOptions = () => ({ ...imp.opts, balance: imp.balance === '' ? undefined : imp.balance });
async function impRunPreview() {
  try { imp.pv = await api('/api/import/preview', 'POST', { importId: imp.d.importId, mapping: imp.mapping, account: impAccountBody(), options: impOptions() }); imp.step = 'preview'; go(); } catch (e) { toast(e.message); }
}

/** Warnings about guesses the file could not settle, and a cross-check against the file's own Balance column. */
function impChecks(p) {
  const out = [], a = p.ambiguous || {}, bc = p.balanceCheck;
  const other = p.decimal === ',' ? '1,234.56 (dot decimal)' : '1.234,56 (comma decimal)';
  if (a.decimal) out.push(`<div class="banner"><span class="warn">Amounts like <b>12.500</b> could mean twelve and a half or twelve thousand five hundred. We read them as <b>${p.decimal === ',' ? '1.234,56' : '1,234.56'}</b>.</span><span class="row"><button class="btn sm" data-fix="keepDecimal">That's right</button><button class="btn sm" data-fix="decimal">Use ${other}</button></span></div>`);
  if (a.date) out.push(`<div class="banner"><span class="warn">Every date in this file works both ways (03/04 is 3 April or March 4). We read them <b>${p.dateOrder === 'MDY' ? 'month first' : 'day first'}</b>, because that keeps the statement in one period.</span><span class="row"><button class="btn sm" data-fix="keepDate">That's right</button><button class="btn sm" data-fix="date">Use ${p.dateOrder === 'MDY' ? 'day' : 'month'} first</button></span></div>`);
  if (bc && !bc.ok) {
    const fix = { flip: '<button class="btn sm" data-fix="flip">Flip signs</button>', decimal: '<button class="btn sm" data-fix="decimal">Switch number format</button>' }[bc.hint] || '';
    const why = { flip: 'Money in and out look swapped.', decimal: 'The decimal separator looks wrong (amounts are off by 1,000×).', check: 'Check that the amount column (or debit/credit columns) is the right one.' }[bc.hint];
    out.push(`<div class="banner"><span class="bad">The file's Balance column does not follow the amounts in ${bc.pairs - bc.matching} of ${bc.pairs} rows. ${why}</span>${fix}</div>`);
  } else if (bc?.ok) out.push(`<p class="muted" style="margin:0 0 12px;font-size:13px"><span class="good">✓</span> Amounts match the file's own Balance column (${bc.matching} of ${bc.pairs} rows).</p>`);
  return out.join('');
}

function impPreview(el) {
  const p = imp.pv, c = p.counts, cur = p.account.currency;
  const chip = (n, label, cls = '') => (n ? `<span class="pill ${cls}" style="margin-right:6px">${n} ${label}</span>` : '');
  el.innerHTML = `
    <div class="crumb"><a id="back">← Change mapping</a> · <a id="restart">Start over</a></div>
    <div class="kpis">
      ${kpi('Will be imported', String(c.toImport), `into ${esc(p.account.label)}${p.account.isNew ? ' (new account)' : ''}`, p.from ? `${esc(p.from)} → ${esc(p.to)}` : '')}
      ${kpi('Money in', money(p.totals.in, cur), '', '', 'good')}
      ${kpi('Money out', money(p.totals.out, cur), '', '', '')}
      ${kpi('Detected', `${p.decimal === ',' ? '1.234,56' : '1,234.56'}`, `dates: ${p.dateOrder === 'MDY' ? 'month first' : 'day first'}`, '')}</div>
    ${impChecks(p)}
    <div class="card"><div style="margin-bottom:8px">${chip(c.new, 'new', 'good')}${chip(c.duplicate, 'duplicates (already in your data, skipped)')}${chip(c.possible_duplicate, 'possible duplicates', 'warn')}${chip(c.overlap, 'overlap the bank-synced period', 'warn')}${chip(c.errors, 'rows with problems (skipped)', 'bad')}${chip(c.blank, 'blank rows ignored')}</div>
      ${c.possible_duplicate ? `<label class="chk row" style="margin:6px 0"><input type="checkbox" id="oPoss" ${imp.opts.includePossible ? 'checked' : ''}> Also import the ${c.possible_duplicate} possible duplicate(s) (same date and amount as an existing transaction, different text)</label>` : ''}
      ${c.overlap ? `<label class="chk row" style="margin:6px 0"><input type="checkbox" id="oOver" ${imp.opts.includeOverlap ? 'checked' : ''}> Also import the ${c.overlap} row(s) that fall inside the period your bank already syncs</label>` : ''}
      ${p.balance ? `<p class="muted" style="margin:8px 0 0;font-size:13px">${p.balance.used ? `Account balance will be set to <b>${money(p.balance.value, cur, { d: 2 })}</b> as of ${esc(p.balance.date)} (${p.balance.source === 'column' ? 'from the Balance column' : 'as you entered'}).` : `<span class="warn">The balance in this file (${money(p.balance.value, cur, { d: 2 })} on ${esc(p.balance.date)}) is older than your latest data, so it is ignored and today's balance is kept.</span>`}</p>` : p.account.isNew ? '<p class="muted" style="margin:8px 0 0;font-size:13px">No balance given: the account balance will be the sum of these transactions (starting from zero). Go back and enter a balance to start from a real figure.</p>' : ''}
      ${p.unmappedCategories ? `<p class="muted" style="margin:8px 0 0;font-size:12px">${p.unmappedCategories} category value(s) in your file did not match one of your categories; your rules categorize those.</p>` : ''}</div>
    ${card('Preview', `First ${p.sample.length} rows. Categories come from your rules and can be changed afterwards.`, `<div class="tbl" style="margin:0"><table><thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Status</th><th class="n">Amount</th></tr></thead><tbody>${p.sample.map((r) => `<tr style="${r.include ? '' : 'opacity:.5'}"><td class="muted" style="white-space:nowrap">${esc(r.date)}</td><td>${esc(r.desc)}</td><td class="muted">${esc(catLabel(r.category))}</td><td><span class="pill ${IMP_STATUS[r.status][1]}">${IMP_STATUS[r.status][0]}</span></td><td class="n ${r.amount < 0 ? '' : 'good'}">${money2(r.amount, cur)}</td></tr>`).join('')}</tbody></table></div>`)}
    ${p.errors.length ? card(`Rows with problems (${c.errors})`, 'These rows are skipped. Fix the mapping above or correct the file if they should be included.', `<div class="tbl" style="margin:0"><table><tbody>${p.errors.map((e) => `<tr><td class="muted" style="width:70px">row ${e.line}</td><td class="bad" style="width:36%">${esc(e.error)}</td><td class="muted">${esc(e.values)}</td></tr>`).join('')}</tbody></table></div>`) : ''}
    <div class="row" style="margin-bottom:24px"><button class="btn primary" id="commit" ${c.toImport ? '' : 'disabled'}>Import ${c.toImport} transaction${c.toImport === 1 ? '' : 's'}</button><button class="btn" id="back2">Back</button></div>`;
  $('#back', el).onclick = $('#back2', el).onclick = () => { imp.d.mapping = { ...imp.mapping }; imp.step = 'map'; go(); };
  $('#restart', el).onclick = () => { Object.assign(imp, { step: 'upload', d: null, pv: null }); go(); };
  // One-click fixes from the checks above. The choice becomes part of the mapping, which is saved for this bank's files.
  $$('[data-fix]', el).forEach((b) => (b.onclick = () => {
    const f = b.dataset.fix, m = imp.mapping;
    if (f === 'decimal') m.decimal = p.decimal === ',' ? '.' : ',';
    if (f === 'keepDecimal') m.decimal = p.decimal;
    if (f === 'date') m.dateFormat = p.dateOrder === 'MDY' ? 'DMY' : 'MDY';
    if (f === 'keepDate') m.dateFormat = p.dateOrder;
    if (f === 'flip') m.invert = !m.invert;
    impRunPreview();
  }));
  if ($('#oPoss', el)) $('#oPoss', el).onchange = (e) => { imp.opts.includePossible = e.target.checked; impRunPreview(); };
  if ($('#oOver', el)) $('#oOver', el).onchange = (e) => { imp.opts.includeOverlap = e.target.checked; impRunPreview(); };
  $('#commit', el).onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = 'Importing…';
    try { imp.done = await api('/api/import/commit', 'POST', { importId: imp.d.importId, mapping: imp.mapping, account: impAccountBody(), options: impOptions() }); imp.step = 'done'; imp.justDone = true; } catch (er) { toast(er.message); }
    go();
  };
}

function impDone(el) {
  const r = imp.done; imp.justDone = false;
  el.innerHTML = card('Import complete', `${r.added} transactions added to ${esc(r.account)} (${esc(r.from)} → ${esc(r.to)}).`, `<div class="row"><a class="btn primary" href="#/transactions">View transactions</a><a class="btn" href="#/review">Review uncategorized</a><a class="btn" href="#/overview">Overview</a><button class="btn" id="again">Import another file</button><button class="btn danger" id="undo">Undo this import</button></div>
    <p class="muted" style="font-size:12px;margin:12px 0 0">Anything your rules could not categorize is waiting in <b>Review</b>: assign a merchant once and all of its transactions follow. Your column mapping was saved and will be suggested next time for files with the same layout.</p>`);
  $('#again', el).onclick = () => { Object.assign(imp, { step: 'upload', d: null, done: null }); go(); };
  $('#undo', el).onclick = async () => { if (!confirm('Undo this import?')) return; await run(() => api('/api/import/undo', 'POST', { id: r.batch }), 'Import undone'); Object.assign(imp, { step: 'upload', d: null, done: null }); go(); };
}

// ---------- Connections (credentials) ----------
pages.chat = {
  title: 'Chat with AI',
  async render(el) {
    const [c, prompts] = await Promise.all([api('/api/mcp-config'), api('/api/mcp-prompts')]);
    el.innerHTML = `
      <p class="muted" style="margin:0 0 16px">Pennystead can answer questions about your money through Claude, using your own Claude Desktop or Claude Code. Claude runs a small Pennystead helper on this computer; nothing is sent anywhere until you ask Claude something, and then only the answers it needs go to Claude. Names, IBANs and long numbers are masked by default.</p>
      ${card('Claude Desktop', 'Open Claude Desktop → Settings → Developer → Edit Config, add this, save, and restart Claude Desktop. If the file already has "mcpServers", add just the "pennystead" entry inside it.', `<pre style="margin:0 0 10px;padding:12px;background:var(--card2);border-radius:8px;overflow:auto;font-size:12px">${esc(c.desktop)}</pre><button type="button" class="btn sm" data-copy="${esc(c.desktop)}">Copy</button>`)}
      ${card('Claude Code', 'Run this once in a terminal.', `<pre style="margin:0 0 10px;padding:12px;background:var(--card2);border-radius:8px;overflow:auto;font-size:12px">${esc(c.claudeCode)}</pre><button type="button" class="btn sm" data-copy="${esc(c.claudeCode)}">Copy</button>`)}
      ${card('Guided reviews', 'One click in Claude Desktop: open the + menu in a new chat, choose Pennystead, and pick a review. Claude fetches what it needs and writes it up.', `<div class="tbl" style="margin:0"><table><tbody>${prompts.map((p) => `<tr><td style="white-space:nowrap"><b>${esc(p.title)}</b></td><td class="muted">${esc(p.description)}</td></tr>`).join('')}</tbody></table></div>`)}
      ${card('Or just ask', '', '<ul class="muted" style="margin:0;padding-left:18px;line-height:1.8"><li>What is my net worth, and how has it changed this year?</li><li>Which subscriptions have gone up in price?</li><li>Did anything unusual happen in my spending last month?</li><li>Am I on track with my budgets?</li></ul>')}
      <p class="muted" style="font-size:12px">Read-only by default. Add <code>--write</code> to the arguments to also let Claude record a new value for a manual asset (for example "my car is worth 15,500 now").</p>`;
  },
};

pages.connections = {
  title: 'Connections',
  async render(el) {
    const c = await api('/api/settings');
    const status = (x) => (x.configured ? `<span class="good">Configured</span>${x.source === 'environment' ? ' <span class="muted">(from an environment variable)</span>' : ''}` : '<span class="muted">Not set up</span>');
    const copy = (id, v) => `<div class="row"><code id="${id}" style="padding:4px 8px;background:var(--card2);border-radius:6px;word-break:break-all">${esc(v)}</code><button type="button" class="btn sm" data-copy="${esc(v)}">Copy</button></div>`;
    el.innerHTML = `
      <p class="muted" style="margin:0 0 16px">These credentials are stored only on this computer, are never included in backups, and are never shown again after saving.</p>
      ${card('Bank sync · Enable Banking', status(c.enablebanking) + (c.enablebanking.appId ? ` · Application ID <code>${esc(c.enablebanking.appId)}</code>` : ''), `
        <ol class="muted" style="margin:0 0 12px;padding-left:18px;font-size:13px;line-height:1.7"><li>Create a free account at <b>enablebanking.com</b> and open the Control Panel → API applications → <b>Add a new application</b>.</li>
          <li>Choose the <b>Production</b> environment with <b>linked accounts</b> (free for your own accounts). The Sandbox only returns fake data.</li>
          <li>Set the redirect URL to exactly:${copy('ru', c.redirectUrl)}</li>
          <li>Your browser downloads a <code>.pem</code> private key. Choose it below, and enter the Application ID shown in the control panel.</li></ol>
        <form id="ebForm" class="form" style="margin-bottom:10px"><label>Application ID<input type="text" name="appId" value="${esc(c.enablebanking.appId || '')}" required autocomplete="off"></label>
          <label>Private key (.pem file)<input type="file" name="key" accept=".pem,.key,text/plain" ${c.enablebanking.configured ? '' : 'required'}></label>
          <div class="row"><button class="btn primary">${c.enablebanking.configured ? 'Replace' : 'Save'}</button>${c.enablebanking.configured && c.enablebanking.source !== 'environment' ? '<button type="button" class="btn danger" id="ebClear">Remove</button>' : ''}${c.enablebanking.configured ? '<button type="button" class="btn" id="ebTest">Test connection</button>' : ''}</div></form>
        <details style="font-size:12px"><summary class="muted" style="cursor:pointer">Use a different redirect address</summary>
          <p class="muted" style="margin:8px 0">Enable Banking only accepts <code>https</code> addresses. The default is a small page that sends you straight back to Pennystead on this computer. If you register a different address (for example <code>https://localhost:${esc(location.port || '3456')}/callback</code>), enter it here; when your bank cannot bring you back, paste the address you end up on under Settings → Banks.</p>
          ${c.redirectFromEnv ? '<p class="muted">Set by the REDIRECT_URL environment variable.</p>' : `<form id="ruForm" class="row"><input type="text" name="url" value="${esc(c.redirectUrl)}" style="min-width:320px"><button class="btn sm">Save</button>${c.redirectUrl !== c.relayUrl ? '<button type="button" class="btn sm" id="ruReset">Use the default</button>' : ''}</form>`}</details>`)}
      ${card('Prices &amp; exchange rates · Alpha Vantage', status(c.alphavantage), `<p class="muted" style="margin:0 0 10px;font-size:13px">Optional. Used for stock prices and currency conversion. Get a free key at <b>alphavantage.co</b> (25 requests per day).</p>
        <form id="avForm" class="row"><input type="password" name="apiKey" placeholder="API key" autocomplete="off" required style="width:280px"><button class="btn primary">${c.alphavantage.configured ? 'Replace' : 'Save'}</button>${c.alphavantage.configured && c.alphavantage.source !== 'environment' ? '<button type="button" class="btn danger" id="avClear">Remove</button>' : ''}</form>`)}
      ${card('Google Drive backups', status(c.google) + (c.google.clientId ? ` · <code>${esc(c.google.clientId.slice(0, 18))}…</code>` : ''), `<p class="muted" style="margin:0 0 10px;font-size:13px">Optional. Create an OAuth client of type <b>Desktop app</b> in Google Cloud (steps are on the <a href="#/backups">Backups</a> page) and use this redirect URI if asked:</p>${copy('gu', c.googleRedirectUrl)}
        <form id="gForm" class="form" style="margin-top:10px"><label>Client ID<input type="text" name="clientId" value="${esc(c.google.clientId || '')}" required autocomplete="off"></label><label>Client secret<input type="password" name="clientSecret" required autocomplete="off"></label>
          <div class="row"><button class="btn primary">${c.google.configured ? 'Replace' : 'Save'}</button>${c.google.configured && c.google.source !== 'environment' ? '<button type="button" class="btn danger" id="gClear">Remove</button>' : ''}</div></form>`)}`;
    const save = (url, body, msg) => run(() => api(url, 'PUT', body), msg).then(() => ST && go());
    $('#ebForm', el).onsubmit = async (e) => {
      e.preventDefault(); const f = e.target, file = f.key.files[0];
      if (!file) return toast('Choose your .pem private key file');
      await save('/api/settings/enablebanking', { appId: f.appId.value, privateKey: await file.text() }, 'Saved');
    };
    if ($('#ruForm', el)) $('#ruForm', el).onsubmit = async (e) => { e.preventDefault(); await run(() => api('/api/connect/redirect', 'POST', { url: e.target.url.value.trim() }), 'Redirect address saved'); go(); };
    if ($('#ruReset', el)) $('#ruReset', el).onclick = async () => { await run(() => api('/api/connect/redirect', 'POST', { url: '' }), 'Back to the default'); go(); };
    $('#avForm', el).onsubmit = (e) => { e.preventDefault(); save('/api/settings/alphavantage', { apiKey: e.target.apiKey.value }, 'Saved'); };
    $('#gForm', el).onsubmit = (e) => { e.preventDefault(); save('/api/settings/google', { clientId: e.target.clientId.value, clientSecret: e.target.clientSecret.value }, 'Saved'); };
    for (const [id, name] of [['ebClear', 'enablebanking'], ['avClear', 'alphavantage'], ['gClear', 'google']]) if ($('#' + id, el)) $('#' + id, el).onclick = async () => { if (confirm('Remove these saved credentials?')) { await run(() => api('/api/settings/' + name, 'DELETE'), 'Removed'); go(); } };
    if ($('#ebTest', el)) $('#ebTest', el).onclick = async () => { const r = await run(() => api('/api/settings/test-bank', 'POST')); toast(`Connected to Enable Banking (${r.banks} banks found in Finland)`); };
  },
};

// ---------- Security & about ----------
pages.security = {
  title: 'Security',
  async render(el) {
    const [a, auto, win] = await Promise.all([api('/api/auth/status'), api('/api/autostart'), api('/api/window')]);
    el.innerHTML = `
      ${card('Password', a.required ? '<span class="good">A password is required to open Pennystead.</span>' : 'Pennystead is only reachable from this computer. A password adds protection if other people can use it.', `
        <form id="pwForm" class="form" style="max-width:640px">${a.required ? '<label>Current password<input type="password" name="current" required autocomplete="current-password"></label>' : ''}
          <label>${a.required ? 'New password' : 'Choose a password'} (8+ characters)<input type="password" name="password" minlength="8" autocomplete="new-password"></label>
          <div class="row"><button class="btn primary">${a.required ? 'Change password' : 'Set password'}</button>${a.required ? '<button type="button" class="btn danger" id="pwOff">Remove password</button>' : ''}</div></form>
        <p class="muted" style="font-size:12px;margin:10px 0 0">Passwords are stored as a salted hash. Five wrong attempts lock sign-in for 15 minutes. If you forget it, delete <code>auth.json</code> from your data folder while Pennystead is closed.</p>`)}
      ${card('Window', win.browser ? `Pennystead opens in its own window using ${esc(win.browser)}, without tabs or an address bar.` : 'Pennystead opens in its own window when Google Chrome, Microsoft Edge or Brave is installed. None was found, so it opens in your default browser.', `<label class="chk row"><input type="checkbox" id="win" ${win.mode !== 'browser' ? 'checked' : ''}> Open in its own window</label>`)}
      ${card('Start with my computer', auto.supported ? 'Open Pennystead in the background when you sign in to your computer, so scheduled syncs and backups keep running.' : (auto.reason || 'Not available.'), auto.supported ? `<label class="chk row"><input type="checkbox" id="auto" ${auto.enabled ? 'checked' : ''}> Start Pennystead when I log in</label>` : '')}
      ${ST.packaged ? card('Quit Pennystead', 'Stops Pennystead completely. Scheduled syncs and backups run only while it is open.', '<button class="btn danger" id="quit">Quit Pennystead</button>') : ''}
      ${card('About', `Pennystead ${esc(ST.version)}`, `<div class="muted" style="font-size:13px;line-height:1.8">Your data is stored in <code>${esc(ST.dataDir || '')}</code>.<br>Pennystead listens only on this computer (port ${ST.port}). It contacts the internet only for the services you set up: your bank (via Enable Banking), Alpha Vantage prices, and Google Drive backups.</div>`)}`;
    $('#pwForm', el).onsubmit = async (e) => { e.preventDefault(); const f = e.target; try { await api('/api/auth/password', 'POST', { current: f.current?.value, password: f.password.value }); toast('Password saved'); go(); } catch (er) { toast(er.message); } };
    if ($('#pwOff', el)) $('#pwOff', el).onclick = async () => { const cur = prompt('Enter your current password to remove it:'); if (cur == null) return; try { await api('/api/auth/password', 'POST', { current: cur, password: null }); toast('Password removed'); go(); } catch (er) { toast(er.message); } };
    if ($('#quit', el)) $('#quit', el).onclick = async () => { if (!confirm('Quit Pennystead? You can start it again from your applications.')) return; try { await api('/api/quit', 'POST'); } catch { /* the server is gone */ } document.body.innerHTML = '<p style="font-family:system-ui;padding:40px;text-align:center">Pennystead has stopped. You can close this tab.</p>'; };
    $('#win', el).onchange = async (e) => { try { await api('/api/window', 'POST', { mode: e.target.checked ? 'app' : 'browser' }); toast('Takes effect the next time you open Pennystead'); } catch (er) { toast(er.message); e.target.checked = !e.target.checked; } };
    if ($('#auto', el)) $('#auto', el).onchange = async (e) => { try { await api('/api/autostart', 'POST', { enabled: e.target.checked }); toast(e.target.checked ? 'Pennystead will start when you log in' : 'Start at login turned off'); } catch (er) { toast(er.message); e.target.checked = !e.target.checked; } };
  },
};

go();
