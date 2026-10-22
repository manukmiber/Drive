// Public catalog: plans, add-ons, compress packs and client-safe config (SPEC §12.1).
import { asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { PUBLIC_CONFIG_KEYS } from '../../shared/config-defaults';
import { schema } from '../db/client';
import type { AppBindings } from '../types';

export const catalog = new Hono<AppBindings>().get('/catalog', async (c) => {
  const { db, config } = c.get('ctx');
  const [plans, addons, packs, cfg] = await Promise.all([
    db
      .select()
      .from(schema.plans)
      .where(eq(schema.plans.active, true))
      .orderBy(asc(schema.plans.sort)),
    db
      .select()
      .from(schema.addons)
      .where(eq(schema.addons.active, true))
      .orderBy(asc(schema.addons.sort)),
    db
      .select()
      .from(schema.compressPacks)
      .where(eq(schema.compressPacks.active, true))
      .orderBy(asc(schema.compressPacks.sort)),
    config(),
  ]);
  const publicConfig = Object.fromEntries(PUBLIC_CONFIG_KEYS.map((k) => [k, cfg[k]]));
  c.header('Cache-Control', 'public, max-age=60');
  const capabilities = {
    // TAR.ZST and big deflate ZIPs need Container `archiver` (ADR-033).
    asyncArchives: c.get('ctx').adapters.archiver.name !== 'none',
  };
  return c.json({ plans, addons, compressPacks: packs, config: publicConfig, capabilities });
});
