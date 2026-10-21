// User notifications (SPEC §13.2): one row in `notifications` (in-app bell) + delivery via the
// `notify` queue to email and, when linked, Telegram. Message bodies are rendered at delivery time.
import { formatBytes, formatDateTime, formatRupiah } from '../../shared/format';
import type { Ctx } from '../context';
import { ulid } from '../lib/ids';
import { log } from '../lib/log';
import { noticeEmail } from './email-templates';

export type NotificationType =
  | 'file_rejected'
  | 'billing_reminder'
  | 'renewal_failed'
  | 'dunning'
  | 'payment_paid'
  | 'invoice'
  | 'plan_changed'
  | 'family_invite';

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
    `SELECT n.type, n.payload_json, u.email, t.chat_id FROM notifications n JOIN users u ON u.id = n.user_id
     LEFT JOIN telegram_links t ON t.user_id = n.user_id WHERE n.id = ?1`,
  )
    .bind(notificationId)
    .first<{ type: string; payload_json: string; email: string; chat_id: string | null }>();
  if (!row) return;
  const r = render(ctx, row.type, JSON.parse(row.payload_json) as Record<string, unknown>);
  if (!r) return;
  await ctx.adapters.email.send({ to: [row.email], tag: row.type, ...noticeEmail(r) });
  if (row.chat_id) {
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
