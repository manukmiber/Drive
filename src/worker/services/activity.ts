// D4 (ADR-083): what happened to files and folders, for the Activity panel. Not a D1 table
// (ADR-064): one log per space and month in R2, next to its index, `u/{userId}/log/{YYYY-MM}.txt`
// or `f/{familyId}/log/{YYYY-MM}.txt`, one JSON array per line:
//   [time (unix s), actor, action, node, parent, name, from, to, from-parent]
// with trailing empty cells left off. A month per object keeps a 90-day read to four GETs (Workers
// Free allows 50 subrequests) and the newest lines last, so a read walks back from the end.
//
// Services record events as they change D1; the lines are written once the request is done (one
// conditional append per log, retried like the index). The log is a record, not the source of
// truth: a write that fails loses lines, never the change. Writing a month's first line also leaves
// a marker `sys/activity/{YYYY-MM}/{u|f}/{id}` so the nightly cron can drop months past retention
// without listing every person's folder.
import { ACTIVITY_ACTIONS, type ActivityAction, type ActivityItem } from '../../shared/activity';
import { DAY_MS } from '../../shared/constants';
import { wibDate } from '../../shared/time';
import type { Ctx } from '../context';
import { idSlices } from '../lib/access-db';
import { log } from '../lib/log';
import { requireNode, type NodeRecord } from './access';
import { isRateLimited, type IndexOwner } from './drive-index';
import { flushDelay } from './drive-index-sync';
import { treeNode } from './drive-read';

export { ACTIVITY_ACTIONS, type ActivityAction, type ActivityItem } from '../../shared/activity';

/** Where a node's events go: its space's log. */
export type Located = Pick<NodeRecord, 'space' | 'owner_id' | 'family_id'>;

export function logOf(n: Located): IndexOwner {
  return n.space === 'family' && n.family_id ? { family: n.family_id } : { user: n.owner_id };
}

const folderOf = (o: IndexOwner) => ('user' in o ? `u/${o.user}` : `f/${o.family}`);
const logKey = (o: IndexOwner, month: string) => `${folderOf(o)}/log/${month}.txt`;
const MARKS = 'sys/activity/';
const markKey = (o: IndexOwner, month: string) =>
  `${MARKS}${month}/${'user' in o ? `u/${o.user}` : `f/${o.family}`}`;
const monthOf = (ms: number) => wibDate(ms).slice(0, 7);

interface Pending {
  lines: Map<string, { owner: IndexOwner; month: string; lines: string[] }>;
  running: boolean;
}
const pending = new WeakMap<Ctx, Pending>();

export interface ActivityEvent {
  action: ActivityAction;
  node: Pick<NodeRecord, 'id' | 'parent_id' | 'name'> & Located;
  from?: string | null | undefined;
  to?: string | null | undefined;
  fromParent?: string | null | undefined;
}

/** Notes an event for the node's space; written when the request is done. */
export function recordActivity(ctx: Ctx, actorId: string, ev: ActivityEvent): void {
  const now = ctx.now();
  const owner = logOf(ev.node);
  const month = monthOf(now);
  const row: Array<string | number> = [
    Math.floor(now / 1000),
    actorId,
    ev.action,
    ev.node.id,
    ev.node.parent_id ?? '',
    ev.node.name,
    ev.from ?? '',
    ev.to ?? '',
    ev.fromParent ?? '',
  ];
  let end = row.length;
  while (end > 6 && row[end - 1] === '') end--;
  let p = pending.get(ctx);
  if (!p) pending.set(ctx, (p = { lines: new Map(), running: false }));
  const key = logKey(owner, month);
  const slot = p.lines.get(key) ?? { owner, month, lines: [] };
  slot.lines.push(`${JSON.stringify(row.slice(0, end))}\n`);
  p.lines.set(key, slot);
  if (!p.running) {
    p.running = true;
    ctx.defer(writeLogs(ctx, p));
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function writeLogs(ctx: Ctx, p: Pending): Promise<void> {
  // Let the request finish noting its events, so one change makes one write per log.
  await sleep(flushDelay(ctx));
  try {
    while (p.lines.size) {
      const batch = [...p.lines.values()];
      p.lines.clear();
      for (const b of batch) {
        try {
          await append(ctx, b.owner, b.month, b.lines.join(''));
        } catch (e) {
          log.warn('activity_write_failed', { key: logKey(b.owner, b.month), error: String(e) });
        }
      }
    }
  } finally {
    p.running = false;
  }
}

async function append(ctx: Ctx, owner: IndexOwner, month: string, text: string): Promise<void> {
  const key = logKey(owner, month);
  for (let attempt = 1; ; attempt++) {
    const obj = await ctx.env.BUCKET.get(key);
    const body = obj ? await obj.text() : '';
    let limited = false;
    try {
      const put = await ctx.env.BUCKET.put(key, body + text, {
        httpMetadata: { contentType: 'text/plain; charset=utf-8', cacheControl: 'no-store' },
        onlyIf: obj ? { etagMatches: obj.etag } : new Headers({ 'if-none-match': '*' }),
      });
      if (put) {
        if (!obj) await ctx.env.BUCKET.put(markKey(owner, month), '');
        return;
      }
    } catch (e) {
      if (!isRateLimited(e)) throw e;
      limited = true;
    }
    if (attempt >= 8) throw new Error('activity log busy');
    await sleep((limited ? 1000 : 150 * attempt) + Math.floor(Math.random() * 250));
  }
}

type Row = [number, string, string, string, string?, string?, string?, string?, string?];

/**
 * Events of one log back to `since` that `want` keeps, newest first (at most `limit`). Requests
 * append in the order their writes land, which may be a little out of time order, so a month is
 * read whole and sorted; older months are read only while more are wanted.
 */
async function readLog(
  ctx: Ctx,
  owner: IndexOwner,
  since: number,
  limit: number,
  want: (r: Row) => boolean,
  hint?: string,
): Promise<Row[]> {
  const listed = await ctx.env.BUCKET.list({ prefix: `${folderOf(owner)}/log/`, limit: 1000 });
  const keys = listed.objects
    .map((o) => o.key)
    .filter((k) => /\/log\/\d{4}-\d{2}\.txt$/.test(k) && k.slice(-11, -4) >= monthOf(since))
    .sort()
    .reverse();
  // Within a second, a later line is the later event.
  const out: Array<{ row: Row; seq: number }> = [];
  let seq = 0;
  for (const key of keys) {
    if (out.length >= limit) break;
    const obj = await ctx.env.BUCKET.get(key);
    if (!obj || !('text' in obj)) continue;
    const base = (seq -= 1_000_000);
    (await obj.text()).split('\n').forEach((line, i) => {
      if (!line || (hint && !line.includes(hint))) return;
      let row: Row;
      try {
        row = JSON.parse(line) as Row;
      } catch {
        return;
      }
      if (row[0] * 1000 >= since && want(row)) out.push({ row, seq: base + i });
    });
  }
  return out
    .sort((a, b) => b.row[0] - a.row[0] || b.seq - a.seq)
    .slice(0, limit)
    .map((x) => x.row);
}

async function since(ctx: Ctx): Promise<number> {
  const cfg = await ctx.config();
  return ctx.now() - cfg.activity_keep_days * DAY_MS;
}

/** Rows as the app shows them, with family members' names. */
async function toItems(
  ctx: Ctx,
  userId: string,
  rows: Array<{ row: Row; space: 'personal' | 'family' }>,
): Promise<ActivityItem[]> {
  const others = [...new Set(rows.map((r) => r.row[1]).filter((id) => id !== userId))];
  const names = new Map<string, string>();
  for (const slice of idSlices(others)) {
    const { results } = await ctx.env.DB.prepare(
      `SELECT id, name FROM users WHERE id IN (SELECT value FROM json_each(?1)) AND status != 'deleted'`,
    )
      .bind(slice)
      .all<{ id: string; name: string }>();
    for (const r of results) names.set(r.id, r.name);
  }
  return rows.map(({ row, space }) => ({
    at: row[0] * 1000,
    actorId: row[1],
    actorName: row[1] === userId ? null : (names.get(row[1]) ?? null),
    action: (ACTIVITY_ACTIONS as readonly string[]).includes(row[2])
      ? (row[2] as ActivityAction)
      : 'rename',
    nodeId: row[3],
    parentId: row[4] || null,
    name: row[5] ?? '',
    from: row[6] || null,
    to: row[7] || null,
    space,
  }));
}

/**
 * A file's events, or a folder's own and its direct contents' (SPEC §8.1). Who may see the node
 * may see its activity: a personal space only its owner, a family's every member.
 */
export async function nodeActivity(
  ctx: Ctx,
  userId: string,
  nodeId: string,
  limit = 100,
): Promise<ActivityItem[]> {
  const found = await treeNode(ctx, userId, nodeId);
  let owner: IndexOwner;
  let folder: boolean;
  if (found) {
    owner = found.index;
    folder = found.node.kind === 'folder';
  } else {
    const { node } = await requireNode(ctx, userId, nodeId, 'view');
    owner = logOf(node);
    folder = node.kind === 'folder';
  }
  const rows = await readLog(
    ctx,
    owner,
    await since(ctx),
    Math.min(limit, 200),
    (r) => r[3] === nodeId || (folder && (r[4] === nodeId || r[8] === nodeId)),
    nodeId,
  );
  const space = 'user' in owner ? 'personal' : 'family';
  return toItems(
    ctx,
    userId,
    rows.map((row) => ({ row, space })),
  );
}

/** The latest events in the person's own space and their family's, newest first. */
export async function recentActivity(
  ctx: Ctx,
  userId: string,
  limit = 50,
): Promise<ActivityItem[]> {
  const fam = await ctx.env.DB.prepare('SELECT family_id FROM family_members WHERE user_id = ?1')
    .bind(userId)
    .first<{ family_id: string }>();
  const from = await since(ctx);
  const n = Math.min(limit, 200);
  const [own, family] = await Promise.all([
    readLog(ctx, { user: userId }, from, n, () => true),
    fam ? readLog(ctx, { family: fam.family_id }, from, n, () => true) : Promise.resolve([]),
  ]);
  const rows = [
    ...own.map((row) => ({ row, space: 'personal' as const })),
    ...family.map((row) => ({ row, space: 'family' as const })),
  ]
    .sort((a, b) => b.row[0] - a.row[0])
    .slice(0, n);
  return toItems(ctx, userId, rows);
}

/** Everything a person's own log holds (data export). */
export async function exportActivity(ctx: Ctx, userId: string): Promise<ActivityItem[]> {
  const rows = await readLog(ctx, { user: userId }, 0, 100_000, () => true);
  return toItems(
    ctx,
    userId,
    rows.map((row) => ({ row, space: 'personal' as const })),
  );
}

/** Drops a space's whole log (account deleted, family ended). */
export async function deleteActivity(ctx: Ctx, owner: IndexOwner): Promise<void> {
  const listed = await ctx.env.BUCKET.list({ prefix: `${folderOf(owner)}/log/`, limit: 1000 });
  const keys = listed.objects.map((o) => o.key);
  if (keys.length) await ctx.env.BUCKET.delete(keys);
}

/** Nightly: months whose last day is past retention go, with their markers. */
export async function pruneActivity(ctx: Ctx): Promise<number> {
  const cfg = await ctx.config();
  // A month may go once its last day is older than the retention: i.e. the month before the
  // cutoff's month and earlier.
  const cutoff = monthOf(ctx.now() - cfg.activity_keep_days * DAY_MS);
  let dropped = 0;
  let cursor: string | undefined;
  do {
    const page = await ctx.env.BUCKET.list({
      prefix: MARKS,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const obj of page.objects) {
      const m = /^sys\/activity\/(\d{4}-\d{2})\/(u|f)\/([^/]+)$/.exec(obj.key);
      if (!m) continue;
      if (m[1]! >= cutoff) return dropped;
      const owner: IndexOwner = m[2] === 'u' ? { user: m[3]! } : { family: m[3]! };
      await ctx.env.BUCKET.delete([logKey(owner, m[1]!), obj.key]);
      dropped++;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return dropped;
}
