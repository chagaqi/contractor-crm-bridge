import { escapeHtml } from '@ccb/core-api';

export function renderLanding(opts: { publicUrl: string; sandbox: boolean; version: string; crms: Array<{ id: string; label: string; connected: boolean }> }): string {
  const sources = [
    ['jobber', 'Jobber'],
    ['housecallpro', 'Housecall Pro'],
    ['servicetitan', 'ServiceTitan'],
    ['fieldedge', 'FieldEdge'],
    ['buildertrend', 'Buildertrend'],
  ];
  const surfaces = [
    ['GoHighLevel', '/ghl/custom-page', 'Custom Page · workflow triggers & actions'],
    ['HubSpot', '/hubspot/oauth/install', 'Contacts, deals, workflow actions, CRM card'],
    ['Pipedrive', '/pipedrive/oauth/install', 'Persons, deals, activities, JSON panel'],
    ['monday.com', '/monday/oauth/install', 'Board items, recipe triggers & actions'],
    ['Make', '/make/app-definition', 'Custom app: instant triggers, actions, searches'],
  ];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Contractor CRM Bridge</title>
<style>:root{--bg:#f6f7f9;--card:#fff;--ink:#14171c;--muted:#5d6673;--line:#e3e6ea;--accent:#1f6feb;--ok:#1a7f37}
@media (prefers-color-scheme:dark){:root{--bg:#0e1116;--card:#161b22;--ink:#e6edf3;--muted:#8d96a0;--line:#2a313a;--accent:#4493f8;--ok:#3fb950}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}main{max-width:960px;margin:0 auto;padding:32px 16px}
h1{margin:0 0 4px;font-size:24px}p{color:var(--muted);margin:0 0 20px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}h2{font-size:15px;margin:0 0 8px}a{color:var(--accent)}code{font-size:12px;word-break:break-all}
ul{margin:0;padding-left:18px}li{margin:4px 0}.on{color:var(--ok)}.cta{display:inline-block;margin:0 0 24px;background:var(--accent);color:#fff;padding:10px 16px;border-radius:10px;text-decoration:none;font-weight:600}</style></head>
<body><main><h1>Contractor CRM Bridge</h1><p>Universal FSM → CRM bridge · v${escapeHtml(opts.version)}</p>
${opts.sandbox ? '<a class="cta" href="/playground">Open the FSM Sandbox Simulator →</a>' : ''}
<div class="grid">
<section class="card"><h2>FSM webhook URLs</h2><ul>${sources.map(([id, label]) => `<li>${label}<br><code>${escapeHtml(opts.publicUrl)}/webhooks/${id}</code></li>`).join('')}</ul></section>
<section class="card"><h2>CRM marketplace surfaces</h2><ul>${surfaces.map(([label, path, desc]) => {
    const crm = opts.crms.find((c) => c.label === label);
    return `<li><a href="${path}">${label}</a>${crm?.connected ? ' <span class="on">● connected</span>' : ''}<br><span style="color:var(--muted);font-size:13px">${desc}</span></li>`;
  }).join('')}</ul></section>
<section class="card"><h2>Operations</h2><ul><li><a href="/health">/health</a></li><li><code>GET /api/deliveries</code> — webhook delivery log</li><li><code>POST /api/deliveries/:id/replay</code></li><li><code>GET /api/revenue</code> — attribution</li><li><code>GET /api/manifests</code> — marketplace listings</li></ul></section>
</div></main></body></html>`;
}
