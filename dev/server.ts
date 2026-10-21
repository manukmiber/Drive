// Local API server (ADR-001): the real Worker on Node with shim bindings. Vite proxies to it.
import { serve } from '@hono/node-server';
import { join } from 'node:path';
import { createDevRuntime } from './env';
import { loadDevVars } from './vars';
import { seedDemo } from './seed-demo';

const ROOT = join(import.meta.dirname, '..');
const PORT = Number(process.env.ZEIKO_API_PORT ?? 8790);

const runtime = await createDevRuntime({
  dataDir: join(ROOT, '.dev'),
  vars: loadDevVars(ROOT),
  queueMode: 'auto',
});
await seedDemo(runtime.env);

serve({
  port: PORT,
  hostname: '0.0.0.0',
  fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname === '/__dev/cron' && req.method === 'POST') {
      const cron = url.searchParams.get('cron') ?? '0 * * * *';
      return Response.json(await runtime.runCron(cron));
    }
    return runtime.fetch(req);
  },
});

console.log(`[zeiko] API dev  → http://localhost:${PORT}  (app: ${runtime.env.APP_ORIGIN})`);
console.log('[zeiko] mailbox  → GET  /__dev/mail   ·   cron → POST /__dev/cron?cron=…');
