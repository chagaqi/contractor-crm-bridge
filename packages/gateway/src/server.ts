/**
 * Single-file gateway entry point. Bundled to dist/server.mjs by build.mjs.
 *   node packages/gateway/dist/server.mjs
 */
import { FSM_SOURCES } from '@ccb/core-api';
import { loadConfig } from './config.js';
import { createGateway, VERSION } from './gateway.js';

async function main() {
  const config = loadConfig();
  const gateway = createGateway(config);
  const server = await gateway.listen();
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const log = (msg: string) => process.stdout.write(`${msg}\n`);
  log(`contractor-crm-bridge v${VERSION} listening on http://${config.host}:${port} (public ${config.publicUrl})`);
  if (config.sandbox) log(`  sandbox simulator: ${config.publicUrl}/playground${config.adminToken ? '?token=<ADMIN_TOKEN>' : ''}`);
  for (const source of FSM_SOURCES) {
    if (config.fsm[source].generated) log(`  ${source}: no webhook secret configured — generated an ephemeral sandbox secret`);
  }
  if (!config.adminToken) log('  WARNING: ADMIN_TOKEN is not set; /api/* is unauthenticated. Set it before exposing this server.');

  const shutdown = (signal: string) => {
    log(`received ${signal}, shutting down`);
    gateway.engine.store.flush();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
