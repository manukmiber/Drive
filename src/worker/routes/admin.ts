// Admin API (SPEC §13.1). Every route requires staff role + second factor (passkey/TOTP).
// Moderators handle reports and the scanner; money, roles and config are admin-only.
import { Hono } from 'hono';
import { z } from 'zod';
import { validate } from '../lib/validate';
import { AppError } from '../lib/errors';
import { requireStaff } from '../middleware/auth';
import { AD_CATEGORIES, AD_CTA_TYPES } from '../../shared/ad-policy';
import { AD_CAMPAIGN_SCOPES, AD_CAMPAIGN_STATUSES } from '../../shared/enums';
import { contentLength } from '../lib/http';
import {
  advertiserForOperator,
  cancelCampaign,
  createCampaign,
  driveUserByEmail,
  listCampaigns,
  listCreativesForReview,
  reviewCreative,
  sendCampaignPayment,
  reviewCreativeImage,
  saveCreative,
  setCreativeImage,
  suspendCreative,
  upsertAdvertiser,
} from '../services/ads';
import {
  adjustBalance,
  auditLog,
  catalogView,
  configView,
  dashboard,
  retryScan,
  scannerStats,
  searchUsers,
  setBonusQuota,
  setUserRole,
  setUserSuspended,
  updateCatalogItem,
  updateConfig,
} from '../services/admin';
import {
  applyActions,
  listReports,
  REPORT_ACTIONS,
  reportDetail,
  reviewPreview,
} from '../services/reports';
import type { AppBindings } from '../types';

const reason = z.string().max(500);
const creativeBody = z.object({
  title: z.string().max(200),
  body: z.string().max(500),
  ctaType: z.enum(AD_CTA_TYPES),
  ctaValue: z.string().min(1).max(500),
  category: z.enum(AD_CATEGORIES),
});
const adminOnly = requireStaff(['admin']);

export const admin = new Hono<AppBindings>()
  .use('*', requireStaff(['admin', 'moderator']))
  .get('/whoami', (c) => c.json({ user: c.get('user') }))
  // Ads moderation (SPEC §10.5)
  .get(
    '/ads',
    validate(
      'query',
      z.object({
        status: z.enum(['pending', 'approved', 'rejected', 'suspended']).default('pending'),
      }),
    ),
    async (c) =>
      c.json({ items: await listCreativesForReview(c.get('ctx'), c.req.valid('query').status) }),
  )
  .get('/ads/:id/image', async (c) => {
    const obj = await reviewCreativeImage(c.get('ctx'), c.req.param('id'));
    if (!obj) return c.body(null, 404);
    return new Response(obj.body, {
      headers: {
        'content-type': 'image/webp',
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  })
  .post(
    '/ads/:id/review',
    validate('json', z.object({ decision: z.enum(['approve', 'reject']), reason })),
    async (c) => {
      const b = c.req.valid('json');
      if (b.decision === 'reject' && !b.reason.trim())
        throw new AppError('VALIDATION', 'reason required', { field: 'reason' });
      await reviewCreative(
        c.get('ctx'),
        c.get('user')!.id,
        c.req.param('id'),
        b.decision,
        b.reason,
      );
      return c.body(null, 204);
    },
  )
  // Entering an ad an advertiser asked for by email (ADR-043): admins only, since it opens a bill.
  .get(
    '/ads/advertiser',
    adminOnly,
    validate('query', z.object({ email: z.string().trim().email().max(254) })),
    async (c) => c.json(await advertiserForOperator(c.get('ctx'), c.req.valid('query').email)),
  )
  .put(
    '/ads/advertiser',
    adminOnly,
    validate(
      'json',
      z.object({
        email: z.string().trim().email().max(254),
        businessName: z.string().min(1).max(80),
        kind: z.enum(['umkm', 'mahasiswa', 'lainnya']),
        phone: z.string().min(8).max(20),
      }),
    ),
    async (c) => {
      const b = c.req.valid('json');
      const ctx = c.get('ctx');
      const user = await driveUserByEmail(ctx, b.email);
      await upsertAdvertiser(ctx, user.id, b);
      return c.json(await advertiserForOperator(ctx, b.email));
    },
  )
  .post(
    '/ads/creatives',
    adminOnly,
    validate('json', creativeBody.extend({ advertiserId: z.string().max(80) })),
    async (c) => {
      const { advertiserId, ...input } = c.req.valid('json');
      return c.json(await saveCreative(c.get('ctx'), advertiserId, input), 201);
    },
  )
  .patch(
    '/ads/creatives/:id',
    adminOnly,
    validate('json', creativeBody.extend({ advertiserId: z.string().max(80) })),
    async (c) => {
      const { advertiserId, ...input } = c.req.valid('json');
      return c.json(await saveCreative(c.get('ctx'), advertiserId, input, c.req.param('id')));
    },
  )
  .put('/ads/creatives/:id/image', adminOnly, async (c) => {
    const len = contentLength(c.req.header('content-length'));
    const max = (await c.get('ctx').config()).ad_image_max_bytes;
    if (len === null || len > max) throw new AppError('FILE_TOO_LARGE', 'ad image too large', { max });
    const advertiserId = c.req.query('advertiser') ?? '';
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    return c.json(await setCreativeImage(c.get('ctx'), advertiserId, c.req.param('id'), bytes));
  })
  .get(
    '/ads/campaigns',
    validate('query', z.object({ status: z.enum(AD_CAMPAIGN_STATUSES).optional() })),
    async (c) => c.json({ items: await listCampaigns(c.get('ctx'), c.req.valid('query').status) }),
  )
  .post(
    '/ads/campaigns',
    adminOnly,
    validate(
      'json',
      z.object({
        creativeId: z.string().max(40),
        scope: z.enum(AD_CAMPAIGN_SCOPES),
        areaCodes: z.array(z.string().max(13)).max(600).default([]),
        startDate: z.string().max(10),
        days: z.number().int(),
      }),
    ),
    async (c) =>
      c.json(await createCampaign(c.get('ctx'), c.get('user')!.id, c.req.valid('json')), 201),
  )
  // Sends the payment email again: the QRIS still open, or a new one (ADR-043).
  .post('/ads/campaigns/:id/send-payment', adminOnly, async (c) =>
    c.json(await sendCampaignPayment(c.get('ctx'), c.req.param('id'))),
  )
  .post(
    '/ads/campaigns/:id/cancel',
    adminOnly,
    validate('json', z.object({ reason: reason.min(3) })),
    async (c) => {
      await cancelCampaign(c.get('ctx'), c.get('user')!.id, c.req.param('id'), c.req.valid('json').reason);
      return c.body(null, 204);
    },
  )
  .post(
    '/ads/:id/suspend',
    validate('json', z.object({ severe: z.boolean(), reason: reason.min(3) })),
    async (c) => {
      const b = c.req.valid('json');
      return c.json(
        await suspendCreative(
          c.get('ctx'),
          c.get('user')!.id,
          c.req.param('id'),
          b.severe,
          b.reason,
        ),
      );
    },
  )
  .get(
    '/dashboard',
    validate('query', z.object({ days: z.coerce.number().int().min(1).max(365).default(30) })),
    async (c) => c.json(await dashboard(c.get('ctx'), c.req.valid('query').days)),
  )
  // Users
  .get('/users', validate('query', z.object({ q: z.string().max(200).default('') })), async (c) =>
    c.json({ items: await searchUsers(c.get('ctx'), c.req.valid('query').q) }),
  )
  .post(
    '/users/:id/suspend',
    validate('json', z.object({ suspended: z.boolean(), reason })),
    async (c) => {
      const b = c.req.valid('json');
      await setUserSuspended(
        c.get('ctx'),
        c.get('user')!.id,
        c.req.param('id'),
        b.suspended,
        b.reason,
      );
      return c.body(null, 204);
    },
  )
  .post(
    '/users/:id/balance',
    adminOnly,
    validate('json', z.object({ deltaIdr: z.number().int(), reason })),
    async (c) => {
      const b = c.req.valid('json');
      return c.json({
        balanceIdr: await adjustBalance(
          c.get('ctx'),
          c.get('user')!.id,
          c.req.param('id'),
          b.deltaIdr,
          b.reason,
        ),
      });
    },
  )
  .post(
    '/users/:id/bonus',
    adminOnly,
    validate('json', z.object({ bonusBytes: z.number().int().nonnegative(), reason })),
    async (c) => {
      const b = c.req.valid('json');
      await setBonusQuota(
        c.get('ctx'),
        c.get('user')!.id,
        c.req.param('id'),
        b.bonusBytes,
        b.reason,
      );
      return c.body(null, 204);
    },
  )
  .post(
    '/users/:id/role',
    adminOnly,
    validate('json', z.object({ role: z.enum(['user', 'moderator', 'admin']), reason })),
    async (c) => {
      const b = c.req.valid('json');
      await setUserRole(c.get('ctx'), c.get('user')!.id, c.req.param('id'), b.role, b.reason);
      return c.body(null, 204);
    },
  )
  // Reports & takedown
  .get(
    '/reports',
    validate(
      'query',
      z.object({
        status: z
          .enum(['active', 'open', 'in_review', 'resolved', 'rejected', 'all'])
          .default('active'),
      }),
    ),
    async (c) => c.json({ items: await listReports(c.get('ctx'), c.req.valid('query').status) }),
  )
  .get('/reports/:id', async (c) => c.json(await reportDetail(c.get('ctx'), c.req.param('id'))))
  .post(
    '/reports/:id/actions',
    validate(
      'json',
      z.object({
        actions: z.array(z.enum(REPORT_ACTIONS)).min(1).max(9),
        note: z.string().min(3).max(500),
      }),
    ),
    async (c) => {
      const b = c.req.valid('json');
      await applyActions(c.get('ctx'), c.get('user')!.id, c.req.param('id'), b.actions, b.note);
      return c.body(null, 204);
    },
  )
  .post(
    '/reports/:id/preview',
    validate('json', z.object({ nodeId: z.string().max(40) })),
    async (c) =>
      c.json(
        await reviewPreview(
          c.get('ctx'),
          c.get('user')!.id,
          c.req.param('id'),
          c.req.valid('json').nodeId,
        ),
      ),
  )
  // Scanner
  .get('/scanner', async (c) => c.json(await scannerStats(c.get('ctx'))))
  .post('/scanner/:blobId/retry', async (c) => {
    await retryScan(c.get('ctx'), c.get('user')!.id, c.req.param('blobId'));
    return c.body(null, 204);
  })
  // Config, catalog, audit (admin only)
  .get('/config', adminOnly, async (c) => c.json({ items: await configView(c.get('ctx')) }))
  .put('/config/:key', adminOnly, validate('json', z.object({ value: z.unknown() })), async (c) =>
    c.json({
      value: await updateConfig(
        c.get('ctx'),
        c.get('user')!.id,
        c.req.param('key'),
        c.req.valid('json').value,
      ),
    }),
  )
  .get('/catalog', adminOnly, async (c) => c.json(await catalogView(c.get('ctx'))))
  .patch(
    '/catalog/:kind/:code',
    adminOnly,
    validate('json', z.record(z.string(), z.unknown())),
    async (c) => {
      await updateCatalogItem(
        c.get('ctx'),
        c.get('user')!.id,
        c.req.param('kind'),
        c.req.param('code'),
        c.req.valid('json'),
      );
      return c.body(null, 204);
    },
  )
  .get(
    '/audit',
    adminOnly,
    validate(
      'query',
      z.object({
        action: z.string().max(60).optional(),
        targetId: z.string().max(80).optional(),
        before: z.coerce.number().int().optional(),
      }),
    ),
    async (c) => c.json({ items: await auditLog(c.get('ctx'), c.req.valid('query')) }),
  );
