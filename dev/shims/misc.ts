// Small binding shims: Rate Limiting, Analytics Engine, Email, Images, Media, Assets.
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

export class ShimRateLimit {
  private windows = new Map<string, { start: number; count: number }>();
  constructor(private cfg: { limit: number; period: number }) {}
  async limit({ key }: { key: string }): Promise<{ success: boolean }> {
    const now = Date.now();
    const w = this.windows.get(key);
    if (!w || now - w.start >= this.cfg.period * 1000) {
      this.windows.set(key, { start: now, count: 1 });
      return { success: true };
    }
    w.count++;
    return { success: w.count <= this.cfg.limit };
  }
  reset(): void {
    this.windows.clear();
  }
}

export class ShimAnalytics {
  readonly points: Array<{ indexes?: string[]; blobs?: unknown[]; doubles?: number[] }> = [];
  writeDataPoint(p: { indexes?: string[]; blobs?: unknown[]; doubles?: number[] }): void {
    this.points.push(p);
  }
}

export class ShimSendEmail {
  readonly sent: unknown[] = [];
  async send(message: unknown): Promise<{ messageId: string }> {
    this.sent.push(message);
    return { messageId: `dev-${this.sent.length}` };
  }
}

/** Images/Media are exercised in Fase 9; until then calls fail loudly in dev. */
export function unsupportedBinding(name: string): unknown {
  return new Proxy(
    {},
    {
      get() {
        return () => {
          throw new Error(`${name} binding is not available in the dev shim yet`);
        };
      },
    },
  );
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

/** Serves the built SPA from dist/web with SPA fallback (Vite serves it during `npm run dev`). */
export class ShimAssets {
  constructor(private dir: string) {}
  async fetch(input: Request | string): Promise<Response> {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    const candidates = [join(this.dir, rel), join(this.dir, 'index.html')];
    for (const file of candidates) {
      try {
        const body = await readFile(file);
        return new Response(body, {
          headers: { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' },
        });
      } catch {
        // try next
      }
    }
    return new Response('SPA belum di-build. Buka http://localhost:5173 (npm run dev).', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
}
