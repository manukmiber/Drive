// Business configuration (SPEC §0.2). Read path: isolate memo (30 s) → KV (60 s) → D1 app_config,
// merged over CONFIG_DEFAULTS. Invalid rows are ignored (logged) so a bad admin edit can't break
// the app.
import { eq } from 'drizzle-orm';
import {
  CONFIG_DEFAULTS,
  configSchema,
  type AppConfig,
  type ConfigKey,
} from '../../shared/config-defaults';
import { getDb, schema } from '../db/client';
import type { Env } from '../env';
import { AppError } from '../lib/errors';
import { ulid } from '../lib/ids';

const KV_KEY = 'config:v1';
const KV_TTL_SECONDS = 60;
const MEMO_MS = 30_000;

const memo = new WeakMap<D1Database, { at: number; value: AppConfig }>();

export function mergeConfig(rows: Array<{ key: string; valueJson: string }>): AppConfig {
  const out: Record<string, unknown> = { ...CONFIG_DEFAULTS };
  const shape = configSchema.shape as Record<string, (typeof configSchema.shape)[ConfigKey]>;
  for (const row of rows) {
    const field = shape[row.key];
    if (!field) continue;
    try {
      const parsed = field.safeParse(JSON.parse(row.valueJson));
      if (parsed.success) out[row.key] = parsed.data;
      else console.warn(`[config] invalid value for ${row.key}, using default`);
    } catch {
      console.warn(`[config] unparsable JSON for ${row.key}, using default`);
    }
  }
  return out as AppConfig;
}

export async function getConfig(env: Env, now: number = Date.now()): Promise<AppConfig> {
  const m = memo.get(env.DB);
  if (m && now - m.at < MEMO_MS) return m.value;

  let rows = await env.CONFIG_KV.get<Array<{ key: string; valueJson: string }>>(
    KV_KEY,
    'json',
  ).catch(() => null);
  if (!rows) {
    rows = await getDb(env.DB)
      .select({ key: schema.appConfig.key, valueJson: schema.appConfig.valueJson })
      .from(schema.appConfig);
    await env.CONFIG_KV.put(KV_KEY, JSON.stringify(rows), { expirationTtl: KV_TTL_SECONDS });
  }
  const value = mergeConfig(rows);
  memo.set(env.DB, { at: now, value });
  return value;
}

export async function setConfig<K extends ConfigKey>(
  env: Env,
  key: K,
  value: unknown,
  actorId: string,
  now: number,
): Promise<AppConfig[K]> {
  const field = configSchema.shape[key];
  const parsed = field.safeParse(value);
  if (!parsed.success) {
    throw new AppError('VALIDATION', `invalid value for ${key}`, { issues: parsed.error.issues });
  }
  const db = getDb(env.DB);
  const valueJson = JSON.stringify(parsed.data);
  const prev = await db
    .select({ valueJson: schema.appConfig.valueJson })
    .from(schema.appConfig)
    .where(eq(schema.appConfig.key, key))
    .get();
  await db.batch([
    db
      .insert(schema.appConfig)
      .values({ key, valueJson, updatedBy: actorId, updatedAt: now })
      .onConflictDoUpdate({
        target: schema.appConfig.key,
        set: { valueJson, updatedBy: actorId, updatedAt: now },
      }),
    db.insert(schema.auditLogs).values({
      id: ulid(now),
      actorId,
      action: 'config.update',
      targetType: 'config',
      targetId: key,
      metaJson: JSON.stringify({ from: prev?.valueJson ?? null, to: valueJson }),
      createdAt: now,
    }),
  ]);
  await env.CONFIG_KV.delete(KV_KEY);
  memo.delete(env.DB);
  return parsed.data as AppConfig[K];
}

export function invalidateConfigMemo(env: Env): void {
  memo.delete(env.DB);
}
