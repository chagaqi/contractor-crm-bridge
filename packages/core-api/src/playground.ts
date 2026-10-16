/**
 * `GET /playground` — FSM Webhook & Job Simulator. Single self-contained HTML page (no CDN),
 * talks to `/api/simulate*`, `/api/deliveries`, `/api/stream` (SSE), `/api/revenue`, `/api/contacts`.
 */
export interface PlaygroundOptions {
  publicUrl: string;
  tokenRequired: boolean;
  token: string | null;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function renderPlayground(opts: PlaygroundOptions): string {
  const config = JSON.stringify({ publicUrl: opts.publicUrl, tokenRequired: opts.tokenRequired }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FSM Sandbox Simulator</title>
<style>${PLAYGROUND_CSS}</style>
</head>
<body>
<header class="top">
  <div>
    <h1>FSM Sandbox Simulator</h1>
    <p class="sub">Fire signed Jobber, Housecall Pro, ServiceTitan, FieldEdge and Buildertrend webhooks through the real pipeline and watch them land in your CRM.</p>
  </div>
  <div id="health" class="pills" aria-live="polite"></div>
</header>
${opts.tokenRequired && !opts.token ? `<div class="banner">This gateway requires an admin token. Open <code>/playground?token=&lt;ADMIN_TOKEN&gt;</code>.</div>` : ''}
<main class="grid">
  <section class="card" aria-labelledby="fire-h">
    <h2 id="fire-h">Fire an event</h2>
    <div class="tabs" role="tablist" id="sources"></div>
    <div class="row">
      <label>Customer<select id="persona"></select></label>
      <label>Amount (USD)<input id="amount" type="number" min="0" step="1" value="650"></label>
    </div>
    <div class="chips" id="chips">
      <button type="button" data-amt="149">$149</button>
      <button type="button" data-amt="650">$650 · high value</button>
      <button type="button" data-amt="4800">$4,800</button>
    </div>
    <div class="jobref">
      <span>Job</span><code id="jobref">—</code>
      <button type="button" id="newjob" class="ghost">New job</button>
    </div>
    <div class="scenarios" id="scenarios"></div>
    <button type="button" id="lifecycle" class="primary wide">Run full lifecycle: Estimate → Dispatch → Complete → Paid</button>
    <div class="secondary" id="secondary"></div>
    <details id="last">
      <summary>Last webhook sent</summary>
      <pre id="lastbody">Nothing sent yet.</pre>
    </details>
    <p class="hint">Webhook URL for live traffic: <code id="hookurl"></code></p>
  </section>

  <section class="card log" aria-labelledby="log-h">
    <div class="loghead">
      <h2 id="log-h">Live delivery log</h2>
      <div class="filters">
        <select id="statusFilter" aria-label="Filter by status">
          <option value="">All statuses</option>
          <option>processed</option><option>partial</option><option>failed</option>
          <option>rejected</option><option>duplicate</option><option>ignored</option>
        </select>
        <span id="stream" class="dot" title="live stream"></span>
      </div>
    </div>
    <div id="stats" class="stats"></div>
    <ol id="deliveries" class="deliveries"></ol>
  </section>

  <section class="card wide-card" aria-labelledby="insights-h">
    <div class="tabs" role="tablist" id="insightTabs">
      <button role="tab" aria-selected="true" data-tab="revenue">Revenue attribution</button>
      <button role="tab" aria-selected="false" data-tab="inbox">CRM payloads</button>
      <button role="tab" aria-selected="false" data-tab="customers">Customers &amp; LTV</button>
      <button role="tab" aria-selected="false" data-tab="review">Review gate</button>
    </div>
    <h2 id="insights-h" class="sr">Insights</h2>
    <div id="tab-revenue" class="tab"></div>
    <div id="tab-inbox" class="tab" hidden></div>
    <div id="tab-customers" class="tab" hidden></div>
    <div id="tab-review" class="tab" hidden>
      <form id="reviewForm" class="form">
        <label><input type="checkbox" name="enabled"> Review requests enabled</label>
        <label>Minimum satisfaction (1–5)<input type="number" name="minSatisfaction" min="0" max="5" step="0.5"></label>
        <label>Cooldown (days)<input type="number" name="cooldownDays" min="0"></label>
        <label>Minimum paid amount (USD)<input type="number" name="minInvoice" min="0"></label>
        <label>Send delay (minutes)<input type="number" name="delayMinutes" min="0"></label>
        <label>High-value "Invoice Paid" threshold (USD)<input type="number" name="highValue" min="0"></label>
        <label><input type="checkbox" name="requireInvoice"> Require a paid invoice</label>
        <button class="primary" type="submit">Save rules</button>
        <span id="reviewSaved" class="muted" aria-live="polite"></span>
      </form>
      <p class="muted">A review request fires only when the job is <b>Completed</b> and every invoice for it is <b>Paid</b>, with no callback / warranty / complaint flags, no disputed or refunded invoices, satisfaction at or above the minimum, a reachable phone or email, and no request inside the cooldown window.</p>
    </div>
    <div class="toolbar"><button type="button" id="reset" class="ghost danger">Reset sandbox data</button></div>
  </section>
</main>
<script>window.__BRIDGE__ = ${config};</script>
<script>${PLAYGROUND_JS}</script>
</body>
</html>`;
}

export const PLAYGROUND_CSS = `
:root{--bg:#f6f7f9;--card:#fff;--ink:#14171c;--muted:#5d6673;--line:#e3e6ea;--accent:#1f6feb;--accent-ink:#fff;--ok:#1a7f37;--warn:#9a6700;--bad:#cf222e;--chip:#eef1f5;--code:#f1f3f6}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0e1116;--card:#161b22;--ink:#e6edf3;--muted:#8d96a0;--line:#2a313a;--accent:#4493f8;--accent-ink:#0e1116;--ok:#3fb950;--warn:#d29922;--bad:#f85149;--chip:#21262d;--code:#1c2128}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.top{display:flex;gap:16px;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;padding:20px 16px 8px;max-width:1280px;margin:0 auto}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:0 0 12px}.sub{margin:0;color:var(--muted);max-width:720px}
.pills{display:flex;flex-wrap:wrap;gap:6px}.pill{padding:3px 9px;border-radius:999px;background:var(--chip);font-size:12px;color:var(--muted)}.pill.on{color:var(--ok)}.pill.on::before{content:"● "}.pill.off::before{content:"○ "}
.banner{max-width:1280px;margin:8px auto;padding:10px 16px;border:1px solid var(--warn);border-radius:8px;color:var(--warn)}
.grid{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,7fr);gap:16px;padding:12px 16px 32px;max-width:1280px;margin:0 auto}
@media (max-width:900px){.grid{grid-template-columns:minmax(0,1fr)}}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;min-width:0}.wide-card{grid-column:1/-1}
.tabs{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:12px}.tabs button{border:1px solid var(--line);background:transparent;color:var(--ink);padding:6px 10px;border-radius:8px;cursor:pointer}
.tabs button[aria-selected=true]{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
.row{display:grid;grid-template-columns:2fr 1fr;gap:8px}label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)}
select,input{font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:7px 8px;min-width:0}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}.chips button{border:0;background:var(--chip);color:var(--ink);border-radius:999px;padding:4px 10px;cursor:pointer;font-size:12px}
.jobref{display:flex;align-items:center;gap:8px;margin:8px 0 12px;font-size:12px;color:var(--muted)}.jobref code{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}code{background:var(--code);padding:1px 5px;border-radius:4px}
pre{background:var(--code);padding:10px;border-radius:8px;overflow:auto;max-height:320px;margin:8px 0 0;white-space:pre-wrap;word-break:break-word}
.scenarios{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-bottom:8px}
.scenarios button,.secondary button{border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:10px;padding:12px 10px;cursor:pointer;text-align:left;font-weight:600}
.scenarios button small,.secondary button small{display:block;font-weight:400;color:var(--muted);font-size:11px;margin-top:2px}
.scenarios button:hover,.secondary button:hover{border-color:var(--accent)}
.secondary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin:8px 0}.secondary button{padding:8px;font-size:12px}
@media (max-width:520px){.secondary{grid-template-columns:minmax(0,1fr)}.row{grid-template-columns:minmax(0,1fr)}}
button.primary{background:var(--accent);color:var(--accent-ink);border:0;border-radius:10px;padding:10px 14px;font-weight:600;cursor:pointer}.wide{width:100%}
button.ghost{background:transparent;border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:5px 10px;cursor:pointer}button.danger{color:var(--bad)}
button:disabled{opacity:.55;cursor:progress}
.hint,.muted{color:var(--muted);font-size:12px}
.loghead{display:flex;justify-content:space-between;align-items:center;gap:8px}.filters{display:flex;gap:8px;align-items:center}
.dot{width:9px;height:9px;border-radius:50%;background:var(--muted);display:inline-block}.dot.live{background:var(--ok)}
.stats{display:flex;flex-wrap:wrap;gap:12px;margin:4px 0 10px;font-size:12px;color:var(--muted)}.stats b{color:var(--ink);font-variant-numeric:tabular-nums}
.deliveries{list-style:none;margin:0;padding:0;max-height:640px;overflow:auto}
.dl{border:1px solid var(--line);border-radius:10px;margin-bottom:8px;overflow:hidden}
.dl>button{all:unset;display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:10px;align-items:center;padding:10px 12px;cursor:pointer;width:100%;box-sizing:border-box}
.dl>button:focus-visible{outline:2px solid var(--accent)}
.badge{font-size:11px;font-weight:700;padding:2px 7px;border-radius:6px;background:var(--chip);text-transform:uppercase;letter-spacing:.02em}
.s-processed{color:var(--ok)}.s-partial,.s-duplicate,.s-ignored{color:var(--warn)}.s-failed,.s-rejected{color:var(--bad)}
.dl .title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dl .meta{font-size:11px;color:var(--muted);text-align:right;white-space:nowrap}
.dl .body{padding:0 12px 12px;border-top:1px solid var(--line)}
.steps{list-style:none;padding:0;margin:10px 0}.steps li{padding:3px 0 3px 18px;position:relative;font-size:12px}.steps li::before{content:"✓";position:absolute;left:0;color:var(--ok)}.steps li.fail::before{content:"✕";color:var(--bad)}
.steps b{font-weight:600}.trig{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}.trig span{font-size:11px;padding:2px 8px;border-radius:999px;background:var(--chip)}.trig span.fired{color:var(--ok)}
table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600}td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.tablewrap{overflow-x:auto}.kpis{display:flex;flex-wrap:wrap;gap:24px;margin-bottom:12px}.kpi .v{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}.kpi .l{font-size:12px;color:var(--muted)}
.form{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;align-items:end;margin-bottom:12px}.form label:has(input[type=checkbox]){flex-direction:row;align-items:center;color:var(--ink)}
.toolbar{display:flex;justify-content:flex-end;margin-top:12px}.sr{position:absolute;left:-9999px}
.empty{color:var(--muted);text-align:center;padding:24px 8px}
`;

export const PLAYGROUND_JS = `
(function(){
  const cfg = window.__BRIDGE__ || {};
  const params = new URLSearchParams(location.search);
  const token = params.get('token');
  const SOURCES = [['jobber','Jobber'],['housecallpro','Housecall Pro'],['servicetitan','ServiceTitan'],['fieldedge','FieldEdge'],['buildertrend','Buildertrend']];
  const PRIMARY = [
    ['estimate_approved','Estimate Approved','CRM: estimate_approved'],
    ['technician_dispatched','Technician Dispatched','CRM: technician_dispatched'],
    ['job_completed','Job Completed','CRM: job_completed + review gate'],
    ['invoice_paid','Invoice Paid','CRM: invoice_paid (+ high value)'],
  ];
  const SECONDARY = [
    ['customer_created','New Customer','dedupe only'],
    ['job_callback','Callback / unhappy','review blocked'],
    ['invoice_disputed','Invoice Disputed','review blocked'],
  ];
  const state = { source: 'jobber', jobRef: null, deliveries: [], open: new Set(), status: '' };
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = (c) => '$' + (Number(c||0)/100).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
  const time = (iso) => iso ? new Date(iso).toLocaleTimeString() : '';

  async function api(path, opts) {
    opts = opts || {};
    const headers = Object.assign({'content-type':'application/json'}, opts.headers || {});
    if (token) headers.authorization = 'Bearer ' + token;
    const res = await fetch(path, Object.assign({}, opts, { headers }));
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { error: text }; }
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  function newJob() {
    state.jobRef = 'pg-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,6);
    $('jobref').textContent = state.jobRef;
  }

  function renderSources() {
    $('sources').innerHTML = SOURCES.map(([id,label]) => '<button role="tab" aria-selected="'+(id===state.source)+'" data-source="'+id+'">'+label+'</button>').join('');
    $('hookurl').textContent = (cfg.publicUrl || location.origin) + '/webhooks/' + state.source;
  }
  $('sources').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-source]'); if (!b) return;
    state.source = b.dataset.source; renderSources(); newJob();
  });

  $('scenarios').innerHTML = PRIMARY.map(([id,label,hint]) => '<button type="button" data-scenario="'+id+'">'+label+'<small>'+hint+'</small></button>').join('');
  $('secondary').innerHTML = SECONDARY.map(([id,label,hint]) => '<button type="button" data-scenario="'+id+'">'+label+'<small>'+hint+'</small></button>').join('');
  $('chips').addEventListener('click', (e) => { const b = e.target.closest('button[data-amt]'); if (b) $('amount').value = b.dataset.amt; });
  $('newjob').addEventListener('click', newJob);

  function simBody(extra) {
    return Object.assign({
      source: state.source,
      jobRef: state.jobRef,
      persona: Number($('persona').value || 0),
      amountCents: Math.round(Number($('amount').value || 0) * 100),
    }, extra || {});
  }

  async function busy(btn, fn) {
    const all = document.querySelectorAll('.scenarios button,.secondary button,#lifecycle');
    all.forEach((b) => b.disabled = true);
    try { await fn(); } catch (err) { alert(err.message); } finally { all.forEach((b) => b.disabled = false); }
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-scenario]'); if (!b) return;
    busy(b, async () => {
      const out = await api('/api/simulate', { method: 'POST', body: JSON.stringify(simBody({ scenario: b.dataset.scenario })) });
      $('lastbody').textContent = JSON.stringify(out.webhook, null, 2);
      upsertDelivery(out.delivery, true);
      refreshInsights();
    });
  });
  $('lifecycle').addEventListener('click', (e) => busy(e.target, async () => {
    const out = await api('/api/simulate/lifecycle', { method: 'POST', body: JSON.stringify(simBody()) });
    out.deliveries.forEach((d) => upsertDelivery(d, false));
    if (out.deliveries.length) state.open.add(out.deliveries[out.deliveries.length-1].id);
    renderDeliveries(); refreshInsights(); newJob();
  }));

  function upsertDelivery(d, open) {
    const i = state.deliveries.findIndex((x) => x.id === d.id);
    if (i >= 0) state.deliveries[i] = d; else state.deliveries.unshift(d);
    if (open) state.open.add(d.id);
    renderDeliveries();
  }

  function renderDeliveries() {
    const list = state.deliveries.filter((d) => !state.status || d.status === state.status);
    if (!list.length) { $('deliveries').innerHTML = '<li class="empty">No deliveries yet. Fire an event on the left.</li>'; return; }
    $('deliveries').innerHTML = list.slice(0, 200).map((d) => {
      const fired = (d.triggers||[]).filter((t) => t.fired).map((t) => t.key);
      const title = (d.events && d.events.length ? d.events.map((e) => e.type).join(', ') : (d.rawEventName || 'unknown event'));
      const open = state.open.has(d.id);
      return '<li class="dl">'
        + '<button type="button" data-toggle="'+d.id+'" aria-expanded="'+open+'">'
        + '<span class="badge s-'+d.status+'">'+esc(d.status)+'</span>'
        + '<span class="title"><b>'+esc(d.source)+'</b> · '+esc(title)+(d.simulated?' <span class="muted">(sandbox)</span>':'')+(fired.length?' → <span class="s-processed">'+esc(fired.join(', '))+'</span>':'')+'</span>'
        + '<span class="meta">'+time(d.receivedAt)+' · '+d.durationMs+'ms</span>'
        + '</button>'
        + (open ? detail(d) : '')
        + '</li>';
    }).join('');
  }

  function detail(d) {
    const steps = (d.steps||[]).map((s) => '<li class="'+(s.ok?'':'fail')+'"><b>'+esc(s.step)+'</b> '+esc(s.detail||'')+'</li>').join('');
    const trig = (d.triggers||[]).map((t) => '<span class="'+(t.fired?'fired':'')+'" title="'+esc(t.reason||'')+'">'+(t.fired?'✓ ':'· ')+esc(t.key)+'</span>').join('');
    const crm = (d.crm||[]).length ? '<div class="tablewrap"><table><thead><tr><th>CRM</th><th>Action</th><th>Result</th><th class="num">Tries</th><th class="num">ms</th></tr></thead><tbody>'
      + d.crm.map((c) => '<tr><td>'+esc(c.target)+'</td><td>'+esc(c.action)+'</td><td class="'+(c.ok?'s-processed':'s-failed')+'">'+(c.ok?'ok':'failed')+(c.status?' · '+c.status:'')+(c.error?' — '+esc(c.error):'')+(c.detail&&c.ok?' — '+esc(c.detail):'')+'</td><td class="num">'+c.attempts+'</td><td class="num">'+c.durationMs+'</td></tr>').join('')
      + '</tbody></table></div>' : '<p class="muted">No CRM calls.</p>';
    return '<div class="body">'
      + (d.error ? '<p class="s-failed">'+esc(d.error)+'</p>' : '')
      + (trig ? '<div class="trig">'+trig+'</div>' : '')
      + '<ol class="steps">'+steps+'</ol>' + crm
      + '<details><summary>Request</summary><pre>'+esc(JSON.stringify(d.request, null, 2))+'</pre></details>'
      + '<p><button type="button" class="ghost" data-replay="'+d.id+'">Replay</button> <span class="muted">'+esc(d.id)+(d.replayOf?' · replay of '+esc(d.replayOf):'')+'</span></p>'
      + '</div>';
  }

  $('deliveries').addEventListener('click', async (e) => {
    const t = e.target.closest('[data-toggle]');
    if (t) { const id = t.dataset.toggle; state.open.has(id) ? state.open.delete(id) : state.open.add(id); renderDeliveries(); return; }
    const r = e.target.closest('[data-replay]');
    if (r) { try { const d = await api('/api/deliveries/'+r.dataset.replay+'/replay', { method: 'POST' }); upsertDelivery(d, true); refreshInsights(); } catch (err) { alert(err.message); } }
  });
  $('statusFilter').addEventListener('change', (e) => { state.status = e.target.value; renderDeliveries(); });

  async function loadDeliveries() {
    const out = await api('/api/deliveries?limit=200');
    state.deliveries = out.deliveries; renderDeliveries(); renderStats(out.stats);
  }
  function renderStats(s) {
    if (!s) return;
    $('stats').innerHTML = '<span>Total <b>'+s.total+'</b></span><span>Processed <b>'+s.byStatus.processed+'</b></span><span>Failed <b>'+(s.byStatus.failed+s.byStatus.partial)+'</b></span><span>Rejected <b>'+s.byStatus.rejected+'</b></span><span>CRM calls <b>'+s.crmCalls+'</b></span><span>CRM failures <b>'+s.crmFailures+'</b></span>';
  }

  function connectStream() {
    if (!window.EventSource) return;
    const es = new EventSource('/api/stream' + (token ? '?token=' + encodeURIComponent(token) : ''));
    es.addEventListener('ready', () => $('stream').classList.add('live'));
    es.addEventListener('delivery', (ev) => { upsertDelivery(JSON.parse(ev.data), false); api('/api/stats').then(renderStats).catch(()=>{}); });
    es.onerror = () => $('stream').classList.remove('live');
  }

  async function refreshInsights() {
    try {
      const [rev, contacts, stats, inbox] = await Promise.all([api('/api/revenue'), api('/api/contacts?limit=100'), api('/api/stats'), api('/api/sandbox/inbox?limit=30')]);
      $('tab-inbox').innerHTML = '<p class="muted">Exactly what CRM workflows receive. The built-in sandbox CRM records simulated events only; connected CRMs (GoHighLevel, HubSpot, Pipedrive, monday.com, Make) receive the same field map.</p>'
        + (inbox.entries.length ? inbox.entries.map((e) => '<details class="dl" style="padding:8px 12px"><summary><span class="badge '+(e.kind==='trigger'?'s-processed':'')+'">'+esc(e.kind)+'</span> <b>'+esc(e.key)+'</b> <span class="muted">'+time(e.at)+' · '+esc(e.fields.contact_name||e.fields.name||'')+'</span></summary><pre>'+esc(JSON.stringify(e.fields, null, 2))+'</pre></details>').join('') : '<p class="empty">No payloads yet.</p>');
      renderStats(stats);
      const rows = (list) => list.length ? list.map((r) => '<tr><td>'+esc(r.key)+'</td><td class="num">'+money(r.revenueCents)+'</td><td class="num">'+r.paidInvoices+'</td><td class="num">'+r.completedJobs+'</td><td class="num">'+r.contacts+'</td><td class="num">'+money(r.averageTicketCents)+'</td></tr>').join('') : '<tr><td colspan="6" class="empty">No revenue yet — fire "Invoice Paid".</td></tr>';
      const head = (k) => '<thead><tr><th>'+k+'</th><th class="num">Revenue</th><th class="num">Paid invoices</th><th class="num">Completed jobs</th><th class="num">Customers</th><th class="num">Avg ticket</th></tr></thead>';
      $('tab-revenue').innerHTML = '<div class="kpis"><div class="kpi"><div class="v">'+money(rev.totalRevenueCents)+'</div><div class="l">Attributed revenue</div></div><div class="kpi"><div class="v">'+contacts.contacts.length+'</div><div class="l">Unified customers</div></div></div>'
        + '<div class="tablewrap"><table>'+head('Lead source')+'<tbody>'+rows(rev.byLeadSource)+'</tbody></table></div><br>'
        + '<div class="tablewrap"><table>'+head('FSM')+'<tbody>'+rows(rev.bySource)+'</tbody></table></div>';
      $('tab-customers').innerHTML = contacts.contacts.length ? '<div class="tablewrap"><table><thead><tr><th>Customer</th><th>Phone (E.164)</th><th>Email</th><th class="num">LTV</th><th class="num">Jobs</th><th>Linked FSM records</th><th>Last review ask</th></tr></thead><tbody>'
        + contacts.contacts.map((c) => '<tr><td>'+esc(c.displayName)+'<br><span class="muted">'+esc(c.leadSource||'')+'</span></td><td><code>'+esc(c.phone||'—')+'</code></td><td>'+esc(c.email||'—')+'</td><td class="num">'+money(c.metrics.lifetimeValueCents)+'</td><td class="num">'+c.metrics.completedJobCount+'</td><td>'+c.externalIds.map((x)=>'<code>'+esc(x.replace(/^ext:/,''))+'</code>').join(' ')+'</td><td>'+esc(c.metrics.lastReviewRequestAt ? new Date(c.metrics.lastReviewRequestAt).toLocaleString() : '—')+'</td></tr>').join('')
        + '</tbody></table></div>' : '<p class="empty">No customers yet.</p>';
    } catch (err) { console.warn(err); }
  }

  $('insightTabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]'); if (!b) return;
    document.querySelectorAll('#insightTabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    ['revenue','inbox','customers','review'].forEach((t) => $('tab-'+t).hidden = t !== b.dataset.tab);
  });

  async function loadReview() {
    const s = await api('/api/settings/review');
    const f = $('reviewForm');
    f.enabled.checked = s.enabled; f.requireInvoice.checked = s.requireInvoice;
    f.minSatisfaction.value = s.minSatisfaction; f.cooldownDays.value = s.cooldownDays; f.delayMinutes.value = s.delayMinutes;
    f.minInvoice.value = s.minInvoiceCents / 100; f.highValue.value = s.highValueThresholdCents / 100;
  }
  $('reviewForm').addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.target;
    try {
      await api('/api/settings/review', { method: 'PUT', body: JSON.stringify({
        enabled: f.enabled.checked, requireInvoice: f.requireInvoice.checked,
        minSatisfaction: Number(f.minSatisfaction.value), cooldownDays: Number(f.cooldownDays.value), delayMinutes: Number(f.delayMinutes.value),
        minInvoiceCents: Math.round(Number(f.minInvoice.value) * 100), highValueThresholdCents: Math.round(Number(f.highValue.value) * 100),
      }) });
      $('reviewSaved').textContent = 'Saved.'; setTimeout(() => $('reviewSaved').textContent = '', 2000);
    } catch (err) { alert(err.message); }
  });

  $('reset').addEventListener('click', async () => {
    if (!confirm('Clear all sandbox contacts, ledgers and delivery logs?')) return;
    await api('/api/sandbox/reset', { method: 'POST' }); state.deliveries = []; renderDeliveries(); refreshInsights();
  });

  async function boot() {
    renderSources(); newJob();
    try {
      const [catalog, health] = await Promise.all([api('/api/simulator/catalog'), api('/health')]);
      $('persona').innerHTML = catalog.personas.map((p) => '<option value="'+p.index+'">'+esc(p.name)+' · '+esc(p.leadSource)+'</option>').join('');
      $('health').innerHTML = health.crms.map((c) => '<span class="pill '+((c.connected||c.id==='sandbox')?'on':'off')+'">'+esc(c.label)+'</span>').join('');
      await Promise.all([loadDeliveries(), refreshInsights(), loadReview()]);
      connectStream();
    } catch (err) { $('deliveries').innerHTML = '<li class="empty">'+esc(err.message)+'</li>'; }
  }
  boot();
})();
`;

export { esc as escapeHtml };
