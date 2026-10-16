# contractor-crm-bridge

One gateway that turns **Jobber, Housecall Pro, ServiceTitan, FieldEdge and Buildertrend** webhooks into a single, unified event model, then syncs contacts, revenue and automation triggers into **GoHighLevel, HubSpot, Pipedrive, monday.com and Make**.

```
 Jobber (GraphQL) ─┐                                                       ┌─ GoHighLevel  (contacts, tags, custom triggers/actions, Custom Page)
 Housecall Pro ────┤   verify HMAC → hydrate → normalize → dedupe (E.164 + │─ HubSpot      (contacts, deals, workflow actions, CRM card, timeline)
 ServiceTitan ─────┼─▶ email + external id) → revenue ledger → triggers +  ├─ Pipedrive    (persons, won deals, activities, notes, JSON panel)
 FieldEdge ────────┤   Smart Review-Gate → fan-out with retries → logs     ├─ monday.com   (board items, recipe triggers & actions)
 Buildertrend ─────┘                                                       └─ Make         (instant triggers, actions, searches)
```

- **Zero runtime dependencies.** The whole gateway bundles into one file, `packages/gateway/dist/server.mjs` (~270 KB), using Node built-ins only.
- **Every webhook is logged.** Each delivery records its step-by-step trail (signature → hydrate → normalize → dedupe → ledger → review-gate), every CRM call it made (HTTP status, attempts, error), and a replay button.
- **FSM Sandbox Simulator** at `GET /playground` fires realistic, *signed* provider payloads through the production pipeline.

## Quick start

```bash
npm install
npm run verify          # typecheck + build + 253 tests
npm start               # node packages/gateway/dist/server.mjs → http://localhost:8787
open http://localhost:8787/playground
```

Configuration is environment-only; see [`.env.example`](.env.example). With no FSM secrets set, the gateway generates ephemeral sandbox secrets so the simulator works straight away. Set `ADMIN_TOKEN` before exposing it.

```bash
docker build -t contractor-crm-bridge . && docker run -p 8787:8787 --env-file .env contractor-crm-bridge
```

## Packages

| Package | What it does |
|---|---|
| `packages/core-api` | Unified types, the 5 FSM normalizers, signature verification, E.164/email normalization, contact dedupe, revenue ledger and attribution, Smart Review-Gate, delivery log, engine, simulator, HTTP router, playground UI |
| `packages/shell-gohighlevel` | GHL v2 OAuth, contact upsert with LTV custom fields, a tag per trigger, Custom Workflow Triggers (subscription hook → `targetUrl`), Custom Workflow Actions, Custom Page with SSO (CryptoJS-compatible AES), app-uninstall webhook (RSA) |
| `packages/shell-hubspot` | OAuth, search → PATCH/POST contacts, `fsm_*` properties for workflow enrollment, won deals with associations, timeline events, signature-v3-verified workflow actions, CRM card |
| `packages/shell-pipedrive` | OAuth (Basic client auth, `api_domain`) or API token, exact-match person search → upsert, won deals, activities, notes, JSON panel |
| `packages/shell-monday` | OAuth, GraphQL board-item upsert, status column and updates, integration-recipe custom trigger subscribe/unsubscribe and actions (HS256 JWT) |
| `packages/shell-makecom` | Generated Make custom-app definition (base, connection, dedicated webhooks, modules) plus the REST endpoints it calls |
| `packages/gateway` | Env config, composes everything onto one router, landing page, esbuild single-file bundle |

## Unified event model

`NormalizedCustomer`, `NormalizedJob`, `NormalizedEstimate` and `NormalizedInvoice` are wrapped in a `NormalizedEvent` (`customer.created`, `job.dispatched`, `job.completed`, `estimate.approved`, `invoice.paid`, `invoice.disputed`, …). Money is integer cents, timestamps are ISO-8601 UTC, phones are E.164 and emails are lower-cased. See `packages/core-api/src/types.ts`.

| FSM | Transport | Signature (default) | Money | Notes |
|---|---|---|---|---|
| Jobber | GraphQL; webhooks are thin (`topic` + `itemId`) | `X-Jobber-Hmac-SHA256`, base64 HMAC of the body | dollars | Hydrated over GraphQL (`JOBBER_ACCESS_TOKEN`); a visit with assigned users counts as dispatched |
| Housecall Pro | REST; webhooks carry the full record | `Api-Signature` = hex HMAC of `timestamp.body`, with a ±5 min window | **cents** | `job.paid` produces an invoice; estimates are approved per option |
| ServiceTitan | REST v2 | `X-ServiceTitan-Signature` (configurable) | dollars (often strings) | Supports both the `eventType` and `__eventInfo` envelopes |
| FieldEdge | partner API (PascalCase) | `X-FieldEdge-Signature` (configurable) | dollars | Parses `/Date(…)/` dates; turns "Last, First" names into first/last |
| Buildertrend | partner API (snake_case) | `X-Buildertrend-Signature: sha256=…` (configurable) | dollars | Maps projects, proposals and owner invoices; a schedule-item assignment counts as dispatched |

## Business rules

**Triggers sent to CRMs:** `estimate_approved`, `technician_dispatched`, `job_completed`, `invoice_paid`, `invoice_paid_high_value` (≥ `HIGH_VALUE_THRESHOLD_CENTS`, default $500), and `review_request_ready`.

**Smart Review-Gate** (`review-gate.ts`): a review request fires only when every check passes:

- the job is Completed and every invoice for it is Paid
- the job has no callback, recall, warranty, complaint or dispute flags
- the customer has no disputed or refunded invoices in any FSM
- satisfaction, when recorded, is at least the minimum
- the customer hasn't opted out and has no exclusion tag
- there is a reachable E.164 phone or email
- no request was sent inside the cooldown, and none has been sent for this job yet

If the gate blocks a request, the reasons are written to the delivery log. A review only counts as sent once a CRM accepts it, so a failed delivery can be replayed.

**Dedupe** (`dedupe.ts`) matches on external id first, then E.164 phone, then email. It never matches on names. If a match would merge two different records from the same FSM whose other identifiers conflict (for example, a household sharing a landline), it creates a separate contact instead.

**Revenue attribution** (`revenue.ts`) tracks per-customer LTV, average ticket and outstanding balance, and rolls revenue up by lead source and by FSM.

## Key HTTP surface

| Route | Purpose |
|---|---|
| `POST /webhooks/{jobber,housecallpro,servicetitan,fieldedge,buildertrend}` | FSM webhook receivers |
| `GET /playground` | FSM Sandbox Simulator UI |
| `POST /api/simulate`, `POST /api/simulate/lifecycle` | Fire signed sandbox events |
| `GET /api/deliveries[/:id]`, `POST /api/deliveries/:id/replay`, `GET /api/stream` (SSE) | Delivery logs |
| `GET /api/contacts[/:id]`, `GET /api/revenue` | Unified customers, LTV, attribution |
| `GET/PUT /api/settings/review` | Review-gate rules |
| `GET /api/manifests` | Machine-readable marketplace listing data for every CRM |
| `/ghl/*`, `/hubspot/*`, `/pipedrive/*`, `/monday/*`, `/make/*` | Marketplace shells (see [SUBMISSION_GUIDE.md](SUBMISSION_GUIDE.md)) |

## Tests

`npm test` runs 253 Vitest tests:

- **Normalizer contract tests**: hand-written, provider-shaped fixtures for all five FSMs
- **Simulator matrix**: 5 FSMs × 7 scenarios through the full pipeline, with signature checks
- **E.164 table**: 38 accepted and rejected inputs
- **Review gate**: every blocking rule
- **Engine**: dedupe, idempotency, retries, partial failure and replay, persistence
- **HTTP API**
- **CRM shells**: each shell runs against a mocked CRM API, asserting the exact outbound requests
- **E2E**: builds `dist/server.mjs`, runs it as a real process against a mock CRM server, and drives it over HTTP
