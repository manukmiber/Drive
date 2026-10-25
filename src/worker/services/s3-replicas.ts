// Zeiko S3's 3-copy plans (ADR-047): every object of a 3x account is also kept in two more R2
// buckets placed in other regions (S3_REPLICA_A/B). A copy is made once the scan has passed, plans
// that move to 3x copy what is already there, plans that move back to 1x drop the extra copies, and
// a read whose first copy is missing is served from another. Deletes always go to every bucket.
import { GIB, MIB } from '../../shared/constants';
import type { Ctx } from '../context';
import type { Env } from '../env';
import { errorMessage, log } from '../lib/log';
import { withKnownLength } from '../lib/zip';
import { s3BlobKey } from './s3';
import { indexDb } from './s3-index';

/** The replica buckets, or none: 3x is offered only when both exist. */
export function replicaBuckets(env: Env): R2Bucket[] {
  return env.S3_REPLICA_A && env.S3_REPLICA_B ? [env.S3_REPLICA_A, env.S3_REPLICA_B] : [];
}

export function replicasAvailable(env: Env): boolean {
  return replicaBuckets(env).length === 2;
}

/** One put up to this size; bigger objects go across in parts (R2's single upload stops at 5 GiB). */
const SINGLE_PUT_MAX = 4 * GIB;

async function copyOne(src: R2Bucket, dst: R2Bucket, key: string, size: number): Promise<boolean> {
  if (await dst.head(key)) return true;
  if (size <= SINGLE_PUT_MAX) {
    const obj = await src.get(key);
    if (!obj) return false;
    await dst.put(key, withKnownLength(obj.body, size));
    return true;
  }
  // Uniform parts, at most 10,000 of them.
  const partSize = Math.max(64 * MIB, Math.ceil(size / 9_000 / MIB) * MIB);
  const up = await dst.createMultipartUpload(key);
  try {
    const parts: R2UploadedPart[] = [];
    for (let offset = 0, n = 1; offset < size; offset += partSize, n++) {
      const length = Math.min(partSize, size - offset);
      const obj = await src.get(key, { range: { offset, length } });
      if (!obj) throw new Error('source object gone');
      parts.push(await up.uploadPart(n, withKnownLength(obj.body, length)));
    }
    await up.complete(parts);
    return true;
  } catch (e) {
    await up.abort().catch(() => undefined);
    throw e;
  }
}

/** Puts one object's bytes into both replica buckets. False: the object is gone. */
export async function replicateBlob(
  env: Env,
  userId: string,
  blobId: string,
  size: number,
): Promise<boolean> {
  const key = s3BlobKey(userId, blobId);
  for (const dst of replicaBuckets(env)) {
    if (!(await copyOne(env.BUCKET, dst, key, size))) return false;
  }
  return true;
}

/** Marks an object copied, unless it was replaced or deleted meanwhile. */
async function markReplicated(
  db: D1Database,
  row: { user_id: string; bucket: string; key: string; blob_id: string },
  value: 0 | 1,
): Promise<void> {
  await db
    .prepare(
      `UPDATE s3_objects SET replicated = ?5 WHERE bucket = ?1 AND key = ?2 AND user_id = ?3 AND blob_id = ?4`,
    )
    .bind(row.bucket, row.key, row.user_id, row.blob_id, value)
    .run();
}

/** After a passed scan: the object's two extra copies, for an account on 3 copies. */
export async function replicateObject(
  ctx: Ctx,
  account: { userId: string; indexBinding: string | null; replicas: number },
  row: { user_id: string; bucket: string; key: string; blob_id: string; size: number },
): Promise<void> {
  if (account.replicas !== 3 || !replicasAvailable(ctx.env)) return;
  try {
    if (await replicateBlob(ctx.env, row.user_id, row.blob_id, row.size))
      await markReplicated(await indexDb(ctx.env, account.indexBinding), row, 1);
  } catch (e) {
    // The nightly sweep (or the next backfill) copies it later.
    log.warn('s3_replicate_failed', { userId: row.user_id, message: errorMessage(e) });
  }
}

async function replicasOf(ctx: Ctx, userId: string) {
  return ctx.env.DB.prepare(
    `SELECT a.index_binding, COALESCE(s.replicas, 1) AS replicas FROM s3_accounts a
     LEFT JOIN s3_subscriptions s ON s.user_id = a.user_id WHERE a.user_id = ?1 AND a.status != 'deleting'`,
  )
    .bind(userId)
    .first<{ index_binding: string | null; replicas: number }>();
}

/**
 * Copies a batch of an account's not-yet-copied objects (a plan moved to 3x, or the nightly sweep).
 * True: nothing is left to copy.
 */
export async function replicateAccount(
  ctx: Ctx,
  userId: string,
  budgetBytes = 2 * GIB,
): Promise<boolean> {
  const acc = await replicasOf(ctx, userId);
  if (!acc || acc.replicas !== 3 || !replicasAvailable(ctx.env)) return true;
  const db = await indexDb(ctx.env, acc.index_binding);
  const { results } = await db
    .prepare(
      `SELECT user_id, bucket, key, blob_id, size FROM s3_objects
       WHERE user_id = ?1 AND replicated = 0 AND scan_status IN ('clean', 'skipped') LIMIT 50`,
    )
    .bind(userId)
    .all<{ user_id: string; bucket: string; key: string; blob_id: string; size: number }>();
  let copied = 0;
  for (const row of results) {
    if (await replicateBlob(ctx.env, userId, row.blob_id, row.size))
      await markReplicated(db, row, 1);
    copied += row.size;
    if (copied >= budgetBytes) return false;
  }
  return results.length < 50;
}

/** Drops a batch of extra copies of an account back on 1 copy. True: none are left. */
export async function unreplicateAccount(ctx: Ctx, userId: string): Promise<boolean> {
  const acc = await replicasOf(ctx, userId);
  if (!acc || acc.replicas === 3) return true;
  const db = await indexDb(ctx.env, acc.index_binding);
  const { results } = await db
    .prepare(
      `SELECT user_id, bucket, key, blob_id FROM s3_objects WHERE user_id = ?1 AND replicated = 1 LIMIT 500`,
    )
    .bind(userId)
    .all<{ user_id: string; bucket: string; key: string; blob_id: string }>();
  if (!results.length) return true;
  const keys = results.map((r) => s3BlobKey(userId, r.blob_id));
  for (const b of replicaBuckets(ctx.env)) await b.delete(keys);
  await db.batch(
    results.map((r) =>
      db
        .prepare(
          `UPDATE s3_objects SET replicated = 0 WHERE bucket = ?1 AND key = ?2 AND user_id = ?3 AND blob_id = ?4`,
        )
        .bind(r.bucket, r.key, r.user_id, r.blob_id),
    ),
  );
  return results.length < 500;
}

/** Deletes keys from the replica buckets too (deletes are free, so always). */
export async function deleteReplicas(env: Env, keys: string[]): Promise<void> {
  if (!keys.length) return;
  for (const b of replicaBuckets(env)) await b.delete(keys);
}

/** Reads from the first copy, then from the others when it is missing. */
export async function getFromAnyCopy(
  env: Env,
  key: string,
  options?: R2GetOptions,
): Promise<R2ObjectBody | null> {
  for (const b of [env.BUCKET, ...replicaBuckets(env)]) {
    const obj = await b.get(key, options).catch((e: unknown) => {
      log.warn('s3_copy_read_failed', { message: errorMessage(e) });
      return null;
    });
    if (obj && 'body' in obj) {
      if (b !== env.BUCKET) log.warn('s3_served_from_replica', { key });
      return obj;
    }
  }
  return null;
}

/** Nightly: accounts on 3 copies with objects not copied yet (a failed copy) get a backfill. */
export async function sweepReplication(ctx: Ctx): Promise<number> {
  if (!replicasAvailable(ctx.env)) return 0;
  const { results } = await ctx.env.DB.prepare(
    `SELECT s.user_id, a.index_binding FROM s3_subscriptions s JOIN s3_accounts a ON a.user_id = s.user_id
     WHERE s.replicas = 3 AND a.status != 'deleting' LIMIT 1000`,
  ).all<{ user_id: string; index_binding: string | null }>();
  let queued = 0;
  for (const a of results) {
    const db = await indexDb(ctx.env, a.index_binding);
    const behind = await db
      .prepare(
        `SELECT 1 AS x FROM s3_objects WHERE user_id = ?1 AND replicated = 0
           AND scan_status IN ('clean', 'skipped') AND modified_at < ?2 LIMIT 1`,
      )
      .bind(a.user_id, ctx.now() - 60 * 60_000)
      .first();
    if (!behind) continue;
    await ctx.env.CLEANUP_QUEUE.send({ type: 's3_replicate', userId: a.user_id });
    queued++;
  }
  return queued;
}
