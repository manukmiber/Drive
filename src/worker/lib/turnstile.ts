// Cloudflare Turnstile check (SPEC §14.4). A no-op until TURNSTILE_SECRET_KEY is set (dev, tests).
import type { Ctx } from '../context';
import { AppError } from './errors';

export async function verifyTurnstile(
  ctx: Ctx,
  token: string | null | undefined,
  ip: string,
): Promise<void> {
  if (!ctx.env.TURNSTILE_SECRET_KEY) return;
  if (!token) throw new AppError('FORBIDDEN', 'captcha required', { reason: 'TURNSTILE' });
  const body = new FormData();
  body.set('secret', ctx.env.TURNSTILE_SECRET_KEY);
  body.set('response', token);
  body.set('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body,
  });
  const data = (await res.json()) as { success: boolean };
  if (!data.success) throw new AppError('FORBIDDEN', 'captcha failed', { reason: 'TURNSTILE' });
}
