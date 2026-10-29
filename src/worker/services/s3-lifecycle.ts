// Lifecycle rules for Zeiko S3 buckets (ADR-072): Put/Get/DeleteBucketLifecycleConfiguration and the
// hourly run that carries them out. Supported: Expiration (Days or Date) and
// AbortIncompleteMultipartUpload, filtered by prefix, object size and object tags (ADR-076).
// Anything else in a rule is refused out loud (MalformedXML / NotImplemented), never silently ignored.
import { DAY_MS } from '../../shared/constants';
import type { Ctx } from '../context';
import { log } from '../lib/log';
import { S3Error } from '../lib/s3-errors';
import { esc, xmlElements, xmlText } from '../lib/s3-xml';
import { getAccount, ownBucket, type BucketRow } from './s3';
import { indexDb } from './s3-index';
import { deleteObjects, dropUpload, type UploadRow } from './s3-objects';
import { hasTags, tagElements, tagXml, validateTags, type Tag } from './s3-tags';

export interface LifecycleRule {
  id: string;
  enabled: boolean;
  /** Object keys the rule covers start with this; '' = the whole bucket. */
  prefix: string;
  /** Bytes; the object must be strictly bigger / smaller. */
  sizeGreaterThan?: number;
  sizeLessThan?: number;
  /** The object must carry every one of these tags (ADR-076). */
  tags?: Tag[];
  /** Objects are deleted this many days after they were written (rounded as Amazon does). */
  expirationDays?: number;
  /** …or from this midnight UTC (ms) on. */
  expirationDate?: number;
  /** Unfinished multipart uploads are aborted this many days after they began. */
  abortDays?: number;
}

const MALFORMED =
  'The XML you provided was not well-formed or did not validate against our published schema.';
const malformed = (message = MALFORMED) => new S3Error('MalformedXML', message);
const notImplemented = (what: string) =>
  new S3Error('NotImplemented', `${what} is not supported by Zeiko S3 lifecycle rules.`);

/** The names of the direct child elements of an XML fragment, in order. */
function childTags(xml: string): string[] {
  const out: string[] = [];
  let depth = 0;
  for (const m of xml.matchAll(/<(\/?)(?:[A-Za-z0-9_]+:)?([A-Za-z0-9_]+)[^>]*?(\/?)>/g)) {
    const [, closing, name, selfClosing] = m;
    if (name === undefined) continue;
    if (closing) depth--;
    else {
      if (depth === 0) out.push(name);
      if (!selfClosing) depth++;
    }
  }
  return out;
}

/** Elements Zeiko S3 knows but doesn't do yet: a clear 501 instead of a silent skip. */
const NOT_YET: Record<string, string> = {
  Transition: 'Transition (storage classes)',
  NoncurrentVersionTransition: 'NoncurrentVersionTransition (versioning)',
  NoncurrentVersionExpiration: 'NoncurrentVersionExpiration (versioning)',
  ExpiredObjectDeleteMarker: 'ExpiredObjectDeleteMarker (versioning)',
};

function only(xml: string, allowed: string[], where: string): void {
  for (const tag of childTags(xml)) {
    if (allowed.includes(tag)) continue;
    const later = NOT_YET[tag];
    if (later) throw notImplemented(later);
    throw malformed(`${tag} is not allowed in ${where}.`);
  }
}

function wholeNumber(v: string | null, name: string, min: number): number | undefined {
  if (v === null) return undefined;
  const t = v.trim();
  if (!/^\d+$/.test(t) || Number(t) < min || !Number.isSafeInteger(Number(t)))
    throw new S3Error('InvalidArgument', `${name} must be a whole number of at least ${min}.`);
  return Number(t);
}

/** Amazon wants a midnight UTC date ("2026-12-01" or "2026-12-01T00:00:00.000Z"). */
function midnightDate(v: string): number {
  const t = v.trim();
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T00:00:00Z` : t);
  if (Number.isNaN(ms) || ms % DAY_MS !== 0)
    throw new S3Error('InvalidArgument', "'Date' must be at midnight GMT");
  return ms;
}

/** Checks rules the way Amazon does and returns them cleaned (an ID for every rule). */
export function validateLifecycle(rules: LifecycleRule[], maxRules: number): LifecycleRule[] {
  if (!rules.length) throw malformed('A lifecycle configuration needs at least one Rule.');
  if (rules.length > maxRules)
    throw new S3Error(
      'InvalidRequest',
      `A lifecycle configuration can have at most ${maxRules} rules.`,
    );
  const ids = new Set<string>();
  return rules.map((r, i) => {
    const id = (r.id ?? '').trim() || `rule-${i + 1}`;
    if (id.length > 255) throw new S3Error('InvalidArgument', 'ID length should not exceed 255.');
    if (ids.has(id)) throw new S3Error('InvalidArgument', 'Rule ID must be unique.');
    ids.add(id);
    const hasExpiry = r.expirationDays !== undefined || r.expirationDate !== undefined;
    if (!hasExpiry && r.abortDays === undefined)
      throw new S3Error(
        'InvalidRequest',
        'At least one action needs to be specified in a rule (Expiration or AbortIncompleteMultipartUpload).',
      );
    if (r.expirationDays !== undefined && r.expirationDate !== undefined)
      throw malformed('Expiration takes either Days or Date, not both.');
    if (
      r.expirationDays !== undefined &&
      (!Number.isInteger(r.expirationDays) || r.expirationDays < 1)
    )
      throw new S3Error(
        'InvalidArgument',
        "'Days' for Expiration action must be a positive integer",
      );
    if (r.expirationDate !== undefined && r.expirationDate % DAY_MS !== 0)
      throw new S3Error('InvalidArgument', "'Date' must be at midnight GMT");
    if (r.abortDays !== undefined && (!Number.isInteger(r.abortDays) || r.abortDays < 1))
      throw new S3Error(
        'InvalidArgument',
        "'DaysAfterInitiation' for AbortIncompleteMultipartUpload action must be a positive integer",
      );
    const sized = r.sizeGreaterThan !== undefined || r.sizeLessThan !== undefined;
    if (sized && r.abortDays !== undefined)
      throw new S3Error(
        'InvalidRequest',
        'AbortIncompleteMultipartUpload cannot be specified with an object size filter.',
      );
    if (
      r.sizeGreaterThan !== undefined &&
      r.sizeLessThan !== undefined &&
      r.sizeLessThan <= r.sizeGreaterThan
    )
      throw new S3Error(
        'InvalidArgument',
        'ObjectSizeLessThan must be greater than ObjectSizeGreaterThan.',
      );
    if (new TextEncoder().encode(r.prefix).length > 1024)
      throw new S3Error('InvalidArgument', 'The prefix is too long.');
    const tags = r.tags?.length ? validateTags(r.tags) : undefined;
    if (tags && r.abortDays !== undefined)
      throw new S3Error(
        'InvalidRequest',
        'AbortIncompleteMultipartUpload cannot be specified with Tags.',
      );
    return {
      id,
      enabled: r.enabled,
      prefix: r.prefix,
      ...(r.sizeGreaterThan !== undefined ? { sizeGreaterThan: r.sizeGreaterThan } : {}),
      ...(r.sizeLessThan !== undefined ? { sizeLessThan: r.sizeLessThan } : {}),
      ...(tags ? { tags: tags.map((t) => ({ key: t.key, value: t.value })) } : {}),
      ...(r.expirationDays !== undefined ? { expirationDays: r.expirationDays } : {}),
      ...(r.expirationDate !== undefined ? { expirationDate: r.expirationDate } : {}),
      ...(r.abortDays !== undefined ? { abortDays: r.abortDays } : {}),
    };
  });
}

/** <Filter>: Prefix, a Tag, and size limits, alone or in an <And>. */
function parseFilter(
  xml: string,
): Pick<LifecycleRule, 'prefix' | 'sizeGreaterThan' | 'sizeLessThan' | 'tags'> {
  only(xml, ['Prefix', 'Tag', 'ObjectSizeGreaterThan', 'ObjectSizeLessThan', 'And'], 'Filter');
  const and = xmlElements(xml, 'And')[0];
  const direct = childTags(xml);
  if (and !== undefined && direct.length > 1)
    throw malformed('Filter takes either And or one condition, not both.');
  const block = and ?? xml;
  if (and !== undefined)
    only(and, ['Prefix', 'Tag', 'ObjectSizeGreaterThan', 'ObjectSizeLessThan'], 'And');
  else if (direct.length > 1) throw malformed('Use And to combine conditions in a Filter.');
  const gt = wholeNumber(xmlText(block, 'ObjectSizeGreaterThan'), 'ObjectSizeGreaterThan', 0);
  const lt = wholeNumber(xmlText(block, 'ObjectSizeLessThan'), 'ObjectSizeLessThan', 1);
  const tags = tagElements(block);
  return {
    prefix: xmlText(block, 'Prefix') ?? '',
    ...(gt !== undefined ? { sizeGreaterThan: gt } : {}),
    ...(lt !== undefined ? { sizeLessThan: lt } : {}),
    ...(tags.length ? { tags } : {}),
  };
}

/** <LifecycleConfiguration> as clients send it (aws s3api put-bucket-lifecycle-configuration, SDKs). */
export function parseLifecycleXml(xml: string, maxRules: number): LifecycleRule[] {
  const root = xmlElements(xml, 'LifecycleConfiguration')[0];
  if (root === undefined) throw malformed();
  only(root, ['Rule'], 'LifecycleConfiguration');
  const rules = xmlElements(root, 'Rule').map((rule): LifecycleRule => {
    only(
      rule,
      ['ID', 'Status', 'Filter', 'Prefix', 'Expiration', 'AbortIncompleteMultipartUpload'],
      'Rule',
    );
    const status = xmlText(rule, 'Status');
    if (status !== 'Enabled' && status !== 'Disabled')
      throw malformed('Status must be Enabled or Disabled.');
    const filter = xmlElements(rule, 'Filter')[0];
    // The old form: a Prefix straight under Rule (still accepted by Amazon).
    const legacyPrefix = childTags(rule).includes('Prefix') ? xmlText(rule, 'Prefix') : null;
    if (filter !== undefined && legacyPrefix !== null)
      throw malformed('Rule takes either Filter or Prefix, not both.');
    const scope = filter !== undefined ? parseFilter(filter) : { prefix: legacyPrefix ?? '' };
    let expirationDays: number | undefined;
    let expirationDate: number | undefined;
    const expiration = xmlElements(rule, 'Expiration')[0];
    if (expiration !== undefined) {
      only(expiration, ['Days', 'Date'], 'Expiration');
      expirationDays = wholeNumber(xmlText(expiration, 'Days'), 'Days', 1);
      const date = xmlText(expiration, 'Date');
      if (date !== null) expirationDate = midnightDate(date);
      if (expirationDays === undefined && expirationDate === undefined)
        throw malformed('Expiration needs Days or Date.');
    }
    let abortDays: number | undefined;
    const abort = xmlElements(rule, 'AbortIncompleteMultipartUpload')[0];
    if (abort !== undefined) {
      only(abort, ['DaysAfterInitiation'], 'AbortIncompleteMultipartUpload');
      abortDays = wholeNumber(xmlText(abort, 'DaysAfterInitiation'), 'DaysAfterInitiation', 1);
      if (abortDays === undefined)
        throw malformed('AbortIncompleteMultipartUpload needs DaysAfterInitiation.');
    }
    return {
      id: xmlText(rule, 'ID') ?? '',
      enabled: status === 'Enabled',
      ...scope,
      ...(expirationDays !== undefined ? { expirationDays } : {}),
      ...(expirationDate !== undefined ? { expirationDate } : {}),
      ...(abortDays !== undefined ? { abortDays } : {}),
    };
  });
  return validateLifecycle(rules, maxRules);
}

export function lifecycleXml(rules: LifecycleRule[]): string {
  const body = rules
    .map((r) => {
      const sized = r.sizeGreaterThan !== undefined || r.sizeLessThan !== undefined;
      const tags = r.tags ?? [];
      const combined = sized || tags.length > 1 || (tags.length === 1 && r.prefix !== '');
      const conditions =
        (tags.length === 1 && !combined ? '' : `<Prefix>${esc(r.prefix)}</Prefix>`) +
        tags.map(tagXml).join('') +
        (r.sizeGreaterThan !== undefined
          ? `<ObjectSizeGreaterThan>${r.sizeGreaterThan}</ObjectSizeGreaterThan>`
          : '') +
        (r.sizeLessThan !== undefined
          ? `<ObjectSizeLessThan>${r.sizeLessThan}</ObjectSizeLessThan>`
          : '');
      const expiration =
        r.expirationDays !== undefined
          ? `<Expiration><Days>${r.expirationDays}</Days></Expiration>`
          : r.expirationDate !== undefined
            ? `<Expiration><Date>${new Date(r.expirationDate).toISOString()}</Date></Expiration>`
            : '';
      const abort =
        r.abortDays !== undefined
          ? `<AbortIncompleteMultipartUpload><DaysAfterInitiation>${r.abortDays}</DaysAfterInitiation></AbortIncompleteMultipartUpload>`
          : '';
      return `<Rule><ID>${esc(r.id)}</ID><Filter>${combined ? `<And>${conditions}</And>` : conditions}</Filter><Status>${r.enabled ? 'Enabled' : 'Disabled'}</Status>${expiration}${abort}</Rule>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${body}</LifecycleConfiguration>`;
}

export function bucketLifecycle(b: Pick<BucketRow, 'lifecycle_json'>): LifecycleRule[] | null {
  if (!b.lifecycle_json) return null;
  try {
    const v = JSON.parse(b.lifecycle_json) as LifecycleRule[];
    return Array.isArray(v) && v.length ? v : null;
  } catch {
    return null;
  }
}

/** Owner only. `null` removes the configuration. A new configuration starts a fresh pass. */
export async function setBucketLifecycle(
  ctx: Ctx,
  userId: string,
  name: string,
  rules: LifecycleRule[] | null,
): Promise<LifecycleRule[] | null> {
  await ownBucket(ctx, userId, name);
  const cfg = await ctx.config();
  const clean = rules ? validateLifecycle(rules, cfg.s3_lifecycle_max_rules) : null;
  await ctx.env.DB.prepare(
    `UPDATE s3_buckets SET lifecycle_json = ?3, lifecycle_cursor = NULL, lifecycle_at = 0
     WHERE name = ?1 AND user_id = ?2`,
  )
    .bind(name, userId, clean ? JSON.stringify(clean) : null)
    .run();
  return clean;
}

// ───────────────────────────── the hourly run ─────────────────────────────

/**
 * Amazon's arithmetic: an object written at `t` expires at the first midnight UTC after
 * `t + days`, so on day `now` it is due when it was written before `(today − days)` midnight.
 */
export function expiryCutoff(now: number, days: number): number {
  return (Math.floor(now / DAY_MS) - days) * DAY_MS;
}

export function ruleCovers(
  r: LifecycleRule,
  o: { key: string; size: number; modified_at: number; tags_json?: string | null },
  now: number,
): boolean {
  if (!r.enabled || !o.key.startsWith(r.prefix)) return false;
  if (r.tags?.length && !hasTags(o.tags_json, r.tags)) return false;
  if (r.sizeGreaterThan !== undefined && !(o.size > r.sizeGreaterThan)) return false;
  if (r.sizeLessThan !== undefined && !(o.size < r.sizeLessThan)) return false;
  if (r.expirationDate !== undefined) return now >= r.expirationDate;
  if (r.expirationDays !== undefined) return o.modified_at < expiryCutoff(now, r.expirationDays);
  return false;
}

interface Cursor {
  rule: number;
  after: string;
}

/**
 * Hourly (ADR-072): a few buckets with rules, those mid-pass or whose last pass finished before
 * today (UTC) first. Each turn aborts due multipart uploads and looks at up to
 * `s3_lifecycle_scan_rows` objects of one rule, deleting the expired ones through the ordinary
 * delete path (storage, replicas and index stay right); the cursor carries on next hour.
 * Accounts whose bill is unpaid and locked, or that are suspended, are left alone (ADR-047).
 */
export async function runS3Lifecycle(ctx: Ctx): Promise<{ deleted: number; aborted: number }> {
  const cfg = await ctx.config();
  const now = ctx.now();
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const { results: buckets } = await ctx.env.DB.prepare(
    `SELECT name, user_id, lifecycle_json, lifecycle_cursor FROM s3_buckets
     WHERE lifecycle_json IS NOT NULL AND (lifecycle_cursor IS NOT NULL OR lifecycle_at < ?1)
     ORDER BY lifecycle_cursor IS NULL, lifecycle_at LIMIT ?2`,
  )
    .bind(today, cfg.s3_lifecycle_buckets_per_run)
    .all<{
      name: string;
      user_id: string;
      lifecycle_json: string;
      lifecycle_cursor: string | null;
    }>();
  let deleted = 0;
  let aborted = 0;
  for (const b of buckets) {
    try {
      const r = await bucketTurn(ctx, b, now, cfg.s3_lifecycle_scan_rows);
      deleted += r.deleted;
      aborted += r.aborted;
    } catch (e) {
      log.warn('s3_lifecycle_failed', { bucket: b.name, message: String(e) });
      // Try again from where it was next hour, behind the others.
      await ctx.env.DB.prepare(`UPDATE s3_buckets SET lifecycle_at = ?2 WHERE name = ?1`)
        .bind(b.name, now)
        .run();
    }
  }
  return { deleted, aborted };
}

async function bucketTurn(
  ctx: Ctx,
  b: { name: string; user_id: string; lifecycle_json: string; lifecycle_cursor: string | null },
  now: number,
  scanRows: number,
): Promise<{ deleted: number; aborted: number }> {
  const rules = bucketLifecycle(b) ?? [];
  const account = await getAccount(ctx, b.user_id);
  const finish = (cursor: Cursor | null) =>
    ctx.env.DB.prepare(
      `UPDATE s3_buckets SET lifecycle_cursor = ?2, lifecycle_at = CASE WHEN ?2 IS NULL THEN ?3 ELSE lifecycle_at END
       WHERE name = ?1 AND user_id = ?4`,
    )
      .bind(b.name, cursor ? JSON.stringify(cursor) : null, now, b.user_id)
      .run();
  if (!account || account.status !== 'active' || account.billingState === 'locked') {
    await finish(null);
    return { deleted: 0, aborted: 0 };
  }
  const db = await indexDb(ctx.env, account.indexBinding);
  let cursor: Cursor = b.lifecycle_cursor
    ? (JSON.parse(b.lifecycle_cursor) as Cursor)
    : { rule: 0, after: '' };

  // Forgotten multipart uploads: few, and gone once dropped, so no cursor (only at a pass's start).
  let aborted = 0;
  if (!b.lifecycle_cursor) {
    for (const r of rules) {
      if (!r.enabled || r.abortDays === undefined) continue;
      const { results } = await db
        .prepare(
          `SELECT * FROM s3_uploads WHERE user_id = ?1 AND bucket = ?2 AND key >= ?3 AND created_at < ?4
           ORDER BY key LIMIT 20`,
        )
        .bind(b.user_id, b.name, r.prefix, expiryCutoff(now, r.abortDays))
        .all<UploadRow>();
      for (const up of results.filter((u) => u.key.startsWith(r.prefix))) {
        await dropUpload(ctx, db, up);
        aborted++;
      }
    }
  }

  // One rule's objects, from the cursor on, a page at a time.
  while (cursor.rule < rules.length) {
    const rule = rules[cursor.rule]!;
    const expires =
      rule.enabled && (rule.expirationDays !== undefined || rule.expirationDate !== undefined);
    if (!expires || (rule.expirationDate !== undefined && now < rule.expirationDate)) {
      cursor = { rule: cursor.rule + 1, after: '' };
      continue;
    }
    const { results } = await db
      .prepare(
        `SELECT key, size, modified_at, tags_json FROM s3_objects
         WHERE bucket = ?1 AND user_id = ?2 AND key >= ?3 AND key > ?4 ORDER BY key LIMIT ?5`,
      )
      .bind(b.name, b.user_id, rule.prefix, cursor.after, scanRows)
      .all<{ key: string; size: number; modified_at: number; tags_json: string | null }>();
    const inPrefix = results.filter((o) => o.key.startsWith(rule.prefix));
    const due = inPrefix.filter((o) => ruleCovers(rule, o, now)).map((o) => o.key);
    if (due.length) await deleteObjects(ctx, account, b.name, due);
    const done = results.length < scanRows || inPrefix.length < results.length;
    const next: Cursor = done
      ? { rule: cursor.rule + 1, after: '' }
      : { rule: cursor.rule, after: results[results.length - 1]!.key };
    await finish(next.rule >= rules.length ? null : next);
    return { deleted: due.length, aborted };
  }
  await finish(null);
  return { deleted: 0, aborted };
}
