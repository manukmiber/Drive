// Ads (SPEC §10): GET /api/ads (serving), /api/ads/areas, /api/advertiser/* (self-serve), and the
// cookie-less public endpoints /ad/i (impression beacon), /ad/c/:id (click), /ad/img/:id (image).
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  AD_CATEGORIES,
  AD_CTA_TYPES,
  AD_PLACEMENTS,
  type AdPlacement,
} from '../../shared/ad-policy';
import type { Ctx } from '../context';
import { AppError } from '../lib/errors';
import { contentLength } from '../lib/http';
import { validate } from '../lib/validate';
import { requireUser } from '../middleware/auth';
import { verifyTurnstile } from '../lib/turnstile';
import { clientIp, enforceRateLimit, rateLimit } from '../middleware/ratelimit';
import {
  adsAllowedForUser,
  advertiserDashboard,
  availability,
  cancelHeld,
  checkoutBookings,
  creativeImage,
  getAdvertiser,
  holdBookings,
  ownCreativeImage,
  recordClick,
  recordImpression,
  requestStudentOtp,
  resolveAreaChain,
  saveCreative,
  searchAreas,
  serveAd,
  setCreativeImage,
  submitCreative,
  upsertAdvertiser,
  verifyStudentOtp,
  type AdDto,
  type Geo,
} from '../services/ads';
import { escapeHtml } from '../services/email-templates';
import type { AppBindings } from '../types';

/** Area hints from Cloudflare (`request.cf`). In dev, `x-dev-geo-*` headers stand in for it. */
export function geoOf(c: Context<AppBindings>): Geo {
  const cf = (c.req.raw as Request & { cf?: { city?: string; region?: string; country?: string } })
    .cf;
  if (c.env.APP_ENV === 'dev' && !cf) {
    return {
      city: c.req.header('x-dev-geo-city') ?? null,
      region: c.req.header('x-dev-geo-region') ?? null,
      country: c.req.header('x-dev-geo-country') ?? null,
    };
  }
  return { city: cf?.city ?? null, region: cf?.region ?? null, country: cf?.country ?? null };
}

async function userCity(ctx: Ctx, userId: string | undefined): Promise<string | null> {
  if (!userId) return null;
  const r = await ctx.env.DB.prepare('SELECT ad_city_code FROM users WHERE id = ?1')
    .bind(userId)
    .first<{ ad_city_code: string | null }>();
  return r?.ad_city_code ?? null;
}

export async function pickAd(
  c: Context<AppBindings>,
  placement: AdPlacement,
  planUserId: string | null,
  exclude: string[] = [],
): Promise<AdDto | null> {
  const ctx = c.get('ctx');
  if (!(await adsAllowedForUser(ctx, planUserId))) return null;
  const viewer = c.get('user')?.id;
  const chain = await resolveAreaChain(ctx, { ...geoOf(c), userCity: await userCity(ctx, viewer) });
  return serveAd(ctx, placement, chain, exclude);
}

/**
 * Static ad card for the server-rendered share pages (password, link dead). No script runs there,
 * so the impression is counted when the page is rendered (ADR-032).
 */
export async function shareAdHtml(
  c: Context<AppBindings>,
  creatorId: string | null,
): Promise<string> {
  try {
    const ad = await pickAd(c, 'share_page', creatorId);
    if (!ad) return '';
    if (ad.bookingId && ad.token) await recordImpression(c.get('ctx'), ad.bookingId, ad.token);
    const href = ad.internal ? new URL(ad.clickUrl, c.env.APP_ORIGIN).toString() : ad.clickUrl;
    return `<aside class="ad" aria-label="${escapeHtml(ad.label)}"><span class="adl">${escapeHtml(ad.label)}</span>
<a href="${escapeHtml(href)}" target="_blank" rel="sponsored noopener noreferrer">${ad.imageUrl ? `<img src="${escapeHtml(ad.imageUrl)}" width="56" height="56" alt="">` : ''}<span><b>${escapeHtml(ad.title)}</b><br>${escapeHtml(ad.body)}</span></a>
${ad.creativeId ? `<a class="adr" href="/lapor?ad=${escapeHtml(ad.creativeId)}">Laporkan iklan</a>` : ''}</aside>`;
  } catch {
    return ''; // an ad must never break the page around it
  }
}

const placement = z.enum(AD_PLACEMENTS);
const creativeBody = z.object({
  title: z.string().max(200),
  body: z.string().max(500),
  ctaType: z.enum(AD_CTA_TYPES),
  ctaValue: z.string().min(1).max(500),
  category: z.enum(AD_CATEGORIES),
});

export const adsApi = new Hono<AppBindings>()
  .get(
    '/',
    validate('query', z.object({ placement, exclude: z.string().max(400).optional() })),
    async (c) => {
      const q = c.req.valid('query');
      const exclude = q.exclude ? q.exclude.split(',').slice(0, 20) : [];
      const ad = await pickAd(c, q.placement, c.get('user')?.id ?? null, exclude);
      c.header('Cache-Control', 'private, no-store');
      return c.json({ ad });
    },
  )
  .get('/areas', validate('query', z.object({ q: z.string().max(60).default('') })), async (c) =>
    c.json({ areas: await searchAreas(c.get('ctx'), c.req.valid('query').q) }),
  );

export const advertiser = new Hono<AppBindings>()
  .use('*', requireUser)
  .get('/', async (c) => c.json(await advertiserDashboard(c.get('ctx'), c.get('user')!.id)))
  .put(
    '/',
    validate(
      'json',
      z.object({
        businessName: z.string().min(1).max(80),
        kind: z.enum(['umkm', 'mahasiswa', 'lainnya']),
        phone: z.string().min(8).max(20),
        turnstileToken: z.string().max(4096).nullable().optional(),
      }),
    ),
    async (c) => {
      const { turnstileToken, ...body } = c.req.valid('json');
      const ctx = c.get('ctx');
      if (!(await getAdvertiser(ctx, c.get('user')!.id)))
        await verifyTurnstile(ctx, turnstileToken, clientIp(c.req.raw));
      await upsertAdvertiser(ctx, c.get('user')!.id, body);
      return c.json(await advertiserDashboard(c.get('ctx'), c.get('user')!.id));
    },
  )
  .post('/student/otp', validate('json', z.object({ email: z.string().max(254) })), async (c) => {
    await requestStudentOtp(c.get('ctx'), c.get('user')!.id, c.req.valid('json').email);
    return c.json({ ok: true });
  })
  .post('/student/verify', validate('json', z.object({ code: z.string().max(10) })), async (c) => {
    const ok = await verifyStudentOtp(c.get('ctx'), c.get('user')!.id, c.req.valid('json').code);
    if (!ok) throw new AppError('VALIDATION', 'OTP_WRONG', { field: 'code' });
    return c.json({ ok });
  })
  .post('/creatives', validate('json', creativeBody), async (c) =>
    c.json(await saveCreative(c.get('ctx'), c.get('user')!.id, c.req.valid('json')), 201),
  )
  .patch('/creatives/:id', validate('json', creativeBody), async (c) =>
    c.json(
      await saveCreative(c.get('ctx'), c.get('user')!.id, c.req.valid('json'), c.req.param('id')),
    ),
  )
  .put('/creatives/:id/image', async (c) => {
    const len = contentLength(c.req.header('content-length'));
    const max = (await c.get('ctx').config()).ad_image_max_bytes;
    if (len === null || len > max)
      throw new AppError('FILE_TOO_LARGE', 'ad image too large', { max });
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    return c.json(
      await setCreativeImage(c.get('ctx'), c.get('user')!.id, c.req.param('id'), bytes),
    );
  })
  .get('/creatives/:id/image', async (c) => {
    const obj = await ownCreativeImage(c.get('ctx'), c.get('user')!.id, c.req.param('id'));
    if (!obj) throw new AppError('NOT_FOUND', 'no image');
    return new Response(obj.body, {
      headers: {
        'content-type': 'image/webp',
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  })
  .post('/creatives/:id/submit', async (c) =>
    c.json(await submitCreative(c.get('ctx'), c.get('user')!.id, c.req.param('id'))),
  )
  .get(
    '/availability',
    validate('query', z.object({ area: z.string().min(2).max(13), placement })),
    async (c) => {
      const q = c.req.valid('query');
      return c.json(await availability(c.get('ctx'), c.get('user')!.id, q.area, q.placement));
    },
  )
  .post(
    '/bookings',
    rateLimit('RL_AD_BOOK', 'ad-book'),
    validate(
      'json',
      z.object({
        creativeId: z.string().max(40),
        areaCode: z.string().min(2).max(13),
        placement,
        dates: z.array(z.string().max(10)).min(1).max(60),
      }),
    ),
    async (c) =>
      c.json(await holdBookings(c.get('ctx'), c.get('user')!.id, c.req.valid('json')), 201),
  )
  .post(
    '/bookings/checkout',
    validate(
      'json',
      z.object({
        bookingIds: z.array(z.string().max(40)).min(1).max(100),
        method: z.string().max(30),
      }),
    ),
    async (c) => {
      const { bookingIds, method } = c.req.valid('json');
      return c.json(await checkoutBookings(c.get('ctx'), c.get('user')!, bookingIds, method));
    },
  )
  .post(
    '/bookings/cancel',
    validate('json', z.object({ bookingIds: z.array(z.string().max(40)).min(1).max(100) })),
    async (c) => {
      await cancelHeld(c.get('ctx'), c.get('user')!.id, c.req.valid('json').bookingIds);
      return c.body(null, 204);
    },
  );

/** Public, cookie-less ad endpoints (outside /api: no session, no CSRF, no user IDs). */
export const adPublic = new Hono<AppBindings>()
  .post('/i', async (c) => {
    await enforceRateLimit(c.env, 'RL_DOWNLOAD', `ad:${clientIp(c.req.raw)}`);
    const body = (await c.req.json().catch(() => null)) as { b?: unknown; t?: unknown } | null;
    if (
      body &&
      typeof body.b === 'string' &&
      typeof body.t === 'string' &&
      body.b.length <= 40 &&
      body.t.length <= 40
    ) {
      await recordImpression(c.get('ctx'), body.b, body.t);
    }
    return c.body(null, 204);
  })
  .get('/c/:id', async (c) =>
    c.redirect(await recordClick(c.get('ctx'), c.req.param('id').slice(0, 40)), 302),
  )
  .get('/img/:id', async (c) => {
    const obj = await creativeImage(c.get('ctx'), c.req.param('id').slice(0, 40));
    if (!obj) return c.body(null, 404);
    return new Response(obj.body, {
      headers: {
        'content-type': 'image/webp',
        'content-length': String(obj.size),
        'cache-control': 'public, max-age=3600',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cross-origin-resource-policy': 'same-origin',
      },
    });
  });
