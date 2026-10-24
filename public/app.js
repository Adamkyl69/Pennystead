// Pennystead dashboard: vanilla JS, hash-routed pages, hand-rolled SVG charts.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let BASE = null, ST = {};

async function api(url, method = 'GET', body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && j.login) { location.href = '/login'; throw new Error('Login required'); }
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
// run() already toasts the error; don't also log it as an uncaught rejection
addEventListener('unhandledrejection', (e) => e.preventDefault());
function toast(msg) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.append(t); setTimeout(() => t.remove(), 2600); }
const run = async (fn, ok) => { try { const r = await fn(); if (ok) toast(ok); return r; } catch (e) { toast(e.message); throw e; } };

// ---------- formatting ----------
function money(n, cur = BASE, o = {}) {
  if (n == null || Number.isNaN(+n)) return '—';
  const d = o.d ?? 0;
  if (!cur) return (+n).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d, signDisplay: o.sign ? 'exceptZero' : 'auto' }); // no currency known yet
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, maximumFractionDigits: d, minimumFractionDigits: d, signDisplay: o.sign ? 'exceptZero' : 'auto' }).format(n); }
  catch { return `${(+n).toLocaleString(undefined, { maximumFractionDigits: Math.max(d, 2) })} ${cur}`; }
}
const money2 = (n, c) => money(n, c, { d: 2 });
const shiftISO = (iso, days) => new Date(Date.parse(iso + 'T00:00:00Z') + days * 864e5).toISOString().slice(0, 10);
const compact = (n) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: Math.abs(n) < 10 && n % 1 ? 2 : 1 }).format(n);
const pct = (p) => (p == null ? '—' : `${p > 0 ? '+' : ''}${p}%`);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function keyLabel(k, period = 'month') {
  if (period === 'year') return k;
  if (period === 'quarter') return `Q${k.slice(6)} ’${k.slice(2, 4)}`;
  if (period === 'week') return `${+k.slice(8)} ${MON[+k.slice(5, 7) - 1]}`;
  return `${MON[+k.slice(5, 7) - 1]} ’${k.slice(2, 4)}`;
}
function ago(iso) {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}
const bytes = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const dayLabel = (d) => `${+d.slice(8)} ${MON[+d.slice(5, 7) - 1]} ${d.slice(2, 4)}`;
const monthLong = (k) => new Date(k + '-01T00:00:00Z').toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const catLabel = (c) => c === 'transfers:internal' ? 'Internal transfer' : c.replace(/^(expenses|income|transfers):?/, '').split(':').filter(Boolean).map((s) => s[0].toUpperCase() + s.slice(1).replace(/-/g, ' ')).join(' › ') || 'All';
const leaf = (c) => catLabel(c).split(' › ').pop();
const COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)'];

// ---------- tooltip ----------
const tipEl = $('#tip');
function showTip(html, e) {
  tipEl.innerHTML = html; tipEl.style.display = 'block';
  const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  tipEl.style.left = Math.min(e.clientX + 14, innerWidth - w - 8) + 'px';
  tipEl.style.top = Math.max(8, Math.min(e.clientY - h / 2, innerHeight - h - 8)) + 'px';
}
const hideTip = () => (tipEl.style.display = 'none');

// ---------- chart primitives ----------
let redraws = [];
const onResize = (fn) => redraws.push(fn);
let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => redraws.forEach((f) => f()), 150); });

function niceTicks(lo, hi, n = 5) {
  if (hi === lo) hi = lo + 1;
  const raw = (hi - lo) / (n - 1), mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const min = Math.floor(lo / step) * step, max = Math.ceil(hi / step) * step, ticks = [];
  for (let v = min; v <= max + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { ticks, min, max };
}
const gridY = (ticks, y, L, W, R) => ticks.map((t) => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line)" stroke-dasharray="${t === 0 ? '' : '2 4'}"/><text x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${compact(t)}</text>`).join('');
function xLabels(n, x, label, W, minGap = 64) {
  const every = Math.max(1, Math.ceil(minGap / ((W - 80) / Math.max(n - 1, 1))));
  let out = '';
  for (let i = 0; i < n; i += every) out += `<text x="${x(i)}" y="__Y__" text-anchor="middle">${esc(label(i))}</text>`;
  return out;
}
function roundTop(x, y, w, h, r) {
  r = Math.min(r, h, w / 2);
  return `M${x} ${y + h}L${x} ${y + r}Q${x} ${y} ${x + r} ${y}L${x + w - r} ${y}Q${x + w} ${y} ${x + w} ${y + r}L${x + w} ${y + h}Z`;
}
// A dashed series gets a dashed line swatch, so "Projected" is told apart from "Saved" without relying on color.
const legend = (items) => `<div class="legend">${items.map((i) => `<span>${i.dash || i.ref ? `<svg width="18" height="8" aria-hidden="true" style="margin-right:6px;vertical-align:middle"><line x1="1" x2="17" y1="4" y2="4" stroke="${i.color}" stroke-width="2" stroke-dasharray="${i.ref ? '2 3' : '5 3'}"/></svg>` : `<span class="sw" style="background:${i.color}"></span>`}${esc(i.name)}</span>`).join('')}</div>`;

/** Lines over a shared x axis. series: [{name,color,points:[{x,y}]}] */
/**
 * Line chart. series: [{ name, color, points: [{x, y}], dash? }]; a null y leaves a gap (actual history stops where
 * the projection starts). refs: horizontal reference lines [{ y, label }] such as a target; marks: vertical
 * markers [{ i, label }] such as "Today" or a deadline.
 */
function lineChart(el, { series, height = 250, fmtX = (x) => x, fmtTip, refs = [], marks = [] }) {
  const draw = () => {
    const W = el.clientWidth || 700, H = height, L = 52, R = 12, T = refs.length || marks.length ? 18 : 8, B = 26, n = series[0]?.points.length || 0;
    if (n < 2) { el.innerHTML = '<p class="empty">Not enough history yet.</p>'; return; }
    const ys = [...series.flatMap((s) => s.points.map((p) => p.y)).filter((v) => v != null), ...refs.map((r) => r.y)];
    const { ticks, min, max } = niceTicks(Math.min(0, ...ys), Math.max(0, ...ys));
    const x = (i) => L + ((W - L - R) * i) / (n - 1), y = (v) => T + (H - T - B) * (1 - (v - min) / (max - min || 1));
    const line = (s) => { let d = '', pen = false; s.points.forEach((p, i) => { if (p.y == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.y).toFixed(1)}`; pen = true; }); return d; };
    const paths = series.map((s) => `<path d="${line(s)}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"${s.dash ? ' stroke-dasharray="6 5"' : ''}/>`).join('');
    const refLines = refs.map((r) => `<line x1="${L}" x2="${W - R}" y1="${y(r.y)}" y2="${y(r.y)}" stroke="var(--text2)" stroke-width="1.5" stroke-dasharray="2 4"/><text x="${W - R}" y="${y(r.y) - 5}" text-anchor="end" style="fill:var(--text2)">${esc(r.label)}</text>`).join('');
    const markLines = marks.filter((m) => m.i >= 0 && m.i < n).map((m) => `<line x1="${x(m.i)}" x2="${x(m.i)}" y1="${T - 4}" y2="${H - B}" stroke="var(--muted)" stroke-width="1"/><text x="${x(m.i)}" y="${T - 7}" text-anchor="${x(m.i) > W - 60 ? 'end' : 'middle'}">${esc(m.label)}</text>`).join('');
    el.innerHTML = `<svg width="${W}" height="${H}" role="img">${gridY(ticks, y, L, W, R)}${xLabels(n, x, (i) => fmtX(series[0].points[i].x), W).replaceAll('__Y__', H - 6)}${markLines}${refLines}${paths}
      <line id="cx" y1="${T}" y2="${H - B}" stroke="var(--muted)" stroke-dasharray="3 3" style="display:none"/><g id="dots"></g><rect x="${L}" y="0" width="${W - L - R}" height="${H}" fill="transparent" id="hit"/></svg>`;
    const svg = $('svg', el), hit = $('#hit', el);
    hit.onmousemove = (e) => {
      const r = svg.getBoundingClientRect(), i = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left - L) / (W - L - R)) * (n - 1))));
      const cx = $('#cx', el); cx.style.display = ''; cx.setAttribute('x1', x(i)); cx.setAttribute('x2', x(i));
      const here = series.filter((s) => s.points[i].y != null);
      $('#dots', el).innerHTML = here.map((s) => `<circle cx="${x(i)}" cy="${y(s.points[i].y)}" r="4" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`).join('');
      showTip(`<b>${esc(fmtX(series[0].points[i].x))}</b>` + here.map((s) => `<div class="r"><span><span class="sw" style="background:${s.color}"></span>${esc(s.name)}</span><span>${(fmtTip || money)(s.points[i].y)}</span></div>`).join(''), e);
    };
    hit.onmouseleave = () => { hideTip(); $('#cx', el).style.display = 'none'; $('#dots', el).innerHTML = ''; };
  };
  draw(); onResize(draw);
}

/** Donut: slices [{key,name,value}]; click a slice for onSelect(key). The centre shows the total (or the hovered slice). */
function donut(el, { slices, onSelect, height = 260, centre = '' }) {
  const colorOf = (i) => COLORS[i % COLORS.length], total = slices.reduce((s, x) => s + x.value, 0);
  const W = Math.min(el.clientWidth || 300, 320), H = height, R = Math.min(W, H) / 2 - 6, r = R * 0.62, cx = W / 2, cy = H / 2;
  if (!(total > 0)) { el.innerHTML = '<p class="empty">Nothing to show yet.</p>'; return; }
  let a0 = -Math.PI / 2, out = '';
  const pt = (rad, a) => `${(cx + rad * Math.cos(a)).toFixed(2)} ${(cy + rad * Math.sin(a)).toFixed(2)}`;
  slices.forEach((s, i) => {
    const sweep = Math.min((s.value / total) * Math.PI * 2, Math.PI * 2 - 0.0001), a1 = a0 + sweep, big = sweep > Math.PI ? 1 : 0;
    out += `<path data-i="${i}" d="M${pt(R, a0)} A${R} ${R} 0 ${big} 1 ${pt(R, a1)} L${pt(r, a1)} A${r} ${r} 0 ${big} 0 ${pt(r, a0)} Z" fill="${colorOf(i)}" opacity="${i >= COLORS.length ? 0.65 : 1}" stroke="var(--surface)" stroke-width="2" style="cursor:pointer" tabindex="0" role="button" aria-label="${esc(s.name)} ${Math.round((s.value / total) * 100)}%"/>`;
    a0 = a1;
  });
  el.innerHTML = `<svg width="${W}" height="${H}" style="display:block;margin:0 auto">${out}<text x="${cx}" y="${cy - 2}" text-anchor="middle" style="fill:var(--text);font-size:15px;font-weight:600" id="dcv">${esc(money(total))}</text><text x="${cx}" y="${cy + 16}" text-anchor="middle" id="dcl">${esc(centre)}</text></svg>`;
  $$('path[data-i]', el).forEach((p) => {
    const s = slices[+p.dataset.i];
    p.onclick = () => onSelect && onSelect(s.key);
    p.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect && onSelect(s.key); } };
    p.onmousemove = (e) => showTip(`<b>${esc(s.name)}</b><div class="r"><span>${money(s.value)}</span><span>${Math.round((s.value / total) * 1000) / 10}%</span></div>`, e);
    p.onmouseleave = hideTip;
  });
}

/** Stacked bars. buckets:[{key,total,groups:{g:v}}] groups:[{key,name,color}] */
function stackedBars(el, { buckets, groups, selected, onSelect, labelOf, height = 260 }) {
  const draw = () => {
    const W = el.clientWidth || 700, H = height, L = 52, R = 8, T = 8, B = 26, n = buckets.length;
    const { ticks, min, max } = niceTicks(0, Math.max(1, ...buckets.map((b) => b.total)));
    const slot = (W - L - R) / n, every = Math.ceil(44 / slot), bw = Math.min(64, slot * 0.62), y = (v) => T + (H - T - B) * (1 - (v - min) / (max - min || 1));
    let bars = '';
    buckets.forEach((b, i) => {
      const cx = L + slot * i + slot / 2, x0 = cx - bw / 2, on = !selected || selected === b.key;
      let acc = 0;
      const segs = groups.map((g) => ({ g, v: b.groups[g.key] || 0 })).filter((s) => s.v > 0);
      segs.forEach((s, j) => {
        const y1 = y(acc + s.v), h = y(acc) - y1; acc += s.v;
        bars += `<path d="${roundTop(x0, y1, bw, Math.max(h, 0.5), j === segs.length - 1 ? 4 : 0)}" fill="${s.g.color}" stroke="var(--surface)" stroke-width="2" opacity="${on ? 1 : 0.5}"/>`;
      });
      if (i % every === 0 || selected === b.key) bars += `<text x="${cx}" y="${H - 6}" text-anchor="middle" ${selected === b.key ? 'style="fill:var(--text)"' : ''}>${esc(labelOf(b.key))}</text>`;
      bars += `<rect data-i="${i}" x="${L + slot * i}" y="0" width="${slot}" height="${H - B}" fill="transparent" style="cursor:pointer"/>`;
    });
    el.innerHTML = `<svg width="${W}" height="${H}">${gridY(ticks, y, L, W, R)}${bars}</svg>`;
    $$('rect[data-i]', el).forEach((r) => {
      const b = buckets[+r.dataset.i];
      r.onclick = () => onSelect && onSelect(b.key);
      r.onmousemove = (e) => showTip(`<b>${esc(labelOf(b.key))}</b>` + groups.filter((g) => b.groups[g.key]).map((g) => `<div class="r"><span><span class="sw" style="background:${g.color}"></span>${esc(g.name)}</span><span>${money(b.groups[g.key])}</span></div>`).join('') + `<div class="r" style="border-top:1px solid var(--line);margin-top:4px;padding-top:4px"><span>Total</span><b>${money(b.total)}</b></div>`, e);
      r.onmouseleave = hideTip;
    });
  };
  draw(); onResize(draw);
}

/** Income/expense bars with a net line on the same axis. months:[{month,income,spend,saved}] */
function flowChart(el, { months, height = 250 }) {
  const draw = () => {
    const W = el.clientWidth || 700, H = height, L = 52, R = 8, T = 8, B = 26, n = months.length;
    if (!n) { el.innerHTML = '<p class="empty">No data yet.</p>'; return; }
    const all = months.flatMap((m) => [m.income, m.spend, m.saved]);
    const { ticks, min, max } = niceTicks(Math.min(0, ...all), Math.max(0, ...all));
    const slot = (W - L - R) / n, every = Math.ceil(44 / slot), bw = Math.min(26, slot * 0.3), y = (v) => T + (H - T - B) * (1 - (v - min) / (max - min || 1)), z = y(0);
    let s = gridY(ticks, y, L, W, R), line = '', dots = '';
    months.forEach((m, i) => {
      const cx = L + slot * i + slot / 2, bar = (v, x, c) => { const y1 = y(Math.max(v, 0)), h = Math.abs(y(v) - z); return `<path d="${v >= 0 ? roundTop(x, y1, bw, Math.max(h, 0.5), 4) : `M${x} ${z}h${bw}v${h - 4}q0 4 -4 4h${-bw + 8}q-4 0 -4 -4z`}" fill="${c}"/>`; };
      s += bar(m.income, cx - bw - 1, 'var(--s1)') + bar(m.spend, cx + 1, 'var(--s2)');
      line += `${i ? 'L' : 'M'}${cx.toFixed(1)} ${y(m.saved).toFixed(1)}`;
      dots += `<circle cx="${cx}" cy="${y(m.saved)}" r="3.5" fill="var(--text)" stroke="var(--surface)" stroke-width="2"/>`;
      if (i % every === 0) s += `<text x="${cx}" y="${H - 6}" text-anchor="middle">${esc(keyLabel(m.month))}</text>`;
      s += `<rect data-i="${i}" x="${L + slot * i}" y="0" width="${slot}" height="${H - B}" fill="transparent"/>`;
    });
    el.innerHTML = `<svg width="${W}" height="${H}">${s}<path d="${line}" fill="none" stroke="var(--text)" stroke-width="1.5"/>${dots}</svg>`;
    $$('rect[data-i]', el).forEach((r) => {
      const m = months[+r.dataset.i];
      r.onmousemove = (e) => showTip(`<b>${esc(monthLong(m.month))}</b><div class="r"><span><span class="sw" style="background:var(--s1)"></span>Income</span><span>${money(m.income)}</span></div><div class="r"><span><span class="sw" style="background:var(--s2)"></span>Expenses</span><span>${money(m.spend)}</span></div><div class="r"><span><span class="sw" style="background:var(--text)"></span>Net</span><span>${money(m.saved, BASE, { sign: true })}</span></div>`, e);
      r.onmouseleave = hideTip;
    });
  };
  draw(); onResize(draw);
}

function sparkline(vals, w = 76, h = 22) {
  if (vals.length < 2) return '';
  const lo = Math.min(...vals), hi = Math.max(...vals), y = (v) => 2 + (h - 4) * (1 - (v - lo) / (hi - lo || 1));
  return `<svg width="${w}" height="${h}"><path d="${vals.map((v, i) => `${i ? 'L' : 'M'}${((w * i) / (vals.length - 1)).toFixed(1)} ${y(v).toFixed(1)}`).join('')}" fill="none" stroke="var(--s1)" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}

// ---------- shared UI bits ----------
const seg = (name, opts, val) => `<div class="seg" data-seg="${name}">${opts.map(([v, l]) => `<button data-v="${esc(v)}" class="${String(v) === String(val) ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>`;
function onSeg(root, name, fn) { $$(`[data-seg="${name}"] button`, root).forEach((b) => (b.onclick = () => fn(b.dataset.v))); }
const catOptions = (cats, sel, kind) => cats.filter((c) => !kind || c.kind === kind || c.kind === 'transfer').map((c) => `<option value="${esc(c.account)}" ${c.account === sel ? 'selected' : ''}>${esc(c.label)}</option>`).join('');
const kpi = (l, v, d, d2, dcls = '') => `<div class="card kpi"><div class="l">${l}</div><div class="v">${v}</div>${d ? `<div class="d ${dcls}">${d}</div>` : ''}${d2 ? `<div class="d2">${d2}</div>` : ''}</div>`;
const card = (title, sub, body, actions = '') => `<div class="card"><div class="head"><div><h2>${title}</h2>${sub ? `<div class="sub">${sub}</div>` : ''}</div>${actions}</div>${body}</div>`;
const budgetBar = (b) => (b ? `<div style="display:flex;gap:8px;align-items:center"><div class="track" style="flex:1"><div class="fill ${b.pct > 100 ? 'over' : ''}" style="width:${Math.min(100, b.pct)}%"></div></div><span class="${b.pct > 100 ? 'bad' : 'muted'}" style="font-size:11px;min-width:34px">${b.pct}%</span></div><div class="muted" style="font-size:11px">of ${money(b.amount)}${b.kind === 'year' ? ' / year · YTD' : ''}</div>` : '');
/** "450" or "450/m" → monthly, "3000/y" (also "yearly", "per year") → yearly. */
function parseBudget(v) {
  const m = v.trim().toLowerCase().match(/^([\d.,]+)\s*(?:\/?\s*(y|yr|year|yearly|annual|annually|per year|m|mo|month|monthly|per month))?$/);
  if (!m || Number.isNaN(parseFloat(m[1].replace(',', '.')))) return null;
  return { amount: parseFloat(m[1].replace(',', '.')), period: m[2] && /^(y|annual)/.test(m[2]) || m[2] === 'per year' ? 'year' : 'month' };
}
const delta = (p) => (p == null ? '<span class="muted">—</span>' : `<span class="${p > 0 ? 'bad' : p < 0 ? 'good' : 'muted'}">${pct(p)}</span>`);

// ---------- layout ----------
const ICONS = {
  overview: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  spending: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>', assets: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  liabilities: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>', transactions: '<path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4"/>',
  goals: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>', review: '<path d="M4 6l2 2 3-3M4 14l2 2 3-3M12 7h8M12 15h8"/>', categories: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l1-4.4A8 8 0 1 1 21 12z"/>', rules: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 7v10M6 12h10"/>', banks: '<path d="M3 10l9-6 9 6M5 10v8M10 10v8M14 10v8M19 10v8M3 20h18"/>', connections: '<path d="M9 7V3M15 7V3M7 7h10v5a5 5 0 0 1-10 0zM12 17v4"/>', security: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', backups: '<path d="M21 8v13H3V8M1 3h22v5H1zM10 12h4"/>', import: '<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>', sync: '<path d="M21 12a9 9 0 0 1-15 6.7L3 16M3 12a9 9 0 0 1 15-6.7L21 8M3 21v-5h5M21 3v5h-5"/>',
  updates: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
};
const NAV = [['overview', 'Overview'], ['spending', 'Spending'], ['goals', 'Goals'], ['assets', 'Assets'], ['liabilities', 'Liabilities'], ['transactions', 'Transactions'], ['import', 'Import'], ['review', 'Review']];
const SETTINGS = [['categories', 'Categories'], ['rules', 'Rules'], ['banks', 'Banks'], ['backups', 'Backups'], ['connections', 'Connections'], ['chat', 'Chat with AI'], ['security', 'Security'], ['updates', 'Updates']];
const ico = (k) => `<svg viewBox="0 0 24 24">${ICONS[k]}</svg>`;

function renderSide(route) {
  const item = ([k, l]) => `<a class="nav ${route === k ? 'on' : ''}" href="#/${k}">${ico(k)}${l}${k === 'review' && ST.reviewCount ? `<span class="badge">${ST.reviewCount}</span>` : ''}${k === 'updates' && ST.update?.available ? '<span class="badge">new</span>' : ''}</a>`;
  $('#side').innerHTML = `<div class="brand"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 11l9-8 9 8M5 10v10h14V10"/></svg>Pennystead</div>
    <button class="nav primary" id="syncBtn" ${ST.demo ? 'disabled' : ''}>${ico('sync')}${ST.demo ? 'Demo data' : ST.connected ? 'Sync banks' : 'Connect a bank'}</button>
    ${NAV.map(item).join('')}<div class="grp">Settings</div>${SETTINGS.map(item).join('')}
    <div style="margin-top:auto"></div>${ST.update?.available ? `<a class="nav primary" href="#/updates" style="margin-bottom:6px">${ico('updates')}Update to ${esc(ST.update.latest)}</a>` : ''}<div class="foot"><span class="dot ${ST.connected || ST.demo ? '' : 'off'}"></span>${ST.demo ? 'demo data' : ST.connected ? `${ST.accountCount} account${ST.accountCount === 1 ? '' : 's'} · synced ${esc(ST.lastSync || 'never')}` : 'not connected'}</div>
    ${ST.authRequired ? '<button class="nav" id="logout" style="margin-top:4px">Sign out</button>' : ''}<a class="foot" href="#/backups" style="text-decoration:none;margin-top:0;padding-top:0">${ST.backup?.error ? '<span class="bad">⚠ backup failing</span>' : ST.backup?.enabled ? `<span class="muted">backup ${ST.backup.lastAt ? ago(ST.backup.lastAt) : 'pending'}</span>` : '<span class="muted">backups off</span>'}</a><a class="foot" href="#/updates" style="text-decoration:none;margin-top:0;padding-top:0"><span class="muted">Pennystead ${esc(ST.version || '')}</span></a>`;
  if ($('#logout')) $('#logout').onclick = async () => { await fetch('/api/logout', { method: 'POST' }); location.href = '/login'; };
  $('#syncBtn').onclick = async () => {
    if (!ST.connected) return (location.hash = '#/banks');
    const b = $('#syncBtn'); b.disabled = true; b.lastChild.textContent = 'Syncing…';
    try { const r = await api('/api/sync', 'POST'); toast(`Synced: ${r.reduce((s, x) => s + x.added, 0)} new transactions`); } catch (e) { toast(e.message); }
    go();
  };
}
const setMenu = (open) => { $('#side').classList.toggle('open', open); $('#burger').setAttribute('aria-expanded', String(open)); };
$('#burger').onclick = (e) => { e.stopPropagation(); setMenu(!$('#side').classList.contains('open')); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });
document.addEventListener('click', (e) => { if ($('#side').classList.contains('open') && !e.target.closest('#side')) setMenu(false); });

// ---------- router ----------
const pages = {};
let lastRoute = null, navSeq = 0;
async function loadState() { ST = await api('/api/state'); BASE = ST.base; }
async function go() {
  redraws = []; hideTip();
  const route = (location.hash.replace(/^#\//, '') || 'overview').split('?')[0];
  const page = pages[route] || pages.overview;
  setMenu(false);
  const seq = ++navSeq;
  try { await loadState(); } catch (e) { if (seq === navSeq) $('#page').innerHTML = `<div class="card bad">${esc(e.message)}</div>`; return; }
  if (seq !== navSeq) return; // the user has already moved on to another page
  renderSide(route in pages ? route : 'overview');
  $('#title').textContent = page.title;
  $('#topActions').innerHTML = ST.demo ? '<span class="pill warn">Sample data</span><button class="btn sm" id="clearDemo">Clear sample data</button>' : '';
  if ($('#clearDemo')) $('#clearDemo').onclick = async () => { if (!confirm('Remove the sample data and start with an empty Pennystead?')) return; await api('/api/demo/clear', 'POST'); location.hash = '#/overview'; go(); };
  const from = lastRoute; lastRoute = route;
  // Each navigation renders into its own container: if an older page finishes loading late, it writes into a detached one.
  const host = document.createElement('div');
  $('#page').replaceChildren(host);
  setTimeout(() => { if (!host.childNodes.length) host.innerHTML = '<p class="empty" aria-live="polite">Loading…</p>'; }, 250);
  try { await page.render(host, { from }); } catch (e) { console.error(e); host.innerHTML = `<div class="card bad">${esc(e.message)}</div>`; }
  if (seq === navSeq) currencyNotice(host);
}

/**
 * Currencies, on every page: confirm the main currency when an account uses another one (typically right after the
 * first bank sync), and say plainly when amounts are being counted without an exchange rate.
 */
function currencyNotice(host) {
  const c = ST.currency;
  if (!c || ST.demo) return;
  const other = c.accounts.filter((x) => x !== c.base), unconv = Object.entries(c.unconverted || {});
  let html = '';
  if (!c.confirmed && c.base && c.accounts.length) {
    // The main currency was taken from your own accounts; ask once whether that is right.
    const one = c.accounts.length === 1;
    html = `<div class="banner" id="curAsk"><span><b>Is ${esc(c.base)} right?</b> ${one ? `Pennystead shows your amounts in <b>${esc(c.base)}</b>, the currency your account reports.` : `Your accounts use <b>${c.accounts.map(esc).join(', ')}</b>. Amounts are shown in <b>${esc(c.base)}</b>, the one most of your accounts use; the others are converted with exchange rates.`}</span><span class="row"><button class="btn sm primary" data-keep="1">Yes, use ${esc(c.base)}</button>${other.map((x) => `<button class="btn sm" data-base="${esc(x)}">Show in ${esc(x)}</button>`).join('')}<a class="btn sm" href="#/banks">Another currency…</a></span></div>`;
  } else if (unconv.length) {
    html = `<div class="banner"><span class="warn">${unconv.map(([cur, n]) => `${n} transaction${n === 1 ? '' : 's'} in <b>${esc(cur)}</b>`).join(', ')} ${unconv.length === 1 && unconv[0][1] === 1 ? 'is' : 'are'} counted as ${esc(c.base)} without conversion, because there is no exchange rate. ${ST.canPrices ? 'Update prices to fetch rates,' : 'Add an Alpha Vantage key in Connections and update prices,'} or change the main currency.</span><span class="row">${ST.canPrices ? '<button class="btn sm" id="curPx">Update prices</button>' : '<a class="btn sm" href="#/connections">Connections</a>'}<a class="btn sm" href="#/banks">Main currency</a></span></div>`;
  }
  if (!html) return;
  host.insertAdjacentHTML('afterbegin', html);
  host.querySelectorAll('[data-base]').forEach((b) => (b.onclick = async () => { await run(() => api('/api/settings/base', 'POST', { base: b.dataset.base }), `Showing everything in ${b.dataset.base}`); go(); }));
  host.querySelectorAll('[data-keep]').forEach((b) => (b.onclick = async () => { await run(() => api('/api/settings/base', 'POST', { keep: true }), `Keeping ${c.base}`); go(); }));
  const px = host.querySelector('#curPx'); if (px) px.onclick = async () => { const r = await run(() => api('/api/prices', 'POST')); toast(r.errors?.length ? r.errors[0] : 'Exchange rates updated'); go(); };
}
// Rows that navigate use data-goto (inline event handlers are blocked by the Content-Security-Policy).
document.addEventListener('click', (e) => { const r = e.target.closest('[data-goto]'); if (r) location.hash = r.dataset.goto; });
// Every Copy button, on any page.
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  try { await navigator.clipboard.writeText(b.dataset.copy); toast('Copied'); } catch { toast('Select the text and copy it manually'); }
});
// A double-click on a submit button must not send the form twice (two "Add" clicks would create two assets).
document.addEventListener('submit', (e) => {
  const f = e.target;
  if (f._busy) { e.preventDefault(); e.stopImmediatePropagation(); return; }
  f._busy = true; setTimeout(() => { f._busy = false; }, 1500);
}, true);
// Clickable rows and links without href work from the keyboard too (Enter or Space).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const t = e.target;
  if (t.matches('[data-goto],[data-drill],[data-crumb],[data-budget],[data-setbudget],[data-toggle],a[role=button]')) { e.preventDefault(); t.click(); }
});
// Make those elements focusable whenever a page renders them.
new MutationObserver(() => { for (const n of document.querySelectorAll('[data-goto],[data-drill],[data-crumb],[data-budget],[data-setbudget],[data-toggle],a:not([href])')) if (!n.hasAttribute('tabindex') || n.tabIndex < 0) { n.tabIndex = 0; if (n.tagName === 'A') n.setAttribute('role', 'button'); } }).observe(document.body, { childList: true, subtree: true });
addEventListener('hashchange', go);
// Background bank syncs: when one finishes while a page is open, show the new data without a click (unless you are typing).
setInterval(async () => {
  if (document.hidden || !ST.connected) return;
  try {
    const s = (await api('/api/state')).sync, seen = ST.sync?.at;
    if (s?.at && s.at !== seen && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) { toast('Banks synced'); go(); }
    else if (ST.sync && s) ST.sync = s;
  } catch { /* offline or logged out: the next real action says so */ }
}, 60e3);
