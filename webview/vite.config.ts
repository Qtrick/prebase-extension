import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  root: '.',
  build: {
    outDir: resolve(__dirname, '../extension/media'),
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: resolve(__dirname, 'src/main.tsx'),
      output: {
        entryFileNames: 'webview.js',
        assetFileNames: (asset) =>
          asset.name && asset.name.endsWith('.css') ? 'webview.css' : 'assets/[name][extname]',
      },
    },
  },
  resolve: {
    alias: {
      '@prebase/protocol': resolve(__dirname, '../shared/protocol/src/index.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
  },
});
