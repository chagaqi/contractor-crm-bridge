import { createServer, type Server } from 'node:http';
import {
  BridgeEngine,
  BridgeStore,
  FSM_SOURCES,
  html,
  json,
  registerCoreRoutes,
  requireToken,
  Router,
  toNodeHandler,
  type FsmConnection,
  type FsmSource,
  type MarketplaceShell,
  type ReviewGateSettings,
  type ShellDeps,
} from '@ccb/core-api';
import { createGoHighLevelShell } from '@ccb/shell-gohighlevel';
import { createHubSpotShell } from '@ccb/shell-hubspot';
import { createMakeShell } from '@ccb/shell-makecom';
import { createMondayShell } from '@ccb/shell-monday';
import { createPipedriveShell } from '@ccb/shell-pipedrive';
import type { GatewayConfig } from './config.js';
import { renderLanding } from './landing.js';

export const VERSION = '0.1.0';

export interface Gateway {
  config: GatewayConfig;
  engine: BridgeEngine;
  router: Router;
  shells: MarketplaceShell[];
  listen(port?: number, host?: string): Promise<Server>;
}

export function createGateway(config: GatewayConfig, options: { fetchImpl?: typeof fetch } = {}): Gateway {
  const store = new BridgeStore({ filePath: config.dataFile });
  const connections: Partial<Record<FsmSource, FsmConnection>> = {};
  for (const source of FSM_SOURCES) {
    const c = config.fsm[source];
    connections[source] = {
      source,
      webhookSecret: c.webhookSecret,
      ...(c.accessToken ? { accessToken: c.accessToken } : {}),
      ...(c.graphqlEndpoint ? { graphqlEndpoint: c.graphqlEndpoint } : {}),
    };
  }
  const savedReview = store.kvGet<Partial<ReviewGateSettings> & { highValueThresholdCents?: number }>('settings:review');
  const reviewSettings = Object.fromEntries(Object.entries({ ...config.review, ...(savedReview ?? {}) }).filter(([, v]) => v !== undefined)) as Partial<ReviewGateSettings>;
  delete (reviewSettings as { highValueThresholdCents?: number }).highValueThresholdCents;
  const engine = new BridgeEngine({
    store,
    connections,
    reviewSettings,
    highValueThresholdCents: savedReview?.highValueThresholdCents ?? config.highValueThresholdCents,
    retry: { attempts: config.retryAttempts, baseDelayMs: config.retryBaseDelayMs },
    requireSignatures: config.requireSignatures,
    fetchImpl: options.fetchImpl,
  });

  const deps: ShellDeps = { engine, publicUrl: config.publicUrl, fetchImpl: options.fetchImpl, appSecret: config.appSecret };
  const shells: MarketplaceShell[] = [
    createGoHighLevelShell(deps, { ...config.ghl, adminToken: config.adminToken }),
    createHubSpotShell(deps, { ...config.hubspot, adminToken: config.adminToken }),
    createPipedriveShell(deps, config.pipedrive),
    createMondayShell(deps, config.monday),
    createMakeShell(deps, config.make),
  ];
  for (const shell of shells) engine.addAdapter(shell.adapter);

  const router = new Router();
  router.get('/', () =>
    html(
      renderLanding({
        publicUrl: config.publicUrl,
        sandbox: config.sandbox,
        version: VERSION,
        crms: shells.map((s) => ({ id: s.id, label: s.label, connected: s.adapter.isConnected({ accountId: null, simulated: false, deliveryId: 'landing' }) })),
      }),
    ),
  );
  registerCoreRoutes(router, engine, { adminToken: config.adminToken, sandbox: config.sandbox, publicUrl: config.publicUrl, version: VERSION });
  for (const shell of shells) shell.registerRoutes(router);

  router.get('/api/manifests', (req) => {
    const denied = requireToken(config.adminToken)(req);
    if (denied) return denied;
    return json(200, {
      version: VERSION,
      webhooks: Object.fromEntries(FSM_SOURCES.map((s) => [s, `${config.publicUrl}/webhooks/${s}`])),
      crms: Object.fromEntries(shells.map((s) => [s.id, s.manifest()])),
    });
  });

  return {
    config,
    engine,
    router,
    shells,
    listen(port = config.port, host = config.host) {
      const server = createServer(toNodeHandler(router, { publicUrl: config.publicUrl }));
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server));
      });
    },
  };
}
