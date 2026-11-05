// Local API server (ADR-001): the real Worker on Node with shim bindings. Vite proxies to it.
import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { createDevRuntime } from './env';
import { loadDevVars } from './vars';
import { seedDemo } from './seed-demo';
import { bridgeRooms } from './ws-bridge';

const ROOT = join(import.meta.dirname, '..');
const PORT = Number(process.env.ZEIKO_API_PORT ?? 8790);

const runtime = await createDevRuntime({
  dataDir: join(ROOT, '.dev'),
  vars: loadDevVars(ROOT),
  queueMode: 'auto',
  rooms: true,
});
await seedDemo(runtime.env);
// Spaces are closed until the owner opens them (ADR-095); in dev they start open, once.
await runtime.env.DB.prepare(
  `INSERT OR IGNORE INTO app_config (key, value_json, updated_by, updated_at)
   VALUES ('spaces_open', 'true', 'dev', 0)`,
).run();

const server = serve({
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
bridgeRooms(server as unknown as Server, runtime.rooms!, (req) => runtime.fetch(req));

console.log(`[zeiko] API dev  → http://localhost:${PORT}  (app: ${runtime.env.APP_ORIGIN})`);
console.log('[zeiko] mailbox  → GET  /__dev/mail   ·   cron → POST /__dev/cron?cron=…');
