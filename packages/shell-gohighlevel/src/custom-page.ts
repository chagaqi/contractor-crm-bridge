/**
 * GHL Custom Page — rendered inside the sub-account sidebar iframe.
 * Auth: GHL SSO (`REQUEST_USER_DATA` postMessage → encrypted payload → POST /ghl/sso → session JWT),
 * or `?token=<ADMIN_TOKEN>` for local development.
 */
export function renderGhlCustomPage(opts: { ssoEnabled: boolean; devToken: string | null }): string {
  const cfg = JSON.stringify({ sso: opts.ssoEnabled }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FSM Bridge</title>
<style>
:root{--bg:#f7f8fa;--card:#fff;--ink:#101828;--muted:#667085;--line:#e4e7ec;--accent:#155eef;--accent-ink:#fff;--ok:#067647;--warn:#b54708;--bad:#d92d20;--chip:#f2f4f7}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0c111d;--card:#161b26;--ink:#f5f5f6;--muted:#94969c;--line:#2a303c;--accent:#528bff;--accent-ink:#0c111d;--ok:#47cd89;--warn:#fdb022;--bad:#f97066;--chip:#1f242f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:1200px;margin:0 auto;padding:16px}h1{font-size:18px;margin:0}h2{font-size:14px;margin:0 0 10px}
.head{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px}.muted{color:var(--muted);font-size:12px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:12px}.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}.kpi .v{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums}.kpi .l{font-size:12px;color:var(--muted)}
.grid{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:12px}@media (max-width:860px){.grid{grid-template-columns:minmax(0,1fr)}}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;min-width:0}
.test{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:6px}select,input{font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:6px 8px}
button{font:inherit;cursor:pointer;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink);padding:6px 10px}button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:600}button:disabled{opacity:.5}
table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;padding:6px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600}.num{text-align:right;font-variant-numeric:tabular-nums}
.tw{overflow-x:auto}.b{font-size:11px;font-weight:700;text-transform:uppercase}.processed{color:var(--ok)}.partial,.duplicate,.ignored{color:var(--warn)}.failed,.rejected{color:var(--bad)}
.err{color:var(--bad);font-size:12px}.steps{margin:4px 0 0;padding-left:16px;color:var(--muted);font-size:11px}
.banner{border:1px solid var(--warn);color:var(--warn);border-radius:8px;padding:10px;margin-bottom:12px}
</style>
</head>
<body>
<div class="wrap">
  <div class="head">
    <div><h1>FSM Bridge</h1><div class="muted" id="who">Connecting…</div></div>
    <div class="muted" id="updated" aria-live="polite"></div>
  </div>
  <div id="banner"></div>
  <div class="kpis" id="kpis"></div>
  <div class="grid">
    <section class="card">
      <h2>Live sync log</h2>
      <div class="tw"><table><thead><tr><th>Time</th><th>FSM</th><th>Event</th><th>Status</th><th>GHL</th><th></th></tr></thead><tbody id="log"><tr><td colspan="6" class="muted">Loading…</td></tr></tbody></table></div>
    </section>
    <div style="display:grid;gap:12px;align-content:start">
      <section class="card">
        <h2>1-click test triggers</h2>
        <div class="test">
          <select id="src" aria-label="FSM"><option value="jobber">Jobber</option><option value="housecallpro">Housecall Pro</option><option value="servicetitan">ServiceTitan</option><option value="fieldedge">FieldEdge</option><option value="buildertrend">Buildertrend</option></select>
          <input id="amt" type="number" min="0" value="650" aria-label="Amount USD" style="width:90px">
        </div>
        <div class="test" id="btns">
          <button data-s="estimate_approved">Estimate Approved</button>
          <button data-s="technician_dispatched">Tech Dispatched</button>
          <button data-s="job_completed">Job Completed</button>
          <button data-s="invoice_paid" class="primary">Invoice Paid</button>
        </div>
        <p class="muted">Fires a signed sandbox webhook through the live pipeline into this sub-account. Fire <b>Job Completed</b> then <b>Invoice Paid</b> on the same job to see <code>review-request-ready</code>.</p>
        <p class="muted">Job: <code id="jobref"></code> <button id="newjob" style="padding:2px 8px">New</button></p>
      </section>
      <section class="card">
        <h2>Revenue attribution</h2>
        <div class="tw"><table><thead><tr><th>Lead source</th><th class="num">Revenue</th><th class="num">Jobs</th><th class="num">Avg</th></tr></thead><tbody id="rev"></tbody></table></div>
      </section>
      <section class="card">
        <h2>Top customers by LTV</h2>
        <div class="tw"><table><thead><tr><th>Customer</th><th class="num">LTV</th><th>FSMs</th></tr></thead><tbody id="top"></tbody></table></div>
      </section>
    </div>
  </div>
</div>
<script>window.__GHL__=${cfg};</script>
<script>
(function(){
  var cfg = window.__GHL__; var qs = new URLSearchParams(location.search);
  var auth = qs.get('token') ? 'Bearer ' + qs.get('token') : null;
  var jobRef = 'ghl-' + Date.now().toString(36);
  function $(id){return document.getElementById(id);}
  function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function money(v){return '$'+Number(v||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});}
  $('jobref').textContent = jobRef;
  $('newjob').onclick = function(){ jobRef = 'ghl-' + Date.now().toString(36); $('jobref').textContent = jobRef; };
  function api(path, opts){
    opts = opts || {}; var h = {'content-type':'application/json'}; if (auth) h.authorization = auth;
    return fetch(path, {method: opts.method||'GET', headers: h, body: opts.body}).then(function(r){return r.json().then(function(j){ if(!r.ok) throw new Error(j.error||('HTTP '+r.status)); return j; });});
  }
  function sso(){
    return new Promise(function(resolve, reject){
      var done = false;
      window.addEventListener('message', function(ev){
        if (!ev.data || ev.data.message !== 'REQUEST_USER_DATA_RESPONSE' || done) return;
        done = true;
        api('/ghl/sso', {method:'POST', body: JSON.stringify({payload: ev.data.payload})}).then(function(r){ auth = 'Bearer ' + r.session; $('who').textContent = (r.user.userName||r.user.email||'GHL user') + ' · location ' + (r.user.locationId||'—'); resolve(); }).catch(reject);
      });
      window.parent.postMessage({message:'REQUEST_USER_DATA'}, '*');
      setTimeout(function(){ if(!done) reject(new Error('No SSO response — open this page from inside GoHighLevel.')); }, 6000);
    });
  }
  function render(o){
    var s = o.stats;
    $('kpis').innerHTML = [
      ['Attributed revenue', money(o.revenue.totalRevenueCents/100)],
      ['Webhooks processed', s.byStatus.processed],
      ['Sync failures', s.byStatus.failed + s.byStatus.partial + s.byStatus.rejected],
      ['Workflow subscriptions', o.subscriptions.length]
    ].map(function(k){return '<div class="kpi"><div class="v">'+esc(k[1])+'</div><div class="l">'+esc(k[0])+'</div></div>';}).join('');
    $('banner').innerHTML = s.lastFailure ? '<div class="banner">Last failure '+esc(new Date(s.lastFailure.at).toLocaleString())+': '+esc(s.lastFailure.error)+'</div>' : '';
    $('log').innerHTML = o.deliveries.length ? o.deliveries.map(function(d){
      var g = d.ghl.map(function(c){return '<div class="'+(c.ok?'processed':'failed')+'">'+esc(c.action)+(c.status?' · '+c.status:'')+(c.error?' — '+esc(c.error):'')+'</div>';}).join('') || '<span class="muted">—</span>';
      return '<tr><td>'+esc(new Date(d.receivedAt).toLocaleTimeString())+'</td><td>'+esc(d.source)+(d.simulated?' <span class="muted">test</span>':'')+'</td><td>'+esc(d.event||'')+(d.triggers.length?'<div class="muted">→ '+esc(d.triggers.join(', '))+'</div>':'')+(d.error?'<div class="err">'+esc(d.error)+'</div>':'')+'</td><td class="b '+esc(d.status)+'">'+esc(d.status)+'</td><td>'+g+'</td><td>'+((d.status==='failed'||d.status==='partial')?'<button data-replay="'+esc(d.id)+'">Retry</button>':'')+'</td></tr>';
    }).join('') : '<tr><td colspan="6" class="muted">No webhooks yet. Use a 1-click test trigger →</td></tr>';
    $('rev').innerHTML = o.revenue.byLeadSource.length ? o.revenue.byLeadSource.map(function(r){return '<tr><td>'+esc(r.key)+'</td><td class="num">'+money(r.revenueCents/100)+'</td><td class="num">'+r.completedJobs+'</td><td class="num">'+money(r.averageTicketCents/100)+'</td></tr>';}).join('') : '<tr><td colspan="4" class="muted">No paid invoices yet.</td></tr>';
    $('top').innerHTML = o.topCustomers.length ? o.topCustomers.map(function(c){return '<tr><td>'+esc(c.name)+'<div class="muted">'+esc(c.phone||'')+'</div></td><td class="num">'+money(c.ltv)+'</td><td>'+esc(c.sources.join(', '))+'</td></tr>';}).join('') : '<tr><td colspan="3" class="muted">—</td></tr>';
    $('updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
  }
  function refresh(){ return api('/ghl/page-api/overview').then(render).catch(function(e){ $('updated').textContent = e.message; }); }
  $('btns').addEventListener('click', function(e){
    var b = e.target.closest('button[data-s]'); if(!b) return;
    var all = document.querySelectorAll('#btns button'); all.forEach(function(x){x.disabled=true;});
    api('/ghl/page-api/test', {method:'POST', body: JSON.stringify({source: $('src').value, scenario: b.dataset.s, amount: $('amt').value, job_ref: jobRef})})
      .then(refresh).catch(function(err){ alert(err.message); }).finally(function(){ all.forEach(function(x){x.disabled=false;}); });
  });
  $('log').addEventListener('click', function(e){
    var b = e.target.closest('button[data-replay]'); if(!b) return; b.disabled = true;
    api('/ghl/page-api/replay/'+b.dataset.replay, {method:'POST'}).then(refresh).catch(function(err){ alert(err.message); });
  });
  var start = (cfg.sso && !auth) ? sso() : Promise.resolve($('who').textContent = auth ? 'Developer token' : 'Local sandbox (no SSO configured)');
  start.then(function(){ refresh(); setInterval(refresh, 4000); }).catch(function(e){ $('who').textContent = e.message; });
})();
</script>
</body>
</html>`;
}
