import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Local API (dev/server.ts). Port 8787 is taken on the dev machine, see CLAUDE.md.
const API = `http://127.0.0.1:${process.env.ZEIKO_API_PORT ?? '8790'}`;

/**
 * pdf.js loads character maps, standard fonts, colour profiles and image decoders while it shows a
 * PDF (ADR-050). They are served as they are under /pdfjs-<version>/: copied into the build, and
 * straight from node_modules by the dev server.
 */
function pdfjsAssets(): Plugin {
  const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    version: string;
  };
  const prefix = `pdfjs-${version}`;
  const dirs = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];
  const types: Record<string, string> = { wasm: 'application/wasm', js: 'text/javascript' };
  return {
    name: 'pdfjs-assets',
    configureServer(server) {
      const route = new RegExp(`^/${prefix}/(${dirs.join('|')})/([\\w.-]+)$`);
      server.middlewares.use((req, res, next) => {
        const m = route.exec(req.url?.split('?')[0] ?? '');
        const file = m ? join(root, m[1]!, m[2]!) : '';
        if (!m || !existsSync(file)) return next();
        res.setHeader('Content-Type', types[file.split('.').pop()!] ?? 'application/octet-stream');
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      for (const d of dirs)
        for (const f of readdirSync(join(root, d))) {
          const file = join(root, d, f);
          if (statSync(file).isFile())
            this.emitFile({
              type: 'asset',
              fileName: `${prefix}/${d}/${f}`,
              source: readFileSync(file),
            });
        }
    },
  };
}

export default defineConfig({
  root: 'src/web',
  publicDir: 'public',
  // The app is served at the root of its own address, drive.zeiko.biz.id (ADR-038).
  base: '/',
  plugins: [react(), tailwindcss(), pdfjsAssets()],
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
      // The old address of the app, still the website's way back here: the Worker forwards it.
      '^/dashboard(/|$)': API,
      // Share links: first path segment is exactly 64 base62 chars (SPEC §6.1).
      '^/[0-9A-Za-z]{64}/': API,
    },
  },
});
