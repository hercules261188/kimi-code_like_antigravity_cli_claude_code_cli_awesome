import { fileURLToPath } from 'node:url';

import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['./src/index.ts'],
  format: ['esm'],
  dts: false,
  outDir: 'dist',
  clean: true,
  alias: {
    '@moonshot-ai/kimi-code-sdk': fileURLToPath(
      new URL('../node-sdk/src/index.ts', import.meta.url),
    ),
  },
  deps: {
    alwaysBundle: [/^@moonshot-ai\//],
    neverBundle: [],
  },
});
