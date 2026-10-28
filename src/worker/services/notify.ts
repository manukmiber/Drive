// User notifications (SPEC §13.2): the in-app bell plus email, the only channel out of the app
// (ADR-041). Since ADR-064 the relay keeps them (adapters/notices.ts): `notify` queues the notice
// with its content, and the notify consumer files it with the relay (once per id), then mails it
// unless the person switched that kind off. Words are rendered here, at delivery and in the bell.
import { formatBytes, formatDateTime, formatRupiah } from '../../shared/format';
import { AD_CONTACT } from '../../shared/constants';
import type { Ctx } from '../context';
import { ulid } from '../lib/ids';
import { AppError } from '../lib/errors';
import { noticeEmail } from './email-templates';
import { appUrl } from '../lib/paths';
import { strings, type Lang } from '../lib/lang';

export type NotificationType =
  | 'file_rejected'
  | 'quota'
  | 'archive_ready'
  | 'compress_done'
  | 'ad_status'
  | 'billing_reminder'
  | 'renewal_failed'
  | 'dunning'
  | 'payment_paid'
  | 'invoice'
  | 'plan_changed'
  | 'family_invite'
  | 'account_delete'
  | 's3_reminder'
  | 's3_dunning'
  | 's3_url_released';

/** Queue a notice. It reaches the bell once the relay has it (the queue retries until then). */
export async function notify(
  ctx: Ctx,
  userId: string,
  type: NotificationType,
  payload: Record<string, unknown>,
): Promise<string> {
  const id = ulid(ctx.now());
  await ctx.env.NOTIFY_QUEUE.send({
    type: 'notice',
    id,
    userId,
    kind: type,
    payload,
    createdAt: ctx.now(),
  });
  return id;
}

type Rendered = {
  title: string;
  paragraphs: string[];
  cta?: { label: string; url: string };
  image?: { src: string; alt: string };
};

/** A notice's words in one language (D14): the email and the bell draw from the same text. */
export function renderNotice(
  ctx: Ctx,
  lang: Lang,
  type: string,
  p: Record<string, unknown>,
): Rendered | null {
  const m = strings(lang).mail;
  const app = appUrl(ctx.env, '');
  const billing = { label: m.ctaPlans, url: `${app}/paket` };
  switch (type) {
    case 'file_rejected':
      return {
        title: m.rejectedTitle,
        paragraphs: [m.rejectedBody(String(p.name), String(p.reason ?? 'malware'))],
      };
    case 'billing_reminder':
      return {
        title: m.planEndsTitle(Number(p.days)),
        paragraphs: [
          m.planEndsOn(String(p.planName), formatDateTime(Number(p.periodEnd))),
          Number(p.creditIdr ?? 0) >= Number(p.amountIdr)
            ? m.creditRenews
            : m.renewByQris(formatRupiah(Number(p.amountIdr))),
        ],
        cta: { label: m.ctaRenewPlan, url: `${app}/paket` },
      };
    case 'renewal_failed':
    case 'dunning': {
      const stage = String(p.stage ?? 'grace');
      const text: Record<string, string> = {
        grace: m.dunningGrace,
        readonly: m.dunningReadonly,
        suspended: m.dunningSuspended,
        delete_warning: m.dunningDeleteWarning,
      };
      return {
        title: stage === 'delete_warning' ? m.dunningLastTitle : m.dunningTitle,
        paragraphs: [
          text[stage] ?? text.grace!,
          p.deleteAt ? m.payBy(formatDateTime(Number(p.deleteAt))) : '',
        ].filter(Boolean),
        cta: { label: m.ctaRenewPlan, url: `${app}/paket` },
      };
    }
    case 's3_reminder':
      return {
        title: m.s3EndsTitle(Number(p.days)),
        paragraphs: [
          m.s3EndsOn(formatDateTime(Number(p.periodEnd))),
          p.creditCovers ? m.creditRenews : m.s3RenewByQris(formatRupiah(Number(p.amountIdr))),
        ],
        cta: { label: m.ctaRenew, url: `${app}/s3` },
      };
    case 's3_url_released':
      return {
        title: m.s3UrlReleasedTitle,
        paragraphs: [m.s3UrlReleasedBody(String(p.hostname))],
        cta: { label: m.ctaOpenS3, url: `${app}/s3` },
      };
    case 's3_dunning': {
      const stage = String(p.stage ?? 'grace');
      const text: Record<string, string> = {
        grace: m.s3DunningGrace,
        readonly: m.s3DunningReadonly,
        locked: m.s3DunningLocked,
        delete_warning: m.s3DunningDeleteWarning,
      };
      return {
        title: stage === 'delete_warning' ? m.s3DunningLastTitle : m.s3DunningTitle,
        paragraphs: [text[stage] ?? text.grace!, m.s3DeleteBy(formatDateTime(Number(p.deleteAt)))],
        cta: { label: m.ctaRenew, url: `${app}/s3` },
      };
    }
    case 'quota': {
      const pct = Number(p.pct);
      return {
        title: pct >= 100 ? m.quotaFullTitle : m.quotaTitle(pct),
        paragraphs: [
          pct >= 100
            ? m.quotaFullBody
            : m.quotaBody(formatBytes(Number(p.usedBytes)), formatBytes(Number(p.limitBytes))),
        ],
        cta: { label: m.ctaAddSpace, url: `${app}/paket` },
      };
    }
    case 'account_delete':
      return {
        title: m.deleteTitle,
        paragraphs: [m.deleteBody(formatDateTime(Number(p.deleteAt))), m.deleteUndo],
        cta: { label: m.ctaSettings, url: `${app}/pengaturan` },
      };
    case 'archive_ready':
      return {
        title: m.archiveTitle,
        paragraphs: [m.archiveBody(String(p.name), formatBytes(Number(p.bytes)))],
        cta: { label: m.ctaDownloads, url: `${app}/unduhan` },
      };
    case 'ad_status': {
      const status = String(p.status);
      const title = String(p.title);
      const titles: Record<string, string> = {
        approved: m.adApproved(title),
        awaiting_payment: m.adAwaiting(title),
        paid: m.adPaid(title),
        rejected: m.adRejected(title),
        suspended: m.adSuspended(title),
      };
      // Paying is by email (ADR-043): the QRIS is in this message, nothing to open on the website.
      if (status === 'awaiting_payment') {
        const amount = formatRupiah(Number(p.amountIdr));
        const qr = typeof p.qrUrl === 'string' ? p.qrUrl : null;
        const payUrl = typeof p.payUrl === 'string' ? p.payUrl : null;
        return {
          title: titles.awaiting_payment!,
          paragraphs: qr
            ? [
                m.adPayQr(amount, String(p.startDate)),
                m.adPayCode,
                ...(Number(p.creditUsedIdr) > 0
                  ? [m.adCreditUsed(formatRupiah(Number(p.creditUsedIdr)))]
                  : []),
                m.adPayLapse,
              ]
            : [m.adPayLater(amount), m.adQuestions(AD_CONTACT)],
          ...(qr ? { image: { src: qr, alt: `QRIS ${amount}` } } : {}),
          ...(payUrl && !qr ? { cta: { label: m.ctaPay, url: payUrl } } : {}),
        };
      }
      const paragraphs =
        status === 'paid'
          ? [m.adPaidBody]
          : status === 'approved'
            ? [m.adApprovedBody]
            : [
                m.adReason(String(p.reason || m.adDefaultReason)),
                Number(p.refundedIdr) > 0
                  ? m.adRefund(formatRupiah(Number(p.refundedIdr)))
                  : status === 'rejected'
                    ? m.adResend(AD_CONTACT)
                    : m.adNoRefund,
              ];
      return {
        title: titles[status] ?? m.adChanged,
        paragraphs,
        cta: { label: m.ctaAdStats, url: `${app}/iklan` },
      };
    }
    case 'compress_done': {
      const done = Number(p.done ?? 0);
      const skipped = Number(p.skipped ?? 0);
      const failed = Number(p.failed ?? 0);
      const parts = [m.compressDone(done)];
      if (skipped) parts.push(m.compressSkipped(skipped));
      if (failed) parts.push(m.compressFailed(failed));
      return {
        title: done ? m.compressTitleSaved(formatBytes(Number(p.savedBytes ?? 0))) : m.compressTitle,
        paragraphs: [m.compressBody(parts.join(', '))],
        cta: { label: m.ctaResults, url: `${app}/kompres` },
      };
    }
    case 'payment_paid':
      return {
        title: m.paidTitle,
        paragraphs: [
          m.paidThanks(formatRupiah(Number(p.amountIdr))),
          p.failed ? m.paidFailed : String(p.summary ?? ''),
          !p.failed && Number(p.creditIdr ?? 0) > 0
            ? m.paidCredit(formatRupiah(Number(p.creditIdr)))
            : '',
        ].filter(Boolean),
        cta: billing,
      };
    case 'invoice':
      // Sent before ADR-041; invoices are not shown any more.
      return {
        title: m.paidTitle,
        paragraphs: [m.invoiceBody(String(p.summary ?? ''), formatRupiah(Number(p.totalIdr)))],
        cta: billing,
      };
    case 'plan_changed':
      return {
        title: m.planChangedTitle,
        paragraphs: [m.planNow(String(p.planName), formatBytes(Number(p.storageBytes)))],
        cta: billing,
      };
    default:
      return null;
  }
}

export async function deliverNotice(
  ctx: Ctx,
  n: {
    id: string;
    userId: string;
    kind: string;
    payload: Record<string, unknown>;
    createdAt: number;
  },
): Promise<void> {
  const { emailOff } = await ctx.adapters.notices.add({
    id: n.id,
    userId: n.userId,
    type: n.kind,
    payload: n.payload,
    createdAt: n.createdAt,
  });
  // Queue delivery is at-least-once: remember what was mailed.
  const marker = `nd:${n.id}`;
  if (await ctx.env.CONFIG_KV.get(marker)) return;
  const user = await ctx.env.DB.prepare('SELECT email, locale FROM users WHERE id = ?1')
    .bind(n.userId)
    .first<{ email: string; locale: Lang }>();
  const lang = user?.locale ?? 'id';
  const r = renderNotice(ctx, lang, n.kind, n.payload);
  if (r && user && (MANDATORY_EMAIL.includes(n.kind) || !emailOff))
    await ctx.adapters.email.send({ to: [user.email], tag: n.kind, ...noticeEmail(lang, r) });
  await ctx.env.CONFIG_KV.put(marker, '1', { expirationTtl: 7 * 86_400 });
}

/** A message queued before ADR-064 points at a row of the old table; deliver it the new way. */
export async function deliverLegacyNotification(ctx: Ctx, notificationId: string): Promise<void> {
  const row = await ctx.env.DB.prepare(
    'SELECT user_id, type, payload_json, created_at FROM notifications WHERE id = ?1',
  )
    .bind(notificationId)
    .first<{ user_id: string; type: string; payload_json: string; created_at: number }>();
  if (!row) return;
  await deliverNotice(ctx, {
    id: notificationId,
    userId: row.user_id,
    kind: row.type,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    createdAt: row.created_at,
  });
  await ctx.env.DB.prepare('DELETE FROM notifications WHERE id = ?1').bind(notificationId).run();
}

/**
 * Legal/billing notices can't be switched off by email (ADR-029). Since ADR-041 that includes the
 * renewal reminder (nothing renews by itself) and the receipt (it replaces the invoice).
 */
export const MANDATORY_EMAIL: readonly string[] = [
  'billing_reminder',
  'payment_paid',
  'renewal_failed',
  'dunning',
  'account_delete',
  's3_reminder',
  's3_dunning',
  's3_url_released',
];
export const PREF_TYPES = [
  'file_rejected',
  'quota',
  'billing_reminder',
  'payment_paid',
  'plan_changed',
  'family_invite',
  'archive_ready',
  'compress_done',
  'ad_status',
] as const;

export async function getPrefs(ctx: Ctx, userId: string) {
  const results = await ctx.adapters.notices.prefs(userId);
  return PREF_TYPES.map((type) => ({
    type,
    email:
      MANDATORY_EMAIL.includes(type) ||
      !results.some((r) => r.type === type && r.channel === 'email' && !r.enabled),
    emailLocked: MANDATORY_EMAIL.includes(type),
  }));
}

export async function setPref(
  ctx: Ctx,
  userId: string,
  type: string,
  channel: 'email',
  enabled: boolean,
): Promise<void> {
  if (!(PREF_TYPES as readonly string[]).includes(type))
    throw new AppError('VALIDATION', 'unknown notification type');
  if (MANDATORY_EMAIL.includes(type) && !enabled)
    throw new AppError('BAD_REQUEST', 'this notice is mandatory');
  await ctx.adapters.notices.setPref(userId, { type, channel, enabled });
}

/** The bell, in the language the app is shown in. */
export async function listNotifications(ctx: Ctx, userId: string, lang: Lang = 'id') {
  const { unread, items } = await ctx.adapters.notices.list(userId, 50);
  return {
    unread,
    items: items.map((n) => {
      const r = renderNotice(ctx, lang, n.type, n.payload);
      return {
        id: n.id,
        type: n.type,
        title: r?.title ?? n.type,
        body: r?.paragraphs[0] ?? '',
        url: r?.cta?.url ?? null,
        readAt: n.readAt,
        createdAt: n.createdAt,
      };
    }),
  };
}

export async function markRead(ctx: Ctx, userId: string, ids: string[] | 'all'): Promise<void> {
  await ctx.adapters.notices.markRead(userId, ids === 'all' ? 'all' : ids.slice(0, 100));
}

/** Quota 80 / 95 / 100 % notices to whoever pays for the pool, once per threshold and limit. */
export async function checkQuotaThresholds(ctx: Ctx, poolId: string): Promise<void> {
  const pool = await ctx.env.DB.prepare(
    `SELECT sp.limit_bytes, sp.used_bytes, sp.owner_type, sp.owner_id, f.owner_id AS family_owner
     FROM storage_pools sp LEFT JOIN families f ON sp.owner_type = 'family' AND f.id = sp.owner_id WHERE sp.id = ?1`,
  )
    .bind(poolId)
    .first<{
      limit_bytes: number;
      used_bytes: number;
      owner_type: string;
      owner_id: string;
      family_owner: string | null;
    }>();
  if (!pool || pool.limit_bytes <= 0) return;
  const userId = pool.owner_type === 'user' ? pool.owner_id : pool.family_owner;
  if (!userId) return;
  const ratio = pool.used_bytes / pool.limit_bytes;
  const hit = [100, 95, 80].find((t) => ratio * 100 >= t);
  if (!hit) return;
  const key = `quota:${poolId}:${pool.limit_bytes}:${hit}`;
  const res = await ctx.env.DB.prepare(
    'INSERT INTO usage_counters (key, count, window_start, expires_at) VALUES (?1, 1, ?2, ?3) ON CONFLICT (key) DO NOTHING',
  )
    .bind(key, ctx.now(), ctx.now() + 60 * 86_400_000)
    .run();
  if (res.meta.changes !== 1) return;
  await notify(ctx, userId, 'quota', {
    pct: hit,
    usedBytes: pool.used_bytes,
    limitBytes: pool.limit_bytes,
  });
}

/**
 * ADR-064: brings the rows of Drive's old D1 tables over to the relay, a batch per call, and
 * deletes what arrived. Once they are empty this is three cheap reads; the tables go in R8.
 */
export async function moveNoticesToRelay(ctx: Ctx, batch = 100): Promise<number> {
  const DB = ctx.env.DB;
  const [notes, prefs, sups] = await Promise.all([
    DB.prepare(
      'SELECT id, user_id, type, payload_json, read_at, created_at FROM notifications ORDER BY created_at LIMIT ?1',
    )
      .bind(batch)
      .all<{
        id: string;
        user_id: string;
        type: string;
        payload_json: string;
        read_at: number | null;
        created_at: number;
      }>(),
    DB.prepare('SELECT user_id, type, channel, enabled FROM notification_prefs LIMIT ?1')
      .bind(batch)
      .all<{ user_id: string; type: string; channel: string; enabled: number }>(),
    DB.prepare('SELECT email_hash, reason, created_at FROM email_suppressions LIMIT ?1')
      .bind(batch)
      .all<{ email_hash: string; reason: string; created_at: number }>(),
  ]);
  const total = notes.results.length + prefs.results.length + sups.results.length;
  if (!total) return 0;
  await ctx.adapters.notices.import({
    notices: notes.results.map((n) => ({
      id: n.id,
      userId: n.user_id,
      type: n.type,
      payload: JSON.parse(n.payload_json) as Record<string, unknown>,
      createdAt: n.created_at,
      readAt: n.read_at,
    })),
    prefs: prefs.results.map((p) => ({
      userId: p.user_id,
      type: p.type,
      channel: p.channel,
      enabled: p.enabled === 1,
    })),
    suppressions: sups.results.map((s) => ({
      emailHash: s.email_hash,
      reason: s.reason,
      createdAt: s.created_at,
    })),
  });
  // Three statements whatever the batch (Workers Free counts D1 queries per invocation).
  await DB.batch([
    DB.prepare('DELETE FROM notifications WHERE id IN (SELECT value FROM json_each(?1))').bind(
      JSON.stringify(notes.results.map((n) => n.id)),
    ),
    DB.prepare(
      `DELETE FROM notification_prefs WHERE user_id || '|' || type || '|' || channel IN (SELECT value FROM json_each(?1))`,
    ).bind(JSON.stringify(prefs.results.map((p) => `${p.user_id}|${p.type}|${p.channel}`))),
    DB.prepare(
      'DELETE FROM email_suppressions WHERE email_hash IN (SELECT value FROM json_each(?1))',
    ).bind(JSON.stringify(sups.results.map((s) => s.email_hash))),
  ]);
  return total;
}
