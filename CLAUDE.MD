# contractor-crm-bridge

npm-workspaces TypeScript monorepo. Zero runtime dependencies (Node >= 20 built-ins only).

- `npm run typecheck` — strict tsc over every package and test
- `npm test` — Vitest (contract + E2E). E2E tests build `packages/gateway/dist/server.mjs` themselves.
- `npm run build` — bundles the gateway into `packages/gateway/dist/server.mjs` with esbuild

Layout: `packages/core-api` (normalizers, dedupe, review gate, revenue, delivery log, simulator, HTTP router),
`packages/shell-*` (one CRM marketplace surface each), `packages/gateway` (composes everything into one server).
Cross-package imports use `@ccb/<name>`, resolved to `src/index.ts` (no per-package build step).
