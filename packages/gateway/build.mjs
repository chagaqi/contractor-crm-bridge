// Bundles the gateway (core-api + all five shells) into one dependency-free ESM file.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [resolve(here, 'src/server.ts')],
  outfile: resolve(here, 'dist/server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: false,
  legalComments: 'none',
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
});
