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

/**
 * FortuneSheet inserts rows with `new Function`, which the app's CSP refuses (no 'unsafe-eval',
 * ADR-051). The rows are JSON, so they are parsed instead. Its toolbar also names two buttons in
 * Chinese and the zoom box in English, words its language table doesn't carry; they are dropped.
 * The build fails when the library's code changes, so an update is looked at here.
 */
function fortuneSheetFixes(): Plugin {
  const parsed = 'arr.map(function (s) { return JSON.parse(s); })';
  const swaps: Record<string, Array<[string, string]>> = {
    '/@fortune-sheet/core/dist/index.esm.js': [
      [
        'new Function("d", "return d.unshift(".concat(arr.join(","), ")"))(d);',
        `d.unshift.apply(d, ${parsed});`,
      ],
      [
        'new Function("d", "return d.splice(".concat(index, ", 0, ").concat(arr.join(","), ")"))(d);',
        `d.splice.apply(d, [index, 0].concat(${parsed}));`,
      ],
      [
        'new Function("d", "return d.splice(".concat(index + 1, ", 0, ").concat(arr.join(","), ")"))(d);',
        `d.splice.apply(d, [index + 1, 0].concat(${parsed}));`,
      ],
    ],
    '/@fortune-sheet/react/dist/index.esm.js': [
      ['text: "\\u5408\\u5E76\\u5355\\u5143\\u683C",', 'text: undefined,'],
      ['text: "\\u8FB9\\u6846\\u8BBE\\u7F6E",', 'text: undefined,'],
      ['title: "Zoom settings",', ''],
    ],
  };
  return {
    name: 'fortune-sheet-fixes',
    transform(code, id) {
      const file = Object.keys(swaps).find((f) => id.replace(/\\/g, '/').includes(f));
      if (!file) return null;
      let out = code;
      for (const [from, to] of swaps[file]!) {
        if (!out.includes(from)) this.error(`FortuneSheet changed: "${from}" is gone (ADR-051)`);
        out = out.split(from).join(to);
      }
      if (out.includes('new Function'))
        this.error('FortuneSheet has another new Function (ADR-051)');
      return { code: out, map: null };
    },
  };
}

export default defineConfig({
  root: 'src/web',
  publicDir: 'public',
  // The app is served at the root of its own address, drive.zeiko.biz.id (ADR-038).
  base: '/',
  plugins: [react(), tailwindcss(), pdfjsAssets(), fortuneSheetFixes()],
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
