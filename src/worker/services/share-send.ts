// Sending share links: deeplinks (WhatsApp/Telegram/QR/copy/Web Share, logged only), email via the
// `notify` queue, and direct Telegram messages for linked users (SPEC §6.3–6.8).
import { formatBytes, formatDateTime } from '../../shared/format';
import type { ShareChannel, ShareSendMode } from '../../shared/enums';
import { DAY_MS, MINUTE_MS } from '../../shared/constants';
import { wibDate } from '../../shared/time';
import type { Ctx } from '../context';
import {
  hmacBase62,
  sha256Hex,
  base64UrlEncode,
  base64UrlDecode,
  timingSafeEqual,
} from '../lib/crypto';
import { AppError } from '../lib/errors';
import { verifyTurnstile } from '../lib/turnstile';
import { randomBase62, ulid } from '../lib/ids';
import { shareEmail } from './email-templates';
import { requireOwnShare, shareState, shareUrl } from './shares';

const SPAM =
  /\b(slot|gacor|togel|judi|casino|maxwin|pinjol|deposit\s+pulsa|bit\.ly|tinyurl|verifikasi\s+akun|password\s+anda)\b/i;

export function maskRecipient(channel: ShareChannel, value: string): string {
  if (channel === 'email') {
    const [user = '', domain = ''] = value.split('@');
    return `${user.slice(0, 2)}***@${domain}`;
  }
  if (channel === 'whatsapp') return `${value.slice(0, 4)}****${value.slice(-3)}`;
  return value.length > 3 ? `${value.slice(0, 2)}***` : '***';
}

/** 08xx / +62 / 62 → 62xxx; returns null when it isn't a plausible Indonesian mobile number. */
export function normalizeIdPhone(input: string): string | null {
  let d = input.replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  if (d.startsWith('0')) d = `62${d.slice(1)}`;
  if (!d.startsWith('62')) return null;
  return /^628\d{7,12}$/.test(d) ? d : null;
}

async function recipientHash(ctx: Ctx, value: string): Promise<string> {
  return (await hmacBase62(ctx.env.IP_HASH_SECRET, `rcpt|${value.toLowerCase()}`)).slice(0, 32);
}

async function insertSend(
  ctx: Ctx,
  p: {
    shareId: string;
    userId: string;
    channel: ShareChannel;
    mode: ShareSendMode;
    recipient: string | null;
    message: string | null;
    status: string;
  },
): Promise<string> {
  const id = ulid(ctx.now());
  await ctx.env.DB.prepare(
    `INSERT INTO share_sends (id, share_id, user_id, channel, mode, recipient_masked, recipient_hash, message, status, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  )
    .bind(
      id,
      p.shareId,
      p.userId,
      p.channel,
      p.mode,
      p.recipient ? maskRecipient(p.channel, p.recipient) : null,
      p.recipient ? await recipientHash(ctx, p.recipient) : null,
      p.message,
      p.status,
      ctx.now(),
    )
    .run();
  return id;
}

/** Long-window limit counter in D1 (ADR-004). Returns false when the limit is exhausted. */
export async function consumeUsage(
  ctx: Ctx,
  key: string,
  amount: number,
  limit: number,
  windowMs: number,
): Promise<boolean> {
  const now = ctx.now();
  await ctx.env.DB.prepare(
    `INSERT INTO usage_counters (key, count, window_start, expires_at) VALUES (?1, 0, ?2, ?3) ON CONFLICT (key) DO NOTHING`,
  )
    .bind(key, now, now + windowMs)
    .run();
  const res = await ctx.env.DB.prepare(
    `UPDATE usage_counters SET count = count + ?2 WHERE key = ?1 AND count + ?2 <= ?3`,
  )
    .bind(key, amount, limit)
    .run();
  return res.meta.changes === 1;
}

export async function logDeeplinkSend(
  ctx: Ctx,
  userId: string,
  shareId: string,
  input: {
    channel: ShareChannel;
    recipient?: string | null | undefined;
    message?: string | null | undefined;
  },
): Promise<{ sendId: string; recipient: string | null }> {
  await requireOwnShare(ctx, userId, shareId);
  let recipient = input.recipient?.trim() || null;
  if (input.channel === 'whatsapp' && recipient) {
    recipient = normalizeIdPhone(recipient);
    if (!recipient)
      throw new AppError('VALIDATION', 'invalid phone number', { field: 'recipient' });
  }
  const cfg = await ctx.config();
  const message = input.message ? input.message.slice(0, cfg.share_message_max_chars) : null;
  const sendId = await insertSend(ctx, {
    shareId,
    userId,
    channel: input.channel,
    mode: 'deeplink',
    recipient,
    message,
    status: 'opened',
  });
  return { sendId, recipient };
}

export async function sendShareEmail(
  ctx: Ctx,
  user: { id: string },
  shareId: string,
  input: {
    recipients: string[];
    message?: string | null | undefined;
    turnstileToken?: string | null | undefined;
  },
  ip: string,
): Promise<{ queued: number; suppressed: number }> {
  const cfg = await ctx.config();
  if (!cfg.features.email_share) throw new AppError('FORBIDDEN', 'email sharing is disabled');
  const share = await requireOwnShare(ctx, user.id, shareId);
  if (await shareState(ctx, share)) throw new AppError('CONFLICT', 'share link is not active');
  const recipients = [...new Set(input.recipients.map((r) => r.trim().toLowerCase()))].filter(
    Boolean,
  );
  if (!recipients.length || recipients.length > cfg.share_email_max_recipients) {
    throw new AppError('VALIDATION', 'too many recipients', {
      max: cfg.share_email_max_recipients,
    });
  }
  if (recipients.some((r) => !/^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(r)))
    throw new AppError('VALIDATION', 'invalid email');
  const message = input.message?.slice(0, cfg.share_message_max_chars) ?? null;
  if (message && SPAM.test(message))
    throw new AppError('VALIDATION', 'message looks like spam', { reason: 'SPAM' });
  await verifyTurnstile(ctx, input.turnstileToken, ip);
  const quotaKey = `share_email:${user.id}:${wibDate(ctx.now())}`;
  if (
    !(await consumeUsage(ctx, quotaKey, recipients.length, cfg.share_email_daily_limit, DAY_MS))
  ) {
    throw new AppError('RATE_LIMITED', 'daily email limit reached', {
      limit: cfg.share_email_daily_limit,
    });
  }
  let queued = 0;
  let suppressed = 0;
  for (const to of recipients) {
    const hash = await sha256Hex(`email|${to}`);
    const blocked = await ctx.env.DB.prepare(
      'SELECT 1 AS b FROM email_suppressions WHERE email_hash = ?1',
    )
      .bind(hash)
      .first();
    const sendId = await insertSend(ctx, {
      shareId,
      userId: user.id,
      channel: 'email',
      mode: 'api',
      recipient: to,
      message,
      status: blocked ? 'suppressed' : 'queued',
    });
    if (blocked) {
      suppressed++;
      continue;
    }
    await ctx.env.NOTIFY_QUEUE.send({ type: 'share_email', sendId, to });
    queued++;
  }
  return { queued, suppressed };
}

export async function sendShareTelegram(
  ctx: Ctx,
  user: { id: string },
  shareId: string,
  input: { username: string; message?: string | null | undefined },
): Promise<{ sent: boolean }> {
  const cfg = await ctx.config();
  if (!cfg.features.telegram_bot) throw new AppError('FORBIDDEN', 'telegram bot is disabled');
  const share = await requireOwnShare(ctx, user.id, shareId);
  if (await shareState(ctx, share)) throw new AppError('CONFLICT', 'share link is not active');
  const username = input.username.trim().replace(/^@/, '').toLowerCase();
  const link = await ctx.env.DB.prepare(
    'SELECT chat_id, allow_receive FROM telegram_links WHERE username_lower = ?1',
  )
    .bind(username)
    .first<{ chat_id: string; allow_receive: number }>();
  if (!link || !link.allow_receive)
    throw new AppError('NOT_FOUND', 'telegram user not linked', { reason: 'TELEGRAM_NOT_LINKED' });
  if (!(await consumeUsage(ctx, `share_tg:${user.id}:${wibDate(ctx.now())}`, 1, 50, DAY_MS))) {
    throw new AppError('RATE_LIMITED', 'daily telegram limit reached');
  }
  const message = input.message?.slice(0, cfg.share_message_max_chars) ?? null;
  const sendId = await insertSend(ctx, {
    shareId,
    userId: user.id,
    channel: 'telegram',
    mode: 'bot',
    recipient: username,
    message,
    status: 'queued',
  });
  await ctx.env.NOTIFY_QUEUE.send({ type: 'share_telegram', sendId, chatId: link.chat_id });
  return { sent: true };
}

// ── delivery (notify queue consumer) ──
interface SendRow {
  id: string;
  share_id: string;
  user_id: string;
  message: string | null;
  status: string;
}

async function loadSendContext(ctx: Ctx, sendId: string) {
  const send = await ctx.env.DB.prepare('SELECT * FROM share_sends WHERE id = ?1')
    .bind(sendId)
    .first<SendRow>();
  if (!send || send.status !== 'queued') return null;
  const share = await ctx.env.DB.prepare('SELECT * FROM shares WHERE id = ?1')
    .bind(send.share_id)
    .first<{ id: string; title: string; expires_at: number | null }>();
  const sender = await ctx.env.DB.prepare('SELECT name, email FROM users WHERE id = ?1')
    .bind(send.user_id)
    .first<{ name: string; email: string }>();
  const size = await ctx.env.DB.prepare(
    'SELECT COALESCE(SUM(n.size), 0) AS total FROM share_items i JOIN nodes n ON n.id = i.node_id WHERE i.share_id = ?1',
  )
    .bind(send.share_id)
    .first<{ total: number }>();
  if (!share || !sender) return null;
  return {
    send,
    share,
    sender,
    sizeText: formatBytes(size?.total ?? 0),
    url: await shareUrl(ctx.env, share.id, share.title),
  };
}

async function markSend(ctx: Ctx, id: string, status: string, ref: string | null): Promise<void> {
  await ctx.env.DB.prepare('UPDATE share_sends SET status = ?2, provider_ref = ?3 WHERE id = ?1')
    .bind(id, status, ref)
    .run();
}

export async function unsubscribeToken(ctx: Ctx, email: string): Promise<string> {
  const e = base64UrlEncode(new TextEncoder().encode(email.toLowerCase()));
  return `${e}.${await hmacBase62(ctx.env.DOWNLOAD_SECRET, `unsub|${email.toLowerCase()}`, 22)}`;
}

export async function verifyUnsubscribeToken(ctx: Ctx, token: string): Promise<string | null> {
  const [e, sig] = token.split('.');
  if (!e || !sig) return null;
  let email: string;
  try {
    email = new TextDecoder().decode(base64UrlDecode(e));
  } catch {
    return null;
  }
  const expected = await hmacBase62(ctx.env.DOWNLOAD_SECRET, `unsub|${email}`, 22);
  return timingSafeEqual(sig, expected) ? email : null;
}

export async function deliverShareEmail(ctx: Ctx, sendId: string, to: string): Promise<void> {
  const c = await loadSendContext(ctx, sendId);
  if (!c) return;
  const unsub = `${ctx.env.APP_ORIGIN}/berhenti/${await unsubscribeToken(ctx, to)}`;
  const mail = shareEmail({
    senderName: c.sender.name || c.sender.email,
    senderEmail: c.sender.email,
    title: c.share.title,
    url: c.url,
    sizeText: c.sizeText,
    expiresText: c.share.expires_at ? formatDateTime(c.share.expires_at) : null,
    message: c.send.message,
    unsubscribeUrl: unsub,
    reportUrl: `${ctx.env.APP_ORIGIN}/lapor?share=${c.share.id}`,
  });
  const res = await ctx.adapters.email.send({
    to: [to],
    tag: 'share',
    replyTo: c.sender.email,
    headers: {
      'List-Unsubscribe': `<${unsub}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
    ...mail,
  });
  await markSend(ctx, sendId, 'sent', res.id);
}

export async function deliverShareTelegram(
  ctx: Ctx,
  sendId: string,
  chatId: string,
): Promise<void> {
  const c = await loadSendContext(ctx, sendId);
  if (!c) return;
  const text = `${c.sender.name || 'Seseorang'} membagikan "${c.share.title}" (${c.sizeText}) lewat Zeiko.${c.send.message ? `\n\n${c.send.message}` : ''}`;
  const res = await ctx.adapters.telegram.sendMessage(chatId, text, [
    { text: 'Unduh', url: c.url },
  ]);
  await markSend(ctx, sendId, 'sent', res.messageId);
}

// ── Telegram account linking (SPEC §6.4) ──
export async function telegramLinkUrl(
  ctx: Ctx,
  userId: string,
): Promise<{ url: string; expiresAt: number }> {
  const code = randomBase62(24);
  await ctx.env.CONFIG_KV.put(`tglink:${code}`, userId, { expirationTtl: 15 * 60 });
  const bot = ctx.env.TELEGRAM_BOT_USERNAME ?? 'ZeikoBot';
  return { url: `https://t.me/${bot}?start=${code}`, expiresAt: ctx.now() + 15 * MINUTE_MS };
}

interface TgUpdate {
  message?: { chat: { id: number }; from?: { id: number; username?: string }; text?: string };
}

export async function handleTelegramUpdate(ctx: Ctx, update: TgUpdate): Promise<void> {
  const msg = update.message;
  if (!msg?.from) return;
  const tgId = String(msg.from.id);
  const chatId = String(msg.chat.id);
  const username = msg.from.username?.toLowerCase() ?? null;
  const now = ctx.now();
  // Usernames can change; refresh on every interaction.
  await ctx.env.DB.prepare(
    'UPDATE telegram_links SET username_lower = ?2, chat_id = ?3, updated_at = ?4 WHERE tg_user_id = ?1',
  )
    .bind(tgId, username, chatId, now)
    .run();
  const text = msg.text?.trim() ?? '';
  const start = /^\/start(?:\s+([0-9A-Za-z]{24}))?$/.exec(text);
  if (start?.[1]) {
    const userId = await ctx.env.CONFIG_KV.get(`tglink:${start[1]}`);
    if (!userId) {
      await ctx.adapters.telegram.sendMessage(
        chatId,
        'Kode tautan sudah kedaluwarsa. Buat kode baru dari Pengaturan Zeiko.',
      );
      return;
    }
    await ctx.env.CONFIG_KV.delete(`tglink:${start[1]}`);
    await ctx.env.DB.batch([
      ctx.env.DB.prepare('DELETE FROM telegram_links WHERE tg_user_id = ?1 AND user_id != ?2').bind(
        tgId,
        userId,
      ),
      ctx.env.DB.prepare(
        `INSERT INTO telegram_links (user_id, tg_user_id, chat_id, username_lower, allow_receive, linked_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)
         ON CONFLICT (user_id) DO UPDATE SET tg_user_id = excluded.tg_user_id, chat_id = excluded.chat_id,
           username_lower = excluded.username_lower, allow_receive = 1, updated_at = excluded.updated_at`,
      ).bind(userId, tgId, chatId, username, now),
    ]);
    await ctx.adapters.telegram.sendMessage(
      chatId,
      'Akun Zeiko kamu sudah tertaut. Kamu akan menerima notifikasi dan file di sini. Ketik /stop untuk berhenti menerima file.',
    );
  } else if (text === '/stop') {
    await ctx.env.DB.prepare('UPDATE telegram_links SET allow_receive = 0 WHERE tg_user_id = ?1')
      .bind(tgId)
      .run();
    await ctx.adapters.telegram.sendMessage(
      chatId,
      'Oke, kamu tidak akan menerima file dari pengguna lain lagi. Ketik /terima untuk mengaktifkan.',
    );
  } else if (text === '/terima') {
    await ctx.env.DB.prepare('UPDATE telegram_links SET allow_receive = 1 WHERE tg_user_id = ?1')
      .bind(tgId)
      .run();
    await ctx.adapters.telegram.sendMessage(chatId, 'Siap, kamu bisa menerima file lagi.');
  } else {
    await ctx.adapters.telegram.sendMessage(
      chatId,
      'Halo! Ini bot Zeiko. Tautkan akunmu dari Pengaturan → Telegram di zeiko.biz.id.',
    );
  }
}
