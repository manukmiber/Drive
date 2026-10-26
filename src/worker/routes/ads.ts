// Ads (SPEC §10, ADR-043): GET /api/ads (the rotation), /api/advertiser (an
// advertiser's own dashboard: their campaigns and numbers; ordering and paying are by email), and
// the cookie-less public endpoints /ad/i (impression beacon), /ad/c/:id (click), /ad/img/:id
// (image), /ad/qr/:id.png (the QRIS in a payment email). The operator's side (entering an ad, the
// manual check, takedowns) is the ops API, /api/ops/ads, from the relay (ADR-057).
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { AD_PLACEMENTS, type AdPlacement } from '../../shared/ad-policy';
import type { Ctx } from '../context';
import { AppError } from '../lib/errors';
import { validate } from '../lib/validate';
import { requireUser } from '../middleware/auth';
import { clientIp, enforceRateLimit } from '../middleware/ratelimit';
import {
  adsAllowedForUser,
  advertiserDashboard,
  campaignQris,
  creativeImage,
  ownCreativeImage,
  recordClick,
  recordImpression,
  resolveAreaChain,
  serveAd,
  serveRotation,
  type AdDto,
} from '../services/ads';
import { escapeHtml } from '../services/email-templates';
import type { AppBindings } from '../types';
import { appPath } from '../lib/paths';
import { qrPng } from '../lib/qr-png';

async function userCity(ctx: Ctx, userId: string | undefined): Promise<string | null> {
  if (!userId) return null;
  const r = await ctx.env.DB.prepare('SELECT ad_city_code FROM users WHERE id = ?1')
    .bind(userId)
    .first<{ ad_city_code: string | null }>();
  return r?.ad_city_code ?? null;
}

/** Only the city on the viewer's Zeiko Account (ADR-041); no account or no city: national ads. */
async function viewerChain(c: Context<AppBindings>): Promise<string[]> {
  const ctx = c.get('ctx');
  return resolveAreaChain(ctx, { userCity: await userCity(ctx, c.get('user')?.id) });
}

/**
 * Static ad card for the server-rendered share pages (password, link dead). No script runs there,
 * so there is no rotation: one ad, and its impression is counted when the page is rendered (ADR-032).
 */
export async function shareAdHtml(
  c: Context<AppBindings>,
  creatorId: string | null,
): Promise<string> {
  try {
    const ctx = c.get('ctx');
    if (!(await adsAllowedForUser(ctx, creatorId))) return '';
    const ad: AdDto | null = await serveAd(ctx, 'share_page', await viewerChain(c));
    if (!ad) return '';
    if (ad.campaignId && ad.area && ad.token)
      await recordImpression(ctx, ad.campaignId, ad.area, ad.token);
    const href = ad.internal ? new URL(ad.clickUrl, c.env.APP_ORIGIN).toString() : ad.clickUrl;
    return `<aside class="ad" aria-label="${escapeHtml(ad.label)}"><span class="adl">${escapeHtml(ad.label)}</span>
<a href="${escapeHtml(href)}" target="_blank" rel="sponsored noopener noreferrer">${ad.imageUrl ? `<img src="${escapeHtml(ad.imageUrl)}" width="56" height="56" alt="">` : ''}<span><b>${escapeHtml(ad.title)}</b><br>${escapeHtml(ad.body)}</span></a>
${ad.creativeId ? `<a class="adr" href="${escapeHtml(appPath(c.env, `/lapor?ad=${ad.creativeId}`))}">Laporkan iklan</a>` : ''}</aside>`;
  } catch {
    return ''; // an ad must never break the page around it
  }
}

const placement = z.enum(AD_PLACEMENTS);

export const adsApi = new Hono<AppBindings>().get(
  '/',
  validate('query', z.object({ placement, exclude: z.string().max(400).optional() })),
  async (c) => {
    const q = c.req.valid('query');
    const ctx = c.get('ctx');
    c.header('Cache-Control', 'private, no-store');
    if (!(await adsAllowedForUser(ctx, c.get('user')?.id ?? null)))
      return c.json({ ads: [], rotateSeconds: 0 });
    const exclude = q.exclude ? q.exclude.split(',').slice(0, 20) : [];
    const placed: AdPlacement = q.placement;
    return c.json(await serveRotation(ctx, placed, await viewerChain(c), exclude));
  },
);

/** The advertiser's own page (rule 6, ADR-043): their campaigns and their numbers. */
export const advertiser = new Hono<AppBindings>()
  .use('*', requireUser)
  .get('/', async (c) => c.json(await advertiserDashboard(c.get('ctx'), c.get('user')!.id)))
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
  });

/** Public, cookie-less ad endpoints (outside /api: no session, no CSRF, no user IDs). */
export const adPublic = new Hono<AppBindings>()
  .post('/i', async (c) => {
    await enforceRateLimit(c.env, 'RL_DOWNLOAD', `ad:${clientIp(c.req.raw)}`);
    const body = (await c.req.json().catch(() => null)) as {
      c?: unknown;
      a?: unknown;
      t?: unknown;
    } | null;
    if (
      body &&
      typeof body.c === 'string' &&
      typeof body.a === 'string' &&
      typeof body.t === 'string' &&
      body.c.length <= 40 &&
      body.a.length <= 13 &&
      body.t.length <= 40
    ) {
      await recordImpression(c.get('ctx'), body.c, body.a, body.t);
    }
    return c.body(null, 204);
  })
  .get('/c/:id', async (c) =>
    c.redirect(
      await recordClick(
        c.get('ctx'),
        c.req.param('id').slice(0, 40),
        (c.req.query('a') ?? 'ID').slice(0, 13),
      ),
      302,
    ),
  )
  // The QR in an ad's payment email (ADR-043). Mail clients fetch it once, through their proxy.
  .get('/qr/:file', async (c) => {
    const id = c.req
      .param('file')
      .replace(/\.png$/, '')
      .slice(0, 40);
    const text = await campaignQris(c.get('ctx'), id, (c.req.query('t') ?? '').slice(0, 40));
    if (!text) return c.body(null, 404);
    return new Response(await qrPng(text), {
      headers: {
        'content-type': 'image/png',
        'cache-control': 'private, max-age=86400',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
      },
    });
  })
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
