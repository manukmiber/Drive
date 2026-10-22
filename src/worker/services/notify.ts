// User notifications (SPEC §13.2): one row in `notifications` (in-app bell) + delivery via the
// `notify` queue to email and, when linked, Telegram. Message bodies are rendered at delivery time.
import { formatBytes, formatDateTime, formatRupiah } from '../../shared/format';
import type { Ctx } from '../context';
import { ulid } from '../lib/ids';
import { AppError } from '../lib/errors';
import { log } from '../lib/log';
import { noticeEmail } from './email-templates';

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
  | 'account_delete';

export function notificationStmt(
  ctx: Ctx,
  userId: string,
  type: NotificationType,
  payload: Record<string, unknown>,
) {
  const id = ulid(ctx.now());
  return {
    id,
    stmt: ctx.env.DB.prepare(
      'INSERT INTO notifications (id, user_id, type, payload_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5)',
    ).bind(id, userId, type, JSON.stringify(payload), ctx.now()),
  };
}

export async function notify(
  ctx: Ctx,
  userId: string,
  type: NotificationType,
  payload: Record<string, unknown>,
): Promise<string> {
  const { id, stmt } = notificationStmt(ctx, userId, type, payload);
  await stmt.run();
  await ctx.env.NOTIFY_QUEUE.send({ type: 'notification', notificationId: id });
  return id;
}

type Rendered = { title: string; paragraphs: string[]; cta?: { label: string; url: string } };

function render(ctx: Ctx, type: string, p: Record<string, unknown>): Rendered | null {
  const app = ctx.env.APP_ORIGIN;
  const billing = { label: 'Buka Paket & tagihan', url: `${app}/paket` };
  switch (type) {
    case 'file_rejected':
      return {
        title: 'File kamu ditolak pemindai keamanan',
        paragraphs: [
          `"${String(p.name)}" terdeteksi berbahaya (${String(p.reason ?? 'malware')}) sehingga sudah dihapus dan kuotanya dikembalikan.`,
        ],
      };
    case 'billing_reminder':
      return {
        title: `Paketmu diperpanjang ${p.days === 1 ? 'besok' : `${String(p.days)} hari lagi`}`,
        paragraphs: [
          `Paket ${String(p.planName)} akan diperpanjang otomatis pada ${formatDateTime(Number(p.periodEnd))} sebesar ${formatRupiah(Number(p.amountIdr))}.`,
          Number(p.balanceIdr) < Number(p.amountIdr)
            ? `Saldo Zeiko kamu ${formatRupiah(Number(p.balanceIdr))}, belum cukup. Isi saldo dulu supaya perpanjangan tidak gagal.`
            : 'Saldo Zeiko kamu cukup, tidak perlu melakukan apa-apa.',
        ],
        cta: billing,
      };
    case 'renewal_failed':
    case 'dunning': {
      const stage = String(p.stage ?? 'grace');
      const text: Record<string, string> = {
        grace: 'Pembayaran paketmu belum masuk. Semua fitur masih jalan normal untuk sementara.',
        readonly:
          'Akunmu sekarang mode baca saja: kamu tidak bisa upload atau membuat link share baru, dan link yang ada dinonaktifkan. Download dan hapus tetap bisa.',
        suspended:
          'Akses ke file kamu sekarang dikunci. Bayar kapan saja untuk memulihkan semuanya.',
        delete_warning:
          'File kamu akan dihapus permanen sebentar lagi kalau pembayaran belum masuk.',
      };
      return {
        title:
          stage === 'delete_warning'
            ? 'Peringatan terakhir: file akan dihapus'
            : 'Pembayaran paket belum masuk',
        paragraphs: [
          text[stage] ?? text.grace!,
          p.deleteAt ? `Batas akhir pembayaran: ${formatDateTime(Number(p.deleteAt))}.` : '',
        ].filter(Boolean),
        cta: billing,
      };
    }
    case 'quota': {
      const pct = Number(p.pct);
      return {
        title: pct >= 100 ? 'Penyimpanan kamu penuh' : `Penyimpanan terpakai ${pct}%`,
        paragraphs: [
          pct >= 100
            ? 'Kamu tidak bisa upload lagi sampai ada ruang kosong. Hapus file yang tidak perlu (jangan lupa kosongkan Sampah) atau tambah ruang.'
            : `Sudah terpakai ${formatBytes(Number(p.usedBytes))} dari ${formatBytes(Number(p.limitBytes))}.`,
        ],
        cta: { label: 'Tambah ruang', url: `${app}/paket` },
      };
    }
    case 'account_delete':
      return {
        title: 'Akun Zeiko kamu akan dihapus besok',
        paragraphs: [
          `Sesuai permintaanmu, akun dan semua file akan dihapus permanen pada ${formatDateTime(Number(p.deleteAt))}.`,
          'Berubah pikiran? Batalkan dari Pengaturan sebelum waktu itu.',
        ],
        cta: { label: 'Buka Pengaturan', url: `${app}/pengaturan` },
      };
    case 'compress_done': {
      const done = Number(p.done ?? 0);
      const skipped = Number(p.skipped ?? 0);
      const failed = Number(p.failed ?? 0);
      const parts = [`${done} berhasil`];
      if (skipped) parts.push(`${skipped} dilewati karena hasilnya tidak lebih kecil`);
      if (failed) parts.push(`${failed} gagal`);
      return {
        title: done
          ? `Kompres selesai, hemat ${formatBytes(Number(p.savedBytes ?? 0))}`
          : 'Kompres selesai',
        paragraphs: [
          `${parts.join(', ')}. Kredit untuk file yang dilewati atau gagal sudah dikembalikan.`,
        ],
        cta: { label: 'Lihat hasil', url: `${app}/kompres` },
      };
    }
    case 'payment_paid':
      return {
        title: 'Pembayaran berhasil',
        paragraphs: [`Saldo Zeiko bertambah ${formatRupiah(Number(p.amountIdr))}.`],
        cta: billing,
      };
    case 'invoice':
      return {
        title: `Invoice ${String(p.number)}`,
        paragraphs: [
          `Terima kasih! ${String(p.summary ?? '')} Total ${formatRupiah(Number(p.totalIdr))}.`,
        ],
        cta: { label: 'Lihat invoice', url: `${app}/paket/invoice/${String(p.invoiceId)}` },
      };
    case 'plan_changed':
      return {
        title: 'Paket kamu berubah',
        paragraphs: [
          `Paket sekarang: ${String(p.planName)} (${formatBytes(Number(p.storageBytes))}).`,
        ],
        cta: billing,
      };
    default:
      return null;
  }
}

export async function deliverNotification(ctx: Ctx, notificationId: string): Promise<void> {
  // Queue delivery is at-least-once: remember what was delivered.
  const marker = `nd:${notificationId}`;
  if (await ctx.env.CONFIG_KV.get(marker)) return;
  const row = await ctx.env.DB.prepare(
    `SELECT n.user_id, n.type, n.payload_json, u.email, t.chat_id FROM notifications n JOIN users u ON u.id = n.user_id
     LEFT JOIN telegram_links t ON t.user_id = n.user_id WHERE n.id = ?1`,
  )
    .bind(notificationId)
    .first<{
      user_id: string;
      type: string;
      payload_json: string;
      email: string;
      chat_id: string | null;
    }>();
  if (!row) return;
  const r = render(ctx, row.type, JSON.parse(row.payload_json) as Record<string, unknown>);
  if (!r) return;
  const prefs = await channelPrefs(ctx, notificationUser(row), row.type);
  if (prefs.email)
    await ctx.adapters.email.send({ to: [row.email], tag: row.type, ...noticeEmail(r) });
  if (row.chat_id && prefs.telegram) {
    try {
      await ctx.adapters.telegram.sendMessage(
        row.chat_id,
        `${r.title}\n\n${r.paragraphs.join('\n\n')}`,
        r.cta ? [{ text: r.cta.label, url: r.cta.url }] : undefined,
      );
    } catch (e) {
      log.warn('telegram_notify_failed', { error: String(e) });
    }
  }
  await ctx.env.CONFIG_KV.put(marker, '1', { expirationTtl: 7 * 86_400 });
}

const notificationUser = (row: { user_id: string }) => row.user_id;

/** Legal/billing notices can't be switched off by email (ADR-029). */
export const MANDATORY_EMAIL: readonly string[] = [
  'renewal_failed',
  'dunning',
  'invoice',
  'account_delete',
];
export const PREF_TYPES = [
  'file_rejected',
  'quota',
  'billing_reminder',
  'payment_paid',
  'invoice',
  'plan_changed',
  'family_invite',
  'archive_ready',
  'compress_done',
  'ad_status',
] as const;

async function channelPrefs(
  ctx: Ctx,
  userId: string,
  type: string,
): Promise<{ email: boolean; telegram: boolean }> {
  const { results } = await ctx.env.DB.prepare(
    'SELECT channel, enabled FROM notification_prefs WHERE user_id = ?1 AND type = ?2',
  )
    .bind(userId, type)
    .all<{ channel: string; enabled: number }>();
  const off = (ch: string) => results.some((r) => r.channel === ch && !r.enabled);
  return { email: MANDATORY_EMAIL.includes(type) || !off('email'), telegram: !off('telegram') };
}

export async function getPrefs(ctx: Ctx, userId: string) {
  const { results } = await ctx.env.DB.prepare(
    'SELECT type, channel, enabled FROM notification_prefs WHERE user_id = ?1',
  )
    .bind(userId)
    .all<{ type: string; channel: string; enabled: number }>();
  return PREF_TYPES.map((type) => ({
    type,
    email:
      MANDATORY_EMAIL.includes(type) ||
      !results.some((r) => r.type === type && r.channel === 'email' && !r.enabled),
    telegram: !results.some((r) => r.type === type && r.channel === 'telegram' && !r.enabled),
    emailLocked: MANDATORY_EMAIL.includes(type),
  }));
}

export async function setPref(
  ctx: Ctx,
  userId: string,
  type: string,
  channel: 'email' | 'telegram',
  enabled: boolean,
): Promise<void> {
  if (!(PREF_TYPES as readonly string[]).includes(type))
    throw new AppError('VALIDATION', 'unknown notification type');
  if (channel === 'email' && MANDATORY_EMAIL.includes(type) && !enabled)
    throw new AppError('BAD_REQUEST', 'this notice is mandatory');
  await ctx.env.DB.prepare(
    `INSERT INTO notification_prefs (user_id, type, channel, enabled) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (user_id, type, channel) DO UPDATE SET enabled = excluded.enabled`,
  )
    .bind(userId, type, channel, enabled ? 1 : 0)
    .run();
}

export async function listNotifications(ctx: Ctx, userId: string) {
  const [{ results }, unread] = await Promise.all([
    ctx.env.DB.prepare(
      `SELECT id, type, payload_json AS payload, read_at AS readAt, created_at AS createdAt FROM notifications
       WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 50`,
    )
      .bind(userId)
      .all<{
        id: string;
        type: string;
        payload: string;
        readAt: number | null;
        createdAt: number;
      }>(),
    ctx.env.DB.prepare(
      'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?1 AND read_at IS NULL',
    )
      .bind(userId)
      .first<{ n: number }>(),
  ]);
  return {
    unread: unread?.n ?? 0,
    items: results.map((n) => {
      const r = render(ctx, n.type, JSON.parse(n.payload) as Record<string, unknown>);
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
  if (ids === 'all') {
    await ctx.env.DB.prepare(
      'UPDATE notifications SET read_at = ?2 WHERE user_id = ?1 AND read_at IS NULL',
    )
      .bind(userId, ctx.now())
      .run();
    return;
  }
  for (const id of ids.slice(0, 100)) {
    await ctx.env.DB.prepare(
      'UPDATE notifications SET read_at = ?3 WHERE id = ?1 AND user_id = ?2 AND read_at IS NULL',
    )
      .bind(id, userId, ctx.now())
      .run();
  }
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
