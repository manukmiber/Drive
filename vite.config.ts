import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Local API (dev/server.ts). Port 8787 is taken on the dev machine, see CLAUDE.md.
const API = `http://127.0.0.1:${process.env.ZEIKO_API_PORT ?? '8790'}`;

export default defineConfig({
  root: 'src/web',
  publicDir: 'public',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    host: true,
    proxy: {
      '/api': API,
      '/d/': API,
      '/z/': API,
      '/dev/pay/': API,
      '/berhenti/': API,
      '/share-target': API,
      '/ad/': API,
      '/__dev': API,
      // Share links: first path segment is exactly 64 base62 chars (SPEC §6.1).
      '^/[0-9A-Za-z]{64}/': API,
    },
  },
});
