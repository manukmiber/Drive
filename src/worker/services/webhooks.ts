// A6 (ADR-094): webhooks for Drive and Zeiko S3. A person registers https endpoints (kept in the
// access database with a sealed signing secret); Drive events follow the endpoint's own choice,
// S3 events a bucket's notification configuration (S3's own format, pointing at an endpoint).
// Events of one request go out together, one queue message per endpoint, signed with HMAC-SHA256
// over "timestamp.body", retried with backoff, and an endpoint that keeps failing is turned off.
// Payloads are metadata only: ids, names, sizes, times; never contents or download links.
import type { Ctx } from '../context';
import { accessDb } from '../lib/access-db';
import { aesGcmDecrypt, aesGcmEncrypt, hmacSha256, toHex } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { randomBase62, ulid } from '../lib/ids';
import { log } from '../lib/log';
import { notify } from './notify';
import { S3Error } from '../lib/s3-errors';
import { ownBucket } from './s3';

export const DRIVE_EVENTS = [
  'drive.file.uploaded',
  'drive.file.replaced',
  'drive.item.trashed',
  'drive.item.deleted',
  'drive.share.created',
] as const;
export type DriveEvent = (typeof DRIVE_EVENTS)[number];

/** Amazon's event names (with wildcards) that a bucket rule may ask for. */
export const S3_EVENTS = [
  's3:ObjectCreated:*',
  's3:ObjectCreated:Put',
  's3:ObjectCreated:Post',
  's3:ObjectCreated:Copy',
  's3:ObjectCreated:CompleteMultipartUpload',
  's3:ObjectRemoved:*',
  's3:ObjectRemoved:Delete',
  's3:ObjectRemoved:DeleteMarkerCreated',
  's3:LifecycleExpiration:*',
  's3:LifecycleExpiration:Delete',
  's3:LifecycleExpiration:DeleteMarkerCreated',
] as const;

// ───────────────────────────── where a webhook may go ─────────────────────────────

function v4(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const b = m.slice(1).map(Number);
  return b.every((x) => x <= 255) ? b : null;
}

function privateV4([a, b, c]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a! >= 224
  );
}

/** Loopback, private, link-local, shared, documentation, multicast and reserved addresses. */
export function isPrivateAddress(ip: string): boolean {
  const four = v4(ip);
  if (four) return privateV4(four);
  const s = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (!s.includes(':')) return true;
  // IPv4 inside IPv6 (::ffff:a.b.c.d, 64:ff9b::a.b.c.d): judged as the IPv4 address it carries.
  const tail = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (tail) return privateV4(v4(tail[1]!) ?? [0]);
  const groups = s.split('::');
  if (groups.length > 2) return true;
  const head = groups[0] ? groups[0].split(':') : [];
  const rest = groups[1] !== undefined ? (groups[1] ? groups[1].split(':') : []) : [];
  const full = [...head, ...Array(8 - head.length - rest.length).fill('0'), ...rest].map((g) =>
    parseInt(g || '0', 16),
  );
  if (full.length !== 8 || full.some((g) => Number.isNaN(g))) return true;
  const [g0] = full as [number];
  if (full.every((g) => g === 0)) return true; // ::
  if (full.slice(0, 7).every((g) => g === 0) && full[7] === 1) return true; // ::1
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  if (g0 === 0x2001 && full[1] === 0x0db8) return true; // documentation
  if (full.slice(0, 5).every((g) => g === 0) && full[5] === 0xffff) return true; // mapped, odd form
  return false;
}

const INTERNAL_NAME = /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa|corp|private)$/i;

/**
 * An endpoint must be https on the default port, with no credentials in it, a public name that
 * resolves only to public addresses, and not one of Zeiko's own hosts. Checked when it is saved
 * and again before every delivery (a name can change what it points at).
 */
export async function checkWebhookUrl(ctx: Ctx, raw: string): Promise<URL> {
  const bad = (reason: string) =>
    new AppError('VALIDATION', `webhook url: ${reason}`, { field: 'url', reason });
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw bad('invalid');
  }
  if (url.protocol !== 'https:') throw bad('https_only');
  if (url.username || url.password) throw bad('credentials');
  if (url.port && url.port !== '443') throw bad('port');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host.length > 253) throw bad('invalid');
  const literal = v4(host) !== null || host.startsWith('[');
  if (literal) {
    if (isPrivateAddress(host)) throw bad('private_address');
  } else {
    if (!host.includes('.') || INTERNAL_NAME.test(host)) throw bad('internal_host');
    const own = [
      ctx.env.APP_ORIGIN,
      ctx.env.S3_ORIGIN,
      ctx.env.DAV_ORIGIN,
      ctx.env.USERCONTENT_ORIGIN,
    ]
      .filter((o): o is string => Boolean(o))
      .map((o) => new URL(o).hostname.toLowerCase());
    if (own.some((o) => host === o || host.endsWith(`.${o}`))) throw bad('own_host');
    let addrs: string[];
    try {
      addrs = await ctx.adapters.webhooks.resolve(host);
    } catch {
      throw bad('dns_failed');
    }
    if (!addrs.length) throw bad('no_address');
    if (addrs.some(isPrivateAddress)) throw bad('private_address');
  }
  return url;
}

// ───────────────────────────── endpoints ─────────────────────────────

interface WebhookRow {
  id: string;
  user_id: string;
  url: string;
  secret_enc: string;
  events_json: string;
  description: string | null;
  failures: number;
  disabled_at: number | null;
  disabled_reason: string | null;
  last_success_at: number | null;
  created_at: number;
}

export interface WebhookView {
  id: string;
  url: string;
  events: DriveEvent[];
  description: string | null;
  enabled: boolean;
  disabledReason: string | null;
  failures: number;
  lastSuccessAt: number | null;
  createdAt: number;
}

const viewOf = (r: WebhookRow): WebhookView => ({
  id: r.id,
  url: r.url,
  events: JSON.parse(r.events_json) as DriveEvent[],
  description: r.description,
  enabled: r.disabled_at === null,
  disabledReason: r.disabled_reason,
  failures: r.failures,
  lastSuccessAt: r.last_success_at,
  createdAt: r.created_at,
});

const seal = (ctx: Ctx, secret: string) => aesGcmEncrypt(ctx.env.CONTACTS_ENC_KEY, secret);
const newSecret = () => `whsec_${randomBase62(32)}`;

export async function listWebhooks(ctx: Ctx, userId: string): Promise<WebhookView[]> {
  const { results } = await accessDb(ctx.env)
    .prepare(`SELECT * FROM webhooks WHERE user_id = ?1 ORDER BY created_at`)
    .bind(userId)
    .all<WebhookRow>();
  return results.map(viewOf);
}

async function ownHook(ctx: Ctx, userId: string, id: string): Promise<WebhookRow> {
  const r = await accessDb(ctx.env)
    .prepare(`SELECT * FROM webhooks WHERE id = ?1 AND user_id = ?2`)
    .bind(id, userId)
    .first<WebhookRow>();
  if (!r) throw new AppError('NOT_FOUND', 'no such webhook');
  return r;
}

export interface WebhookInput {
  url: string;
  events: DriveEvent[];
  description?: string | null | undefined;
}

/** The secret is shown once, here (and when rotated). */
export async function createWebhook(
  ctx: Ctx,
  userId: string,
  input: WebhookInput,
): Promise<{ webhook: WebhookView; secret: string }> {
  const url = await checkWebhookUrl(ctx, input.url);
  const cfg = await ctx.config();
  const db = accessDb(ctx.env);
  const n = await db
    .prepare(`SELECT COUNT(*) AS n FROM webhooks WHERE user_id = ?1`)
    .bind(userId)
    .first<{ n: number }>();
  if ((n?.n ?? 0) >= cfg.webhook_max_per_account)
    throw new AppError('CONFLICT', 'too many webhooks', { reason: 'WEBHOOK_LIMIT' });
  const secret = newSecret();
  const row: WebhookRow = {
    id: ulid(ctx.now()),
    user_id: userId,
    url: url.toString(),
    secret_enc: await seal(ctx, secret),
    events_json: JSON.stringify([...new Set(input.events)]),
    description: input.description?.trim() || null,
    failures: 0,
    disabled_at: null,
    disabled_reason: null,
    last_success_at: null,
    created_at: ctx.now(),
  };
  await db
    .prepare(
      `INSERT INTO webhooks (id, user_id, url, secret_enc, events_json, description, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(row.id, userId, row.url, row.secret_enc, row.events_json, row.description, row.created_at)
    .run();
  return { webhook: viewOf(row), secret };
}

export async function updateWebhook(
  ctx: Ctx,
  userId: string,
  id: string,
  change: Partial<WebhookInput> & { enabled?: boolean | undefined },
): Promise<WebhookView> {
  const r = await ownHook(ctx, userId, id);
  if (change.url !== undefined) r.url = (await checkWebhookUrl(ctx, change.url)).toString();
  if (change.events !== undefined) r.events_json = JSON.stringify([...new Set(change.events)]);
  if (change.description !== undefined) r.description = change.description?.trim() || null;
  if (change.enabled === true) {
    r.disabled_at = null;
    r.disabled_reason = null;
    r.failures = 0;
  } else if (change.enabled === false && r.disabled_at === null) {
    r.disabled_at = ctx.now();
    r.disabled_reason = 'owner';
  }
  await accessDb(ctx.env)
    .prepare(
      `UPDATE webhooks SET url = ?3, events_json = ?4, description = ?5, disabled_at = ?6,
         disabled_reason = ?7, failures = ?8 WHERE id = ?1 AND user_id = ?2`,
    )
    .bind(
      id,
      userId,
      r.url,
      r.events_json,
      r.description,
      r.disabled_at,
      r.disabled_reason,
      r.failures,
    )
    .run();
  return viewOf(r);
}

export async function rotateWebhookSecret(ctx: Ctx, userId: string, id: string): Promise<string> {
  await ownHook(ctx, userId, id);
  const secret = newSecret();
  await accessDb(ctx.env)
    .prepare(`UPDATE webhooks SET secret_enc = ?3 WHERE id = ?1 AND user_id = ?2`)
    .bind(id, userId, await seal(ctx, secret))
    .run();
  return secret;
}

export async function deleteWebhook(ctx: Ctx, userId: string, id: string): Promise<void> {
  await ownHook(ctx, userId, id);
  await accessDb(ctx.env).batch([
    accessDb(ctx.env)
      .prepare(`DELETE FROM webhooks WHERE id = ?1 AND user_id = ?2`)
      .bind(id, userId),
    accessDb(ctx.env).prepare(`DELETE FROM webhook_deliveries WHERE webhook_id = ?1`).bind(id),
  ]);
}

export interface DeliveryView {
  id: string;
  webhookId: string;
  event: string;
  count: number;
  status: 'pending' | 'ok' | 'retrying' | 'failed';
  attempts: number;
  responseStatus: number | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

/** The last 7 days of deliveries (the newest first), of one endpoint or all; `s3` = S3 events only. */
export async function listDeliveries(
  ctx: Ctx,
  userId: string,
  opts: { webhookId?: string | undefined; s3?: boolean | undefined; limit?: number } = {},
): Promise<DeliveryView[]> {
  const where = [`user_id = ?1`];
  const binds: unknown[] = [userId];
  if (opts.webhookId) {
    binds.push(opts.webhookId);
    where.push(`webhook_id = ?${binds.length}`);
  }
  if (opts.s3) where.push(`event LIKE 's3:%'`);
  binds.push(Math.min(opts.limit ?? 50, 200));
  const { results } = await accessDb(ctx.env)
    .prepare(
      `SELECT * FROM webhook_deliveries WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT ?${binds.length}`,
    )
    .bind(...binds)
    .all<{
      id: string;
      webhook_id: string;
      event: string;
      count: number;
      status: DeliveryView['status'];
      attempts: number;
      response_status: number | null;
      error: string | null;
      created_at: number;
      updated_at: number;
    }>();
  return results.map((r) => ({
    id: r.id,
    webhookId: r.webhook_id,
    event: r.event,
    count: r.count,
    status: r.status,
    attempts: r.attempts,
    responseStatus: r.response_status,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

// ───────────────────────────── collecting events ─────────────────────────────

/** One event as it goes out: Drive's own shape, or an S3 record. */
type Outgoing =
  | { kind: 'drive'; event: Record<string, unknown> }
  | { kind: 's3'; record: Record<string, unknown> };

interface Pending {
  /** Drive events by the users whose endpoints may want them. */
  drive: Array<{ users: string[]; type: DriveEvent; event: Record<string, unknown> }>;
  /** S3 records already matched to an endpoint (checked to be the bucket owner's at flush). */
  s3: Array<{ webhookId: string; userId: string; name: string; record: Record<string, unknown> }>;
  running: boolean;
}

const pendings = new WeakMap<Ctx, Pending>();

function pendingOf(ctx: Ctx): Pending {
  let p = pendings.get(ctx);
  if (!p) pendings.set(ctx, (p = { drive: [], s3: [], running: false }));
  if (!p.running) {
    p.running = true;
    ctx.defer(flushWebhooks(ctx, p));
  }
  return p;
}

export interface DriveItem {
  id: string;
  name: string;
  kind?: string;
  parent_id: string | null;
  space: string;
  owner_id: string;
  family_id?: string | null;
  size?: number | null;
  mime?: string | null;
}

/** A Drive event for the space's people: the owner, or every member of the family. */
export function noteDriveEvent(ctx: Ctx, actorId: string, type: DriveEvent, item: DriveItem): void {
  const p = pendingOf(ctx);
  p.drive.push({
    users:
      item.space === 'family' && item.family_id ? [`family:${item.family_id}`] : [item.owner_id],
    type,
    event: {
      type,
      time: new Date(ctx.now()).toISOString(),
      actor: actorId,
      item: {
        id: item.id,
        name: item.name,
        kind: item.kind ?? 'file',
        parentId: item.parent_id,
        space: item.space,
        ...((item.kind ?? 'file') === 'file'
          ? { size: item.size ?? null, mime: item.mime ?? null }
          : {}),
      },
    },
  });
}

export interface NotificationRule {
  id: string;
  webhookId: string;
  events: string[];
  prefix?: string;
  suffix?: string;
}

export function parseRules(json: string | null | undefined): NotificationRule[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as NotificationRule[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export const webhookArn = (id: string) => `arn:zeiko:webhook:::${id}`;

/** A destination as S3 clients send it: our ARN, or the bare id. */
export function webhookIdOf(dest: string): string {
  const id = dest.trim().split(':').pop() ?? '';
  return id;
}

/**
 * PutBucketNotificationConfiguration (and the /s3 page): the rules are checked like Amazon does,
 * and every destination must be one of the owner's own webhooks. An empty list removes them.
 */
export async function setBucketNotifications(
  ctx: Ctx,
  userId: string,
  bucket: string,
  rules: NotificationRule[],
): Promise<NotificationRule[]> {
  await ownBucket(ctx, userId, bucket);
  const bad = (m: string) => new S3Error('InvalidArgument', m);
  if (rules.length > 100) throw bad('A bucket can have at most 100 notification rules.');
  const ids = new Set<string>();
  for (const r of rules) {
    if (!r.id || r.id.length > 255) throw bad('The configuration Id is invalid.');
    if (ids.has(r.id)) throw bad('Configuration Ids must be unique.');
    ids.add(r.id);
    if (!r.events.length) throw bad('A notification configuration needs at least one Event.');
    for (const e of r.events)
      if (!(S3_EVENTS as readonly string[]).includes(e))
        throw bad(`The event is not supported for notifications: ${e}`);
    if ((r.prefix?.length ?? 0) > 1024 || (r.suffix?.length ?? 0) > 1024)
      throw bad('A filter value is too long.');
  }
  const wanted = [...new Set(rules.map((r) => r.webhookId))];
  if (wanted.length) {
    const { results } = await accessDb(ctx.env)
      .prepare(
        `SELECT id FROM webhooks WHERE user_id = ?1 AND id IN (SELECT value FROM json_each(?2))`,
      )
      .bind(userId, JSON.stringify(wanted))
      .all<{ id: string }>();
    const mine = new Set(results.map((r) => r.id));
    const missing = wanted.filter((w) => !mine.has(w));
    if (missing.length)
      throw new S3Error(
        'InvalidArgument',
        `Unable to validate the following destination configurations: ${missing.map(webhookArn).join(', ')}`,
      );
  }
  const clean = rules.map((r) => ({
    id: r.id,
    webhookId: r.webhookId,
    events: [...new Set(r.events)],
    ...(r.prefix ? { prefix: r.prefix } : {}),
    ...(r.suffix ? { suffix: r.suffix } : {}),
  }));
  await ctx.env.DB.prepare(
    `UPDATE s3_buckets SET notification_json = ?3 WHERE name = ?1 AND user_id = ?2`,
  )
    .bind(bucket, userId, clean.length ? JSON.stringify(clean) : null)
    .run();
  return clean;
}

const eventMatches = (wanted: string, name: string) =>
  wanted === name || (wanted.endsWith(':*') && name.startsWith(wanted.slice(0, -1)));

export interface S3EventObject {
  key: string;
  size?: number;
  etag?: string;
  versionId?: string | null;
}

/**
 * S3 events of one bucket (`name` is Amazon's, e.g. "s3:ObjectCreated:Put"), matched against its
 * notification rules now; nothing at all happens for a bucket without rules.
 */
export function noteS3Event(
  ctx: Ctx,
  bucket: { name: string; user_id: string; notification_json?: string | null },
  name: string,
  objects: S3EventObject[],
): void {
  const rules = parseRules(bucket.notification_json);
  if (!rules.length || !objects.length) return;
  const p = pendingOf(ctx);
  const time = new Date(ctx.now()).toISOString();
  for (const o of objects)
    for (const r of rules) {
      if (!r.events.some((e) => eventMatches(e, name))) continue;
      if (r.prefix && !o.key.startsWith(r.prefix)) continue;
      if (r.suffix && !o.key.endsWith(r.suffix)) continue;
      p.s3.push({
        webhookId: r.webhookId,
        userId: bucket.user_id,
        name,
        record: {
          eventVersion: '2.1',
          eventSource: 'zeiko:s3',
          awsRegion: 'auto',
          eventTime: time,
          eventName: name.replace(/^s3:/, ''),
          userIdentity: { principalId: bucket.user_id },
          s3: {
            s3SchemaVersion: '1.0',
            configurationId: r.id,
            bucket: {
              name: bucket.name,
              ownerIdentity: { principalId: bucket.user_id },
              arn: `arn:aws:s3:::${bucket.name}`,
            },
            object: {
              key: encodeURIComponent(o.key).replace(/%2F/g, '/'),
              ...(o.size !== undefined ? { size: o.size } : {}),
              ...(o.etag ? { eTag: o.etag } : {}),
              ...(o.versionId ? { versionId: o.versionId } : {}),
              sequencer: ctx.now().toString(16).toUpperCase().padStart(16, '0'),
            },
          },
        },
      });
    }
}

/** Events per message: queue messages stay well under their 128 KB. */
const PER_MESSAGE = 100;

export interface WebhookMessage {
  type: 'webhook';
  webhookId: string;
  deliveryId: string;
  event: string;
  body: string;
  attempt: number;
}

/** End of the request: one delivery per endpoint (more when many events), queued. */
async function flushWebhooks(ctx: Ctx, p: Pending): Promise<void> {
  // Let the request finish noting its events.
  await new Promise((r) => setTimeout(r, 0));
  const drive = p.drive.splice(0);
  const s3 = p.s3.splice(0);
  p.running = false;
  if (!drive.length && !s3.length) return;
  try {
    const out = new Map<string, { userId: string; events: Outgoing[]; first: string }>();
    const add = (id: string, userId: string, first: string, ev: Outgoing) => {
      let o = out.get(id);
      if (!o) out.set(id, (o = { userId, events: [], first }));
      o.events.push(ev);
    };
    if (drive.length) {
      // Family events go to every member's endpoints.
      const families = [
        ...new Set(drive.flatMap((d) => d.users).filter((u) => u.startsWith('family:'))),
      ].map((u) => u.slice(7));
      const members = new Map<string, string[]>();
      for (const f of families) {
        const { results } = await ctx.env.DB.prepare(
          `SELECT user_id FROM family_members WHERE family_id = ?1`,
        )
          .bind(f)
          .all<{ user_id: string }>();
        members.set(
          f,
          results.map((r) => r.user_id),
        );
      }
      const usersOf = (us: string[]) =>
        us.flatMap((u) => (u.startsWith('family:') ? (members.get(u.slice(7)) ?? []) : [u]));
      const everyone = [...new Set(drive.flatMap((d) => usersOf(d.users)))];
      const { results: hooks } = await accessDb(ctx.env)
        .prepare(
          `SELECT id, user_id, events_json FROM webhooks
           WHERE disabled_at IS NULL AND user_id IN (SELECT value FROM json_each(?1))`,
        )
        .bind(JSON.stringify(everyone))
        .all<{ id: string; user_id: string; events_json: string }>();
      for (const h of hooks) {
        const wants = new Set(JSON.parse(h.events_json) as string[]);
        for (const d of drive)
          if (wants.has(d.type) && usersOf(d.users).includes(h.user_id))
            add(h.id, h.user_id, d.type, { kind: 'drive', event: d.event });
      }
    }
    if (s3.length) {
      // A rule may only reach its bucket owner's own, enabled endpoints.
      const ids = [...new Set(s3.map((e) => e.webhookId))];
      const { results: hooks } = await accessDb(ctx.env)
        .prepare(
          `SELECT id, user_id FROM webhooks
           WHERE disabled_at IS NULL AND id IN (SELECT value FROM json_each(?1))`,
        )
        .bind(JSON.stringify(ids))
        .all<{ id: string; user_id: string }>();
      const owner = new Map(hooks.map((h) => [h.id, h.user_id]));
      for (const e of s3)
        if (owner.get(e.webhookId) === e.userId)
          add(e.webhookId, e.userId, e.name, { kind: 's3', record: e.record });
    }
    for (const [webhookId, o] of out)
      for (let i = 0; i < o.events.length; i += PER_MESSAGE)
        await queueDelivery(ctx, webhookId, o.userId, o.events.slice(i, i + PER_MESSAGE));
  } catch (e) {
    // Webhooks never fail the change that caused them.
    log.warn('webhook_queue_failed', { message: String(e) });
  }
}

async function queueDelivery(ctx: Ctx, webhookId: string, userId: string, events: Outgoing[]) {
  const now = ctx.now();
  const id = ulid(now);
  const head = events[0]!;
  const s3 = head.kind === 's3';
  const first =
    head.kind === 's3' ? `s3:${String(head.record.eventName)}` : String(head.event.type);
  const body = s3
    ? JSON.stringify({ Records: events.map((e) => (e.kind === 's3' ? e.record : null)) })
    : JSON.stringify({
        id,
        createdAt: new Date(now).toISOString(),
        events: events.map((e) => (e.kind === 'drive' ? e.event : null)),
      });
  await accessDb(ctx.env)
    .prepare(
      `INSERT INTO webhook_deliveries (id, webhook_id, user_id, event, count, status, attempts, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 0, ?6, ?6)`,
    )
    .bind(id, webhookId, userId, first, events.length, now)
    .run();
  const msg: WebhookMessage = {
    type: 'webhook',
    webhookId,
    deliveryId: id,
    event: first,
    body,
    attempt: 0,
  };
  await ctx.env.NOTIFY_QUEUE.send(msg);
}

/** "Send a test": one ping event to the endpoint, through the same path. */
export async function testWebhook(ctx: Ctx, userId: string, id: string): Promise<void> {
  await ownHook(ctx, userId, id);
  await queueDelivery(ctx, id, userId, [
    {
      kind: 'drive',
      event: { type: 'webhook.test', time: new Date(ctx.now()).toISOString(), actor: userId },
    },
  ]);
}

// ───────────────────────────── delivering ─────────────────────────────

/** Seconds before attempt n+1 (n = attempts made): 30 s, 2 min, 10 min, 30 min, 1 h, 2 h… */
export function webhookBackoff(attempts: number): number {
  return [30, 120, 600, 1800, 3600][attempts - 1] ?? 7200;
}

/** The signature a receiver checks: hex HMAC-SHA256 of "timestamp.body" with the endpoint's secret. */
export async function webhookSignature(secret: string, timestamp: number, body: string) {
  return toHex(await hmacSha256(secret, `${timestamp}.${body}`));
}

/** Queue `notify`, `webhook`: one attempt; a failure is sent again later, or gives up. */
export async function deliverWebhook(ctx: Ctx, msg: WebhookMessage): Promise<void> {
  const db = accessDb(ctx.env);
  const cfg = await ctx.config();
  const now = ctx.now();
  const hook = await db
    .prepare(`SELECT * FROM webhooks WHERE id = ?1`)
    .bind(msg.webhookId)
    .first<WebhookRow>();
  const settle = (status: DeliveryView['status'], code: number | null, error: string | null) =>
    db
      .prepare(
        `UPDATE webhook_deliveries SET status = ?2, attempts = ?3, response_status = ?4, error = ?5,
           updated_at = ?6 WHERE id = ?1`,
      )
      .bind(msg.deliveryId, status, msg.attempt + 1, code, error, now)
      .run();
  if (!hook || hook.disabled_at !== null) {
    await settle('failed', null, hook ? 'endpoint turned off' : 'endpoint deleted');
    return;
  }
  let code: number | null = null;
  let error: string;
  try {
    // Checked again now: the name may point somewhere else since it was saved.
    await checkWebhookUrl(ctx, hook.url);
    const secret = await aesGcmDecrypt(ctx.env.CONTACTS_ENC_KEY, hook.secret_enc);
    const ts = Math.floor(now / 1000);
    const res = await ctx.adapters.webhooks.send(hook.url, msg.body, {
      'content-type': 'application/json',
      'user-agent': 'Zeiko-Webhooks/1.0',
      'zeiko-webhook-id': hook.id,
      'zeiko-delivery': msg.deliveryId,
      'zeiko-event': msg.event,
      'zeiko-timestamp': String(ts),
      'zeiko-signature': `v1=${await webhookSignature(secret, ts, msg.body)}`,
    });
    code = res.status;
    if (res.status >= 200 && res.status < 300) {
      await db.batch([
        db
          .prepare(
            `UPDATE webhook_deliveries SET status = 'ok', attempts = ?2, response_status = ?3, error = NULL,
               updated_at = ?4 WHERE id = ?1`,
          )
          .bind(msg.deliveryId, msg.attempt + 1, res.status, now),
        db
          .prepare(`UPDATE webhooks SET failures = 0, last_success_at = ?2 WHERE id = ?1`)
          .bind(hook.id, now),
      ]);
      return;
    }
    error =
      res.status >= 300 && res.status < 400 ? 'redirects are not followed' : `HTTP ${res.status}`;
  } catch (e) {
    error =
      e instanceof AppError ? String(e.data?.reason ?? e.message) : 'network error or timeout';
  }
  if (msg.attempt + 1 < cfg.webhook_max_attempts) {
    await settle('retrying', code, error);
    await ctx.env.NOTIFY_QUEUE.send(
      { ...msg, attempt: msg.attempt + 1 },
      { delaySeconds: webhookBackoff(msg.attempt + 1) },
    );
    return;
  }
  await settle('failed', code, error);
  // Deliveries that gave up, in a row: the endpoint is turned off and its owner told.
  const after = await db
    .prepare(`UPDATE webhooks SET failures = failures + 1 WHERE id = ?1 RETURNING failures`)
    .bind(hook.id)
    .first<{ failures: number }>();
  if ((after?.failures ?? 0) >= cfg.webhook_disable_after) {
    const off = await db
      .prepare(
        `UPDATE webhooks SET disabled_at = ?2, disabled_reason = 'failing' WHERE id = ?1 AND disabled_at IS NULL`,
      )
      .bind(hook.id, now)
      .run();
    if (off.meta.changes) await notify(ctx, hook.user_id, 'webhook_disabled', { url: hook.url });
  }
}

/** Daily: deliveries older than 7 days go. */
export async function pruneDeliveries(ctx: Ctx): Promise<number> {
  const res = await accessDb(ctx.env)
    .prepare(`DELETE FROM webhook_deliveries WHERE created_at < ?1`)
    .bind(ctx.now() - 7 * 86_400_000)
    .run();
  return res.meta.changes ?? 0;
}

/** Account deletion: the person's endpoints and their log. */
export async function deleteUserWebhooks(ctx: Ctx, userId: string): Promise<void> {
  const db = accessDb(ctx.env);
  await db.batch([
    db.prepare(`DELETE FROM webhook_deliveries WHERE user_id = ?1`).bind(userId),
    db.prepare(`DELETE FROM webhooks WHERE user_id = ?1`).bind(userId),
  ]);
}
