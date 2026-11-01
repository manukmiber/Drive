// D8 (ADR-091): what a photo or video says about itself (when it was taken, its size, a video's
// length), read once after the scan clears it and kept only in the index (`md`). Messages come
// through the cleanup queue; a batch's results are written with one index change per index.
import type { IndexMedia } from '../../shared/drive-index';
import type { Ctx } from '../context';
import { log } from '../lib/log';
import { readMediaMeta } from '../lib/media-meta';
import { changeIndex, type IndexOwner } from './drive-index';
import { driveTree } from './drive-read';

/** Gives up on a file whose entry never shows up in its index (an upload that never finished). */
const MAX_TRIES = 5;

export const isMediaType = (mime: string | null | undefined) =>
  Boolean(mime && (mime.startsWith('image/') || mime.startsWith('video/')));

interface Pending {
  owner: IndexOwner;
  /** node id → what was read, and the blob it was read from. */
  items: Map<string, { media: IndexMedia; blobId: string; tries: number }>;
}

const pending = new WeakMap<Ctx, Map<string, Pending>>();

/** Asks for a file's metadata to be read (after its scan cleared it). */
export async function queueMedia(ctx: Ctx, blobId: string, tries = 0, delaySeconds = 0) {
  await ctx.env.CLEANUP_QUEUE.send(
    { type: 'media', blobId, ...(tries ? { tries } : {}) },
    delaySeconds ? { delaySeconds } : undefined,
  );
}

interface NodeRow {
  id: string;
  owner_id: string;
  space: 'personal' | 'family';
  family_id: string | null;
  mime: string | null;
}

/** One message: reads the content's first bytes and holds the result for the batch's write. */
export async function readMediaOf(ctx: Ctx, blobId: string, tries = 0): Promise<void> {
  const DB = ctx.env.DB;
  const blob = await DB.prepare(
    "SELECT r2_key, size, sniffed_mime FROM blobs WHERE id = ?1 AND scan_status IN ('clean', 'skipped')",
  )
    .bind(blobId)
    .first<{ r2_key: string; size: number; sniffed_mime: string | null }>();
  if (!blob) return;
  const { results: nodes } = await DB.prepare(
    `SELECT id, owner_id, space, family_id, mime FROM nodes
     WHERE blob_id = ?1 AND kind = 'file' AND status = 'ready'`,
  )
    .bind(blobId)
    .all<NodeRow>();
  if (!nodes.length || !(isMediaType(blob.sniffed_mime) || nodes.some((n) => isMediaType(n.mime))))
    return;
  let meta: IndexMedia | null = null;
  try {
    meta = await readMediaMeta(ctx.env.BUCKET, blob.r2_key, blob.size);
  } catch (e) {
    log.warn('media_read_failed', { blobId, message: String(e) });
  }
  // Read, even when it says nothing: the column marks it done, so it is not read again.
  const media = meta ?? { takenAt: null, width: 0, height: 0, durationMs: 0 };
  let m = pending.get(ctx);
  if (!m) pending.set(ctx, (m = new Map()));
  for (const n of nodes) {
    const owner: IndexOwner =
      n.space === 'family' && n.family_id ? { family: n.family_id } : { user: n.owner_id };
    const key = JSON.stringify(owner);
    let p = m.get(key);
    if (!p) m.set(key, (p = { owner, items: new Map() }));
    p.items.set(n.id, { media, blobId, tries });
  }
}

/** End of a queue batch: one index change per index for everything read. */
export async function writeMedia(ctx: Ctx): Promise<void> {
  const m = pending.get(ctx);
  if (!m?.size) return;
  pending.delete(ctx);
  for (const p of m.values()) {
    const found = new Set<string>();
    try {
      await changeIndex(ctx.env.BUCKET, p.owner, (doc) => {
        found.clear();
        for (const e of doc.entries()) {
          const got = e.legacy ? p.items.get(e.legacy) : undefined;
          if (!got) continue;
          found.add(e.legacy);
          if (JSON.stringify(e.media ?? null) !== JSON.stringify(got.media))
            doc.set({ ...e, media: got.media });
        }
      });
    } catch (e) {
      log.warn('media_write_failed', { message: String(e) });
      continue;
    }
    // Not in the index yet (its flush has not run): try again in a while, a few times.
    const again = new Set<string>();
    for (const [id, it] of p.items)
      if (!found.has(id) && it.tries + 1 < MAX_TRIES && !again.has(it.blobId)) {
        again.add(it.blobId);
        await queueMedia(ctx, it.blobId, it.tries + 1, 30 * (it.tries + 1));
      }
  }
}

const CURSOR_KEY = 'media_backfill:cursor';
const PER_MESSAGE = 25;

/**
 * Hourly: photos and videos uploaded before D8 get read too, a few people at a time. The cursor (the
 * last person looked at) is one KV write an hour; many files ride in one message (Queues on Workers
 * Free count operations).
 */
export async function backfillMedia(ctx: Ctx): Promise<{ queued: number }> {
  const budget = (await ctx.config()).media_backfill_per_hour;
  if (budget <= 0) return { queued: 0 };
  const after = (await ctx.env.CONFIG_KV.get(CURSOR_KEY)) ?? '';
  const { results } = await ctx.env.DB.prepare(
    `SELECT DISTINCT owner_id FROM nodes WHERE kind = 'file' AND status = 'ready'
       AND (mime LIKE 'image/%' OR mime LIKE 'video/%') AND owner_id > ?1
     ORDER BY owner_id LIMIT 20`,
  )
    .bind(after)
    .all<{ owner_id: string }>();
  const blobs = new Set<string>();
  let last = after;
  for (const { owner_id } of results) {
    for (const space of ['personal', 'family'] as const) {
      const loaded = await driveTree(ctx, owner_id, space);
      if (!loaded) continue;
      for (const { node, blob } of loaded.tree.contents()) {
        if (blobs.size >= budget) break;
        if (node.ownerId !== owner_id || node.width !== undefined || !isMediaType(node.mime))
          continue;
        const key = String(blob);
        blobs.add(key.slice(key.lastIndexOf('/') + 1));
      }
    }
    last = owner_id;
    if (blobs.size >= budget) break;
  }
  const ids = [...blobs];
  for (let i = 0; i < ids.length; i += PER_MESSAGE)
    await ctx.env.CLEANUP_QUEUE.send({ type: 'media', blobIds: ids.slice(i, i + PER_MESSAGE) });
  // Everyone looked at, nothing left this round: start again from the top next hour.
  const next = results.length < 20 && blobs.size < budget ? '' : last;
  if (next !== after) await ctx.env.CONFIG_KV.put(CURSOR_KEY, next);
  return { queued: ids.length };
}
