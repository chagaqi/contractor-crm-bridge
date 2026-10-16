# Submission Guide

How to deploy the gateway, connect each field-service management system (FSM), and submit each CRM marketplace listing.

> **Before you submit:** the CRM-side endpoints, OAuth flows and payload shapes follow each vendor's public developer docs as of this build. Several items still need checking against live sandboxes before anything is submitted. Each one is marked **⚠ verify** below. They are kept in config, not code, so fixing them shouldn't need a code change.

---

## 0. Why build this

The brief this repo was built against makes two claims from scraped marketplace data. Neither has been independently re-verified here:

- Jobber's GoHighLevel app has about **10,314 installs** and a **3.0★** rating.
- Jobber, Housecall Pro, ServiceTitan, FieldEdge and Buildertrend have **no native connectors** on HubSpot, Pipedrive or monday.com.

The most common complaint about existing sync apps is that **failures happen silently and nothing is logged**. This bridge answers that directly:

- Every webhook gets a delivery record with a step trail, every CRM call it made (HTTP status, attempts, error), and one-click replay.
- The log is visible in the playground, the GHL Custom Page, and through `GET /api/deliveries`.

---

## 1. Deploy

```bash
npm ci && npm run verify            # typecheck + build + 253 tests
node packages/gateway/dist/server.mjs
# or: docker build -t contractor-crm-bridge . && docker run -p 8787:8787 --env-file .env contractor-crm-bridge
```

Production checklist:

- [ ] `PUBLIC_URL`: the HTTPS origin the marketplaces will call. HubSpot signature v3 signs the full URL, so this must match exactly.
- [ ] `ADMIN_TOKEN` and `APP_SECRET`: long random values.
- [ ] `DATA_FILE`: put it on a persistent volume. `BridgeStore` is the persistence seam to swap for Postgres or Redis when you scale past one instance.
- [ ] `SANDBOX=true` is fine in production. Simulated deliveries are marked `simulated`, and the built-in sandbox inbox only receives simulated events.
- [ ] Run `GET /api/manifests` with the admin token. It returns every URL, scope, trigger and action you'll paste into the developer portals below.

---

## 2. Connect the FSMs (inbound webhooks)

Every FSM posts to `https://<PUBLIC_URL>/webhooks/<source>`.

| FSM | Developer program | Subscribe to | Secret env |
|---|---|---|---|
| **Jobber** | Jobber Developer Center → app → Webhooks | `CLIENT_CREATE/UPDATE`, `JOB_CREATE/UPDATE/COMPLETE`, `VISIT_CREATE/UPDATE/COMPLETE`, `QUOTE_CREATE/SENT/APPROVED/UPDATE`, `INVOICE_CREATE/UPDATE`, `PAYMENT_CREATE` | `JOBBER_WEBHOOK_SECRET` = app client secret. Also set `JOBBER_ACCESS_TOKEN`: Jobber webhooks only carry an `itemId`, and the bridge fetches the record over GraphQL. |
| **Housecall Pro** | MAX plan → App Store → API / Webhooks | `customer.*`, `job.*` (incl. `job.on_my_way`, `job.completed`, `job.paid`), `estimate.*`, `invoice.*` | `HCP_WEBHOOK_SECRET` (`Api-Signature` / `Api-Timestamp`) |
| **ServiceTitan** | Developer Portal → app → Integration Environment → Webhooks | Job completed/dispatched, Estimate sold, Invoice paid/updated, Customer created/updated | `SERVICETITAN_WEBHOOK_SECRET` ⚠ verify header name and encoding; override per connection with `SignatureScheme` |
| **FieldEdge** | Partner/API program | `WorkOrder.*`, `Estimate.*`, `Invoice.*`, `Customer.*` | `FIELDEDGE_WEBHOOK_SECRET` ⚠ verify the partner payload envelope and signature |
| **Buildertrend** | Partner/Marketplace integration program | `job.*`, `schedule_item.assigned`, `proposal.*`, `owner_invoice.*`, `owner.*`/`lead.created` | `BUILDERTREND_WEBHOOK_SECRET` ⚠ verify the partner payload envelope and signature |

To verify a connection, fire one real event from the FSM. Then open `/playground` and check that its delivery shows `signature HMAC verified` and a `normalize` step.

---

## 3. GoHighLevel Marketplace

1. Go to **marketplace.gohighlevel.com → My Apps → Create App**.
   - Type: *Public*.
   - Distribution: *Sub-Account*.
2. **Auth**:
   - Redirect URL: `<PUBLIC_URL>/ghl/oauth/callback`
   - Scopes: `contacts.readonly contacts.write locations.readonly locations/customFields.readonly locations/customFields.write locations/tags.write workflows.readonly`
   - Copy the client id and secret into `GHL_CLIENT_ID` and `GHL_CLIENT_SECRET`.
3. **Shared Secret (SSO)**: generate one and set it as `GHL_SSO_SECRET`.
4. **Webhooks**:
   - Default webhook URL: `<PUBLIC_URL>/ghl/webhooks/app`. This receives INSTALL and UNINSTALL.
   - Paste GHL's webhook public key into `GHL_WEBHOOK_PUBLIC_KEY`.
5. **Custom Page**:
   - Name: *FSM Bridge*.
   - URL: `<PUBLIC_URL>/ghl/custom-page`.
   - It shows live sync logs, failure banners with Retry, revenue attribution, top customers by LTV, and 1-click test triggers.
6. **Workflow → Custom Triggers**: create one trigger per key below.
   - Subscription URL: `<PUBLIC_URL>/ghl/triggers/subscribe?key=<GHL_ACTION_SECRET>`.
   - Keys: `estimate_approved`, `technician_dispatched`, `job_completed`, `invoice_paid`, `invoice_paid_high_value`, `review_request_ready`.
   - Sample payload: run `/api/simulate` and copy the `fields` from `/api/sandbox/inbox`.
7. **Workflow → Custom Actions**:
   - `fire_test_event`: execution URL `<PUBLIC_URL>/ghl/actions/fire_test_event?key=…`
   - `lookup_customer_ltv`: execution URL `<PUBLIC_URL>/ghl/actions/lookup_customer_ltv?key=…`
8. **Custom fields**: after the first install, run `POST /ghl/setup/custom-fields` with the admin token. It creates the `fsm_*` contact fields.
9. **Recipes that work with no setup**: every trigger also adds a contact tag (`fsm-job-completed`, `review-request-ready`, …), so standard *Contact Tag Added* workflows work immediately.
10. ⚠ verify the payload shape of the custom-trigger subscription hook (`triggerData` and `extras`) against the current GHL docs before submitting.

## 4. HubSpot App Marketplace

1. In your **developer account**, create a **public app**.
   - Redirect URL: `<PUBLIC_URL>/hubspot/oauth/callback`
   - Scopes: `oauth crm.objects.contacts.read/write crm.objects.deals.read/write crm.schemas.contacts.write timeline automation`
2. After installing in a test portal, run `POST /hubspot/setup/properties`. It creates the *Field Service (FSM Bridge)* property group and all `fsm_*` properties.
3. **Workflow actions**: POST each definition from `GET /api/manifests` → `crms.hubspot.workflowActions` to `/automation/v4/actions/{appId}`. Requests to these actions are verified with `X-HubSpot-Signature-v3`.
4. **CRM card**:
   - Data fetch URL: `<PUBLIC_URL>/hubspot/crm-card`
   - Properties to send: `email`, `phone`, `fsm_bridge_id`
   - ⚠ verify: newer apps use UI-extension app cards. Keep this data-fetch endpoint as the backend either way.
5. **Timeline events** (optional): create one event template per trigger and map the template ids in `HubSpotConfig.timelineTemplates`.
6. **Recipe**: a workflow that enrolls when *FSM Last Trigger* is `review_request_ready` and then sends an SMS or email.
7. Listing: HubSpot requires a minimum number of active installs and a security review. ⚠ verify the current thresholds.

## 5. Pipedrive Marketplace

1. Go to **Developer Hub → Create app**.
   - Callback URL: `<PUBLIC_URL>/pipedrive/oauth/callback`
   - Scopes: `base contacts:full deals:full activities:full`
2. **App extension → JSON panel** on *Person details*:
   - URL: `<PUBLIC_URL>/pipedrive/panel`
   - Basic auth: `PIPEDRIVE_PANEL_USER` / `PIPEDRIVE_PANEL_PASSWORD`
3. **Uninstall callback**: `DELETE <PUBLIC_URL>/pipedrive/oauth/uninstall`, authenticated with Basic client credentials.
4. Optional: map person custom-field hash keys (`fieldKeys.ltv`, …) so LTV shows as a native field.
5. How each trigger lands in Pipedrive:
   - `estimate_approved` → won deal
   - `technician_dispatched` → meeting activity
   - `review_request_ready` → "Send Google review request" task
   - all other triggers → notes

## 6. monday.com Marketplace

1. Go to **Developer Center → Create app**. Copy the client id, client secret and signing secret into the `MONDAY_*` env vars.
   - OAuth redirect: `<PUBLIC_URL>/monday/oauth/callback`
   - Scopes: `boards:read boards:write updates:write me:read`
2. **Integration feature**:
   - Custom trigger blocks: one per trigger key.
     - Subscribe URL: `<PUBLIC_URL>/monday/triggers/<key>/subscribe`
     - Unsubscribe URL: `<PUBLIC_URL>/monday/triggers/unsubscribe`
   - Custom action blocks:
     - `<PUBLIC_URL>/monday/actions/fire_test_event`
     - `<PUBLIC_URL>/monday/actions/sync_ltv_to_item`
   - Remote options for the FSM field: `<PUBLIC_URL>/monday/fields/sources`
3. Recipes: *When FSM Job Completed, create an item*, *When FSM Review Request Ready, notify someone*, *When FSM Invoice Paid ($500+), move item to group*.
4. Board sync (optional): set `MONDAY_BOARD_ID` and create the matching columns. The default column ids are in `DEFAULT_MONDAY_COLUMNS`; override them with `MondayConfig.columns`.
5. ⚠ verify how the trigger `webhookUrl` callback is authorized (signing secret versus JWT) against current monday docs.

## 7. Make (custom app)

1. In **Make → Custom apps → Create app**, paste the sections from `GET /make/app-definition` (Base, Connection, Webhooks, Modules). It includes:
   - instant triggers per FSM trigger, as dedicated webhooks with attach and detach
   - the action modules *Fire FSM Sandbox Event* and *Get a Customer*
   - the searches *Search Customers (LTV)* and *List Failed Webhook Deliveries*
2. Give each customer an API key through `MAKE_API_KEYS`.
3. To publish, submit for Make's review. ⚠ verify the current IML schema field names in Make's app editor.

---

## 8. Demo script for reviewers

1. Open `/playground` and choose **Housecall Pro**.
2. Click **Run full lifecycle**. You'll see four signed deliveries, all `processed`.
3. Expand the *Invoice Paid* delivery. The trail reads `signature ✓ → normalize invoice.paid → dedupe matched by external_id → ledger LTV $650 → review-gate ELIGIBLE`.
4. Check the triggers it fired: `invoice_paid`, `invoice_paid_high_value`, `review_request_ready`.
5. Open **CRM payloads**: this is the exact field map every CRM workflow receives.
6. Fire **Callback / unhappy** on ServiceTitan. The review gate blocks it with `job flagged: recall, callback, complaint; satisfaction score 2 below 4`.
7. Switch the FSM to **Jobber** with the same customer and run the lifecycle again. **Customers & LTV** now shows one unified customer linked to both FSMs, with summed LTV.
8. In GoHighLevel, open the **FSM Bridge** custom page. It shows the same deliveries, its own GHL call results, and the 1-click test triggers.

## 9. Verification status

| Area | Coverage |
|---|---|
| FSM normalizers (5) | 47 hand-written fixture contract tests, plus a 35-case simulator matrix through the full pipeline |
| E.164 / email | 38 table cases for phone, plus email normalization tests |
| Review gate | 23 tests, one per blocking rule plus thresholds and configuration |
| Engine and API | Idempotency, retries, partial failure and replay, persistence, SSE, auth |
| CRM shells (5) | 39 tests against mocked CRM APIs, asserting exact outbound requests (OAuth, signatures, JWT, SSO) |
| Gateway | Real `dist/server.mjs` process against a mock CRM server over HTTP |

To re-check everything: `npm run verify`. That runs a strict TypeScript check, builds the bundle, and runs all 253 tests.
