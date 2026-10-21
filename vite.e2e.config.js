import { resolve } from 'node:path';

import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist-e2e',
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        rendererHarness: resolve(import.meta.dirname, 'tests/fixtures/renderer-harness.html'),
      },
    },
  },
});
