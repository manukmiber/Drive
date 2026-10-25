// Sending share links: deeplinks (WhatsApp/Telegram/QR/copy/Web Share, logged only) and email via the
// `notify` queue (SPEC §6.3–6.8). Sending through a Telegram bot is gone (ADR-041).
import { realEmail } from './readiness';
import { formatBytes, formatDateTime } from '../../shared/format';
import type { ShareChannel, ShareSendMode } from '../../shared/enums';
import { DAY_MS } from '../../shared/constants';
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
import { ulid } from '../lib/ids';
import { shareEmail } from './email-templates';
import { requireOwnShare, shareState, shareUrl } from './shares';
import { appUrl } from '../lib/paths';

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
  if (!cfg.features.email_share || !realEmail(ctx))
    throw new AppError('FORBIDDEN', 'email sharing is disabled');
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
    reportUrl: appUrl(ctx.env, `/lapor?share=${c.share.id}`),
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
