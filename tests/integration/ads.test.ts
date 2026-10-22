import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/worker/adapters/clock';
import { MockPaymentProvider } from '../../src/worker/adapters/payment';
import { CRON } from '../../src/shared/constants';
import { addDaysWib, wibDate } from '../../src/shared/time';
import { createCtx } from '../../src/worker/context';
import { bannedTopic } from '../../src/shared/ad-policy';
import { ctaUrl, resolveAreaChain, reviewCreative } from '../../src/worker/services/ads';
import { invalidateConfigMemo } from '../../src/worker/services/config';
import { APP, makeRuntime } from '../helpers/runtime';
import { signIn, type Session } from '../helpers/session';
import { grantPlan, rootOf, uploadText } from '../helpers/files';
import type { DevRuntime } from '../../dev/env';

const T0 = Date.UTC(2026, 9, 10, 3, 0); // 10 Okt 2026 10:00 WIB
const TODAY = wibDate(T0);

async function setup(config: Record<string, unknown> = {}) {
  const clock = new FakeClock(T0);
  const rt = await makeRuntime({ clock });
  for (const [k, v] of Object.entries(config)) setConfig(rt, k, v);
  return { rt, clock };
}

function setConfig(rt: DevRuntime, key: string, value: unknown) {
  rt.d1.sqlite
    .prepare(
      `INSERT INTO app_config (key, value_json, updated_by, updated_at) VALUES (?, ?, 'test', 0)
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
    )
    .run(key, JSON.stringify(value));
  void rt.env.CONFIG_KV.delete('config:v1');
  invalidateConfigMemo(rt.env);
}

/** Minimal square VP8X WebP header (the server only reads the container header). */
function webp(side = 600, size = 2000): Uint8Array {
  const b = new Uint8Array(size);
  const v = new DataView(b.buffer);
  b.set(new TextEncoder().encode('RIFF'), 0);
  v.setUint32(4, size - 8, true);
  b.set(new TextEncoder().encode('WEBPVP8X'), 8);
  v.setUint32(16, 10, true);
  const w = side - 1;
  b.set(
    [w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff],
    24,
  );
  return b;
}

function fund(rt: DevRuntime, userId: string, idr: number) {
  rt.d1.sqlite
    .prepare(
      `INSERT INTO wallets (user_id, balance_idr, updated_at) VALUES (?, ?, 0)
       ON CONFLICT (user_id) DO UPDATE SET balance_idr = excluded.balance_idr`,
    )
    .run(userId, idr);
}

const geo = (city?: string, region?: string) => ({
  ...(city ? { 'x-dev-geo-city': city } : {}),
  ...(region ? { 'x-dev-geo-region': region } : {}),
});

async function advertiserWithCreative(
  rt: DevRuntime,
  email = 'umkm@example.com',
  title = 'Bakso Pak Kumis',
) {
  const s = await signIn(rt, email);
  expect(
    (
      await s.req('PUT', '/api/advertiser', {
        businessName: 'Warung Kumis',
        kind: 'umkm',
        phone: '0812 3456 7890',
      })
    ).status,
  ).toBe(200);
  const cr = await s.req('POST', '/api/advertiser/creatives', {
    title,
    body: 'Bakso urat porsi jumbo, buka sampai malam.',
    ctaType: 'whatsapp',
    ctaValue: '081234567890',
    category: 'kuliner',
  });
  expect(cr.status).toBe(201);
  const creative = (await cr.json()) as { id: string };
  const img = webp();
  const up = await s.req('PUT', `/api/advertiser/creatives/${creative.id}/image`, undefined, {
    body: img,
    headers: { 'content-type': 'image/webp', 'content-length': String(img.length) },
  });
  expect(up.status).toBe(200);
  const sub = (await (
    await s.req('POST', `/api/advertiser/creatives/${creative.id}/submit`)
  ).json()) as { status: string };
  return { s, creativeId: creative.id, status: sub.status };
}

async function approve(rt: DevRuntime, creativeId: string) {
  const admin = await signIn(rt, 'mod@example.com');
  await reviewCreative(createCtx(rt.env), admin.userId, creativeId, 'approve', '');
}

async function book(
  s: Session,
  creativeId: string,
  areaCode: string,
  dates: string[],
  placement = 'explorer_sidebar',
) {
  return s.req('POST', '/api/advertiser/bookings', { creativeId, areaCode, placement, dates });
}

async function adFor(
  rt: DevRuntime,
  headers: Record<string, string>,
  s?: Session,
  placement = 'explorer_sidebar',
) {
  const res = s
    ? await s.req('GET', `/api/ads?placement=${placement}`, undefined, { headers })
    : await rt.fetch(new Request(`${APP}/api/ads?placement=${placement}`, { headers }));
  expect(res.status).toBe(200);
  return (
    (await res.json()) as {
      ad: null | {
        bookingId: string | null;
        label: string;
        token: string | null;
        internal: boolean;
        clickUrl: string;
      };
    }
  ).ad;
}

describe('ad area targeting (SPEC §10.3)', () => {
  it('maps Cloudflare names to Kemendagri areas with a fallback chain', async () => {
    const { rt } = await setup();
    const ctx = createCtx(rt.env);
    expect(
      await resolveAreaChain(ctx, { city: 'Malang', region: 'East Java', country: 'ID' }),
    ).toEqual(['35.73', '35', 'ID']);
    expect(await resolveAreaChain(ctx, { city: 'South Jakarta', region: 'Jakarta' })).toEqual([
      '31.74',
      '31',
      'ID',
    ]);
    expect(
      await resolveAreaChain(ctx, { city: 'Yogyakarta', region: 'Special Region of Yogyakarta' }),
    ).toEqual(['34.71', '34', 'ID']);
    expect(await resolveAreaChain(ctx, { city: 'Bandung' })).toEqual(['32.73', '32', 'ID']);
    expect(await resolveAreaChain(ctx, { city: 'Kampung Antah', region: 'East Java' })).toEqual([
      '35',
      'ID',
    ]);
    expect(await resolveAreaChain(ctx, { city: 'Singapore', country: 'SG' })).toEqual(['ID']);
    expect(await resolveAreaChain(ctx, {})).toEqual(['ID']);
    // The user's chosen city wins over IP geolocation.
    expect(
      await resolveAreaChain(ctx, { userCity: '32.73', city: 'Malang', region: 'East Java' }),
    ).toEqual(['32.73', '32', 'ID']);
  });

  it('filters prohibited content and normalises CTAs', () => {
    expect(bannedTopic('Slot gacor maxwin hari ini')).toBe('judi/slot/togel');
    expect(bannedTopic('S1OT G4COR')).toBe('judi/slot/togel');
    expect(bannedTopic('Pinjol cair cepat tanpa BI checking')).toBe('pinjol ilegal');
    expect(bannedTopic('Bakso urat porsi jumbo')).toBeNull();
    expect(ctaUrl('whatsapp', '0812-3456-7890')).toEqual({ url: 'https://wa.me/6281234567890' });
    expect(ctaUrl('web', 'http://example.com')).toEqual({ error: 'CTA_URL' });
    expect(ctaUrl('web', 'https://bit.ly/abc')).toEqual({ error: 'CTA_SHORTENER' });
    expect(ctaUrl('shopee', 'https://evil.com/x')).toEqual({ error: 'CTA_URL' });
    expect(ctaUrl('instagram', '@warung.kumis')).toEqual({
      url: 'https://www.instagram.com/warung.kumis',
    });
  });
});

describe('self-serve ads (SPEC §10.4–10.7)', () => {
  it('moderates, books, pays from Saldo, serves by area, and counts impressions/clicks', async () => {
    const { rt, clock } = await setup();
    const bad = await advertiserWithCreative(rt, 'judi@example.com', 'Slot gacor maxwin');
    expect(bad.status).toBe('rejected');

    const { s, creativeId, status } = await advertiserWithCreative(rt);
    expect(status).toBe('pending');
    expect((await book(s, creativeId, '35.73', [TODAY])).status).toBe(409); // not approved yet
    await approve(rt, creativeId);

    const avail = (await (
      await s.req('GET', '/api/advertiser/availability?area=35.73&placement=explorer_sidebar')
    ).json()) as {
      priceIdr: number;
      days: Array<{ date: string; remaining: number }>;
    };
    expect(avail.priceIdr).toBe(10_000);
    expect(avail.days).toHaveLength(15);
    expect(avail.days[0]).toEqual({ date: TODAY, remaining: 8, total: 8 });

    const tomorrow = addDaysWib(TODAY, 1);
    const held = (await (await book(s, creativeId, '35.73', [TODAY, tomorrow])).json()) as {
      bookingIds: string[];
      totalIdr: number;
    };
    expect(held.totalIdr).toBe(20_000);
    expect(
      (
        await s.req('POST', '/api/advertiser/bookings/checkout', {
          bookingIds: held.bookingIds,
          method: 'saldo',
        })
      ).status,
    ).toBe(402);
    fund(rt, s.userId, 50_000);
    const paid = (await (
      await s.req('POST', '/api/advertiser/bookings/checkout', {
        bookingIds: held.bookingIds,
        method: 'saldo',
      })
    ).json()) as {
      paid: boolean;
      invoiceId: string;
    };
    expect(paid.paid).toBe(true);
    const statuses = rt.d1.sqlite
      .prepare('SELECT date, status FROM ad_bookings WHERE creative_id = ? ORDER BY date')
      .all(creativeId);
    expect(statuses).toEqual([
      { date: TODAY, status: 'live' },
      { date: tomorrow, status: 'paid' },
    ]);

    // Malang visitor sees it; Surabaya visitor (no booking in Jatim) gets the internal ad.
    const ad = await adFor(rt, geo('Malang', 'East Java'));
    expect(ad).toMatchObject({ internal: false, label: 'Iklan · Kota Malang' });
    expect((await adFor(rt, geo('Surabaya', 'East Java')))!.internal).toBe(true);

    // Impression needs the signed token; click redirects to the CTA and counts.
    const beacon = (b: string, t: string) =>
      rt.fetch(
        new Request(`${APP}/ad/i`, {
          method: 'POST',
          body: JSON.stringify({ b, t }),
          headers: { 'content-type': 'application/json' },
        }),
      );
    expect((await beacon(ad!.bookingId!, 'forged')).status).toBe(204);
    expect((await beacon(ad!.bookingId!, ad!.token!)).status).toBe(204);
    const click = await rt.fetch(new Request(`${APP}${ad!.clickUrl}`, { redirect: 'manual' }));
    expect(click.status).toBe(302);
    expect(click.headers.get('location')).toBe('https://wa.me/6281234567890');
    expect(
      rt.d1.sqlite
        .prepare('SELECT impressions, clicks FROM ad_bookings WHERE id = ?')
        .get(ad!.bookingId),
    ).toEqual({
      impressions: 1,
      clicks: 1,
    });

    const dash = (await (await s.req('GET', '/api/advertiser')).json()) as {
      bookings: Array<{ ctr: number; date: string }>;
    };
    expect(dash.bookings.find((b) => b.date === TODAY)!.ctr).toBe(1);

    // 00:05 WIB the next day: tomorrow's booking goes live, today's completes.
    clock.set(Date.UTC(2026, 9, 10, 17, 6));
    await rt.runCron(CRON.dailyAds);
    expect(
      rt.d1.sqlite
        .prepare('SELECT date, status FROM ad_bookings WHERE creative_id = ? ORDER BY date')
        .all(creativeId),
    ).toEqual([
      { date: TODAY, status: 'completed' },
      { date: tomorrow, status: 'live' },
    ]);
  });

  it('falls back to the province, and never overbooks a slot', async () => {
    const { rt, clock } = await setup({
      ad_slots_by_tier: { tier1: 1, tier2: 1, tier3: 1, province: 1, national: 1 },
    });
    const a = await advertiserWithCreative(rt, 'a@example.com');
    const b = await advertiserWithCreative(rt, 'b@example.com');
    await approve(rt, a.creativeId);
    await approve(rt, b.creativeId);
    const date = addDaysWib(TODAY, 3);
    const results = await Promise.all([
      book(a.s, a.creativeId, '35', [date]),
      book(b.s, b.creativeId, '35', [date]),
      book(a.s, a.creativeId, '35', [date]),
      book(b.s, b.creativeId, '35', [date]),
    ]);
    const codes = results.map((r) => r.status).sort();
    expect(codes).toEqual([201, 409, 409, 409]);
    expect(
      rt.d1.sqlite
        .prepare(
          `SELECT booked_slots FROM ad_inventory WHERE date = ? AND area_code = '35' AND placement = 'explorer_sidebar'`,
        )
        .get(date),
    ).toEqual({
      booked_slots: 1,
    });
    const loser = results.find((r) => r.status === 409)!;
    expect(
      ((await loser.json()) as { error: { message: string; data: { dates: string[] } } }).error,
    ).toMatchObject({
      message: 'SOLD_OUT',
      data: { dates: [date] },
    });

    // Unpaid hold expires → slot is free again.
    clock.advance(16 * 60_000);
    await rt.runCron(CRON.hourly);
    expect((await book(b.s, b.creativeId, '35', [date])).status).toBe(201);

    // A province booking for today serves a Malang visitor (city → province fallback).
    fund(rt, a.s.userId, 100_000);
    const h = (await (await book(a.s, a.creativeId, '35', [TODAY])).json()) as {
      bookingIds: string[];
    };
    await a.s.req('POST', '/api/advertiser/bookings/checkout', {
      bookingIds: h.bookingIds,
      method: 'saldo',
    });
    expect(await adFor(rt, geo('Malang', 'East Java'))).toMatchObject({
      internal: false,
      label: 'Iklan · Jawa Timur',
    });
  });

  it('pays by QRIS through a top-up and suspends with a refund', async () => {
    const { rt } = await setup();
    const { s, creativeId } = await advertiserWithCreative(rt);
    await approve(rt, creativeId);
    const h = (await (
      await book(s, creativeId, '35.73', [TODAY, addDaysWib(TODAY, 1)])
    ).json()) as { bookingIds: string[] };
    const co = (await (
      await s.req('POST', '/api/advertiser/bookings/checkout', {
        bookingIds: h.bookingIds,
        method: 'qris',
      })
    ).json()) as {
      paid: boolean;
      topup: { paymentId: string; amountIdr: number };
    };
    expect(co.paid).toBe(false);
    const signed = await MockPaymentProvider.signedBody(rt.env.PAYMENT_WEBHOOK_SECRET, {
      providerRef: `mock_${co.topup.paymentId}`,
      status: 'paid',
      amountIdr: co.topup.amountIdr,
    } as never);
    const hook = await rt.fetch(
      new Request(`${APP}/api/payments/webhook/mock`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mock-signature': signed.signature },
        body: signed.body,
      }),
    );
    expect(hook.status).toBe(200);
    await rt.settle();
    expect(
      rt.d1.sqlite
        .prepare(`SELECT COUNT(*) AS n FROM ad_bookings WHERE status IN ('live', 'paid')`)
        .get(),
    ).toEqual({ n: 2 });

    const mod = await signIn(rt, 'mod2@example.com');
    rt.d1.sqlite
      .prepare(`UPDATE users SET role = 'moderator', two_factor_enabled = 1 WHERE id = ?`)
      .run(mod.userId);
    const res = await mod.req('POST', `/api/admin/ads/${creativeId}/suspend`, {
      severe: false,
      reason: 'Klaim menyesatkan',
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { refundedIdr: number }).refundedIdr).toBe(20_000);
    expect((await adFor(rt, geo('Malang', 'East Java')))!.internal).toBe(true);
    const audit = rt.d1.sqlite
      .prepare(`SELECT action FROM audit_logs WHERE target_id = ?`)
      .all(creativeId);
    expect(audit).toContainEqual({ action: 'ad.suspend' });
  });
});

describe('where ads never appear (SPEC §10.1)', () => {
  it('keeps download paths ad-free, respects plans.show_ads and the feature flag', async () => {
    const { rt } = await setup();
    const { s: adv, creativeId } = await advertiserWithCreative(rt);
    await approve(rt, creativeId);
    fund(rt, adv.userId, 100_000);
    const h = (await (await book(adv, creativeId, 'ID', [TODAY], 'share_page')).json()) as {
      bookingIds: string[];
    };
    await adv.req('POST', '/api/advertiser/bookings/checkout', {
      bookingIds: h.bookingIds,
      method: 'saldo',
    });

    const owner = await signIn(rt, 'owner@example.com');
    await grantPlan(rt, owner.userId, 'plus');
    const f = await uploadText(owner, await rootOf(owner), 'dokumen.txt', 'isi dokumen');
    await rt.settle();
    const open = (await (await owner.req('POST', '/api/shares', { nodeIds: [f.id] })).json()) as {
      share: { url: string };
    };
    const locked = (await (
      await owner.req('POST', '/api/shares', { nodeIds: [f.id], password: 'rahasia123' })
    ).json()) as {
      share: { url: string };
    };
    const ua = { 'user-agent': 'Mozilla/5.0 test' };

    const dl = await rt.fetch(new Request(open.share.url, { headers: ua }));
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe('isi dokumen'); // the file itself, no interstitial

    const pw = await (await rt.fetch(new Request(locked.share.url, { headers: ua }))).text();
    expect(pw).toContain('Iklan · Indonesia');
    expect(pw).toContain('Bakso Pak Kumis');

    // Plans with show_ads = 0 hide ads for their users (and on their share pages).
    rt.d1.sqlite.prepare(`UPDATE plans SET show_ads = 0 WHERE code = 'plus'`).run();
    expect(await adFor(rt, {}, owner)).toBeNull();
    expect(
      await (await rt.fetch(new Request(locked.share.url, { headers: ua }))).text(),
    ).not.toContain('Iklan ·');

    setConfig(rt, 'features', { ...(await createCtx(rt.env).config()).features, ads: false });
    expect(await adFor(rt, {})).toBeNull();
  });
});
