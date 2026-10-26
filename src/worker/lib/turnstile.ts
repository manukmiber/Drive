// Cloudflare Turnstile check (SPEC §14.4). Without TURNSTILE_SECRET_KEY (dev, tests, or before the
// owner sets it up) nothing is checked, and the caller is told so: it must not then treat the
// request as coming from a human (ADR-056).
import type { Ctx } from '../context';
import { AppError } from './errors';

/** True when a human was verified; false when Turnstile is not set up here. Throws on a failed check. */
export async function verifyTurnstile(
  ctx: Ctx,
  token: string | null | undefined,
  ip: string,
): Promise<boolean> {
  if (!ctx.env.TURNSTILE_SECRET_KEY) return false;
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
  return true;
}
