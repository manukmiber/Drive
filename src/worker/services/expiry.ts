// D12 (ADR-082): a file or folder can be given a day on which it goes to the Trash by itself, with a
// reminder the day before. The day is kept only in the index (column `ex`, no D1 column, ADR-064);
// projections of D1 carry it over, so a rename or a move keeps it.
//
// The nightly cron can't read every index, so setting a day also leaves an empty marker object
// `sys/expiry/{YYYY-MM-DD}/{u|f}/{id}`: R2 lists keys in order, so the cron reads the markers up to
// tomorrow and opens only the indexes they name. A marker whose day was changed or cleared is
// harmless: that index then has nothing due and the marker goes.
import { DAY_MS } from '../../shared/constants';
import type { DriveNode } from '../../shared/drive-tree';
import { addDaysWib, wibDate, wibDateToMs } from '../../shared/time';
import type { Ctx } from '../context';
import { AppError } from '../lib/errors';
import { log } from '../lib/log';
import { requireNode } from './access';
import { changeIndex, readIndex, type IndexDoc, type IndexOwner } from './drive-index';
import { catchUp, treeNode } from './drive-read';
import { trashNodes } from './nodes';
import { notify } from './notify';

const PREFIX = 'sys/expiry/';
/** How far ahead a day may be set. */
const MAX_DAYS = 3650;

function markerKey(day: string, owner: IndexOwner): string {
  return `${PREFIX}${day}/${'user' in owner ? `u/${owner.user}` : `f/${owner.family}`}`;
}

function parseMarker(key: string): { day: string; owner: IndexOwner } | null {
  const m = /^sys\/expiry\/(\d{4}-\d{2}-\d{2})\/(u|f)\/([^/]+)$/.exec(key);
  if (!m) return null;
  return { day: m[1]!, owner: m[2] === 'u' ? { user: m[3]! } : { family: m[3]! } };
}

const entryOf = (doc: IndexDoc, nodeId: string) => doc.entries().find((e) => e.legacy === nodeId);

/**
 * Sets (a WIB date, YYYY-MM-DD) or clears (null) the day a node goes to the Trash. Needs the right
 * to remove it (SPEC §9.2); the day is from tomorrow on.
 */
export async function setExpiry(
  ctx: Ctx,
  userId: string,
  nodeId: string,
  date: string | null,
): Promise<DriveNode> {
  const found = await treeNode(ctx, userId, nodeId);
  if (!found) {
    // Answers 404/403 as everywhere else; a node D1 has but no index does is still uploading.
    await requireNode(ctx, userId, nodeId, 'remove');
    throw new AppError('BAD_REQUEST', 'not ready yet');
  }
  const { node, access, index } = found;
  if (!access.remove) throw new AppError('FORBIDDEN', 'not allowed');
  if (node.parentId === null) throw new AppError('FORBIDDEN', 'cannot expire a root folder');
  if (node.trashedAt !== null) throw new AppError('BAD_REQUEST', 'in the Trash');

  let at: number | null = null;
  if (date !== null) {
    at = wibDateToMs(date);
    const today = wibDate(ctx.now());
    if (!Number.isFinite(at) || wibDate(at) !== date)
      throw new AppError('BAD_REQUEST', 'invalid date');
    if (date <= today || date > addDaysWib(today, MAX_DAYS))
      throw new AppError('BAD_REQUEST', 'date out of range');
    const key = markerKey(date, index);
    // R2 takes one write a second per key: several items on one day share a marker.
    if (!(await ctx.env.BUCKET.head(key))) await ctx.env.BUCKET.put(key, '');
  }
  await changeIndex(ctx.env.BUCKET, index, async (doc) => {
    // The index may not have caught up with D1 yet (a folder made a moment ago).
    let e = entryOf(doc, nodeId);
    if (!e && (await catchUp(ctx, doc, index))) e = entryOf(doc, nodeId);
    if (!e) throw new AppError('NOT_FOUND', 'not found');
    if (e.expiresAt !== at) doc.set({ ...e, expiresAt: at });
  });
  return { ...node, expiresAt: at };
}

/** Who acts for an entry: the person, or in a family the member who made it (else the owner). */
function actorOf(doc: IndexDoc, owner: IndexOwner, position: number): string | null {
  if ('user' in owner) return owner.user;
  const members = (doc.head.members ?? []) as Array<string | null>;
  return members[position - 1] ?? members[0] ?? null;
}

/**
 * Puts what is due in an index into the Trash, as the person who may remove it, then forgets the
 * day. False when something could not go yet (its marker stays, for tomorrow's run).
 */
async function expireIndex(ctx: Ctx, owner: IndexOwner, now: number): Promise<boolean> {
  const { doc } = await readIndex(ctx.env.BUCKET, owner);
  const due = doc.entries().filter((e) => e.expiresAt !== null && e.expiresAt <= now);
  const done = new Set<number>();
  let complete = true;
  for (const e of due) {
    const by = actorOf(doc, owner, e.owner);
    if (e.trashedAt !== null || !e.legacy || !by) {
      done.add(e.id);
      continue;
    }
    try {
      await trashNodes(ctx, by, [e.legacy]);
      done.add(e.id);
    } catch (err) {
      // Gone, or out of the person's reach since: nothing left to do for it.
      if (err instanceof AppError && (err.code === 'NOT_FOUND' || err.code === 'FORBIDDEN'))
        done.add(e.id);
      else {
        complete = false;
        log.warn('drive_expiry_failed', { node: e.legacy, error: String(err) });
      }
    }
  }
  if (done.size)
    await changeIndex(ctx.env.BUCKET, owner, (d) => {
      for (const e of d.entries()) if (done.has(e.id)) d.set({ ...e, expiresAt: null });
    });
  return complete;
}

/** The day-before reminder: one notice per person for what goes tomorrow. */
async function remindIndex(ctx: Ctx, owner: IndexOwner, day: number): Promise<void> {
  const { doc } = await readIndex(ctx.env.BUCKET, owner);
  const byPerson = new Map<string, string[]>();
  for (const e of doc.entries()) {
    if (e.trashedAt !== null || e.expiresAt === null) continue;
    if (e.expiresAt < day || e.expiresAt >= day + DAY_MS) continue;
    const who = actorOf(doc, owner, e.owner);
    if (who) byPerson.set(who, [...(byPerson.get(who) ?? []), e.name]);
  }
  for (const [userId, names] of byPerson)
    await notify(ctx, userId, 'file_expiring', {
      names: names.slice(0, 5),
      count: names.length,
      date: day,
    });
}

/** Nightly (02:00 WIB): reminders for tomorrow, and what is due today (or was missed) to the Trash. */
export async function runExpiries(ctx: Ctx): Promise<{ expired: number; reminded: number }> {
  const now = ctx.now();
  const today = wibDate(now);
  const tomorrow = addDaysWib(today, 1);
  const out = { expired: 0, reminded: 0 };
  let cursor: string | undefined;
  do {
    const page = await ctx.env.BUCKET.list({
      prefix: PREFIX,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const obj of page.objects) {
      const m = parseMarker(obj.key);
      if (!m) continue;
      if (m.day > tomorrow) return out;
      try {
        if (m.day === tomorrow) {
          await remindIndex(ctx, m.owner, wibDateToMs(tomorrow));
          out.reminded++;
        } else if (await expireIndex(ctx, m.owner, now)) {
          await ctx.env.BUCKET.delete(obj.key);
          out.expired++;
        }
      } catch (err) {
        log.warn('drive_expiry_marker_failed', { key: obj.key, error: String(err) });
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}
