import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/worker/adapters/clock';
import { MockPaymentProvider } from '../../src/worker/adapters/payment';
import { CRON } from '../../src/shared/constants';
import { addDaysWib, wibDate } from '../../src/shared/time';
import { createCtx } from '../../src/worker/context';
import { bannedTopic } from '../../src/shared/ad-policy';
import { adCampaignPricePerDay } from '../../src/shared/ad-policy';
import { CONFIG_DEFAULTS } from '../../src/shared/config-defaults';
import { areaForCity, ctaUrl, resolveAreaChain } from '../../src/worker/services/ads';
import { invalidateConfigMemo } from '../../src/worker/services/config';
import { APP, makeRuntime } from '../helpers/runtime';
import { signIn, type Session } from '../helpers/session';
import { imageBody, operator } from '../helpers/ops';
import { grantPlan, rootOf, uploadText } from '../helpers/files';
import type { DevRuntime } from '../../dev/env';
import { noticesOf } from '../helpers/notices';

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

/** Someone whose Zeiko Account says they live in `city` (ADR-041). */
const viewerIn = (rt: DevRuntime, city: string) =>
  signIn(rt, `${city.toLowerCase().replace(/\W+/g, '')}@example.com`, { city });

interface Placed {
  advertiser: Session;
  creativeId: string;
  campaignId: string;
  campaignStatus: string;
}

/**
 * What the operator does with an advertiser's email (ADR-043): the advertiser (who has signed in to
 * Drive once), their creative with its picture, and a campaign.
 */
type Ops = ReturnType<typeof operator>;

async function placeAd(
  rt: DevRuntime,
  op: Ops,
  p: {
    email?: string;
    kind?: 'umkm' | 'mahasiswa' | 'lainnya';
    title?: string;
    scope?: 'cities' | 'national';
    areaCodes?: string[];
    startDate?: string;
    days?: number;
  } = {},
): Promise<Placed> {
  const email = p.email ?? 'umkm@example.com';
  const advertiser = await signIn(rt, email);
  const saved = await op('PUT', '/ads/advertiser', {
    email,
    businessName: 'Warung Kumis',
    kind: p.kind ?? 'umkm',
    phone: '0812 3456 7890',
  });
  expect(saved.status).toBe(200);
  const cr = await op('POST', '/ads/creatives', {
    advertiserId: advertiser.userId,
    title: p.title ?? 'Bakso Pak Kumis',
    body: 'Bakso urat porsi jumbo, buka sampai malam.',
    ctaType: 'whatsapp',
    ctaValue: '081234567890',
    category: 'kuliner',
  });
  expect(cr.status).toBe(201);
  const creativeId = ((await cr.json()) as { id: string }).id;
  const up = await op(
    'PUT',
    `/ads/creatives/${creativeId}/image`,
    imageBody(advertiser.userId, webp()),
  );
  expect(up.status).toBe(200);
  const k = await op('POST', '/ads/campaigns', {
    creativeId,
    scope: p.scope ?? 'cities',
    areaCodes: p.areaCodes ?? ['35.73'],
    startDate: p.startDate ?? TODAY,
    days: p.days ?? 2,
  });
  expect(k.status).toBe(201);
  const campaign = (await k.json()) as { id: string; status: string };
  return { advertiser, creativeId, campaignId: campaign.id, campaignStatus: campaign.status };
}

async function review(
  rt: DevRuntime,
  creativeId: string,
  decision: 'approve' | 'reject',
  reason = '',
) {
  const res = await operator(rt)('POST', `/ads/${creativeId}/review`, { decision, reason });
  expect(res.status).toBe(204);
}

async function rotationFor(rt: DevRuntime, s?: Session, placement = 'explorer_sidebar') {
  const res = s
    ? await s.req('GET', `/api/ads?placement=${placement}`)
    : await rt.fetch(new Request(`${APP}/api/ads?placement=${placement}`));
  expect(res.status).toBe(200);
  return (await res.json()) as {
    rotateSeconds: number;
    ads: Array<{
      campaignId: string | null;
      creativeId: string | null;
      title: string;
      label: string;
      token: string | null;
      area: string | null;
      internal: boolean;
      clickUrl: string;
    }>;
  };
}

const status = (rt: DevRuntime, id: string) =>
  (
    rt.d1.sqlite.prepare('SELECT status FROM ad_campaigns WHERE id = ?').get(id) as {
      status: string;
    }
  ).status;

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
    // A city typed on the Zeiko Account (ADR-041): a city first, else a province, else nothing.
    expect(await areaForCity(ctx, 'Malang')).toBe('35.73');
    expect(await areaForCity(ctx, 'Kota Bandung')).toBe('32.73');
    expect(await areaForCity(ctx, 'Jakarta Selatan')).toBe('31.74');
    expect(await areaForCity(ctx, 'Jawa Timur')).toBe('35');
    expect(await areaForCity(ctx, 'Kampung Antah')).toBeNull();
    expect(await areaForCity(ctx, '  ')).toBeNull();
  });

  it('takes the city and postal code from the Zeiko Account at every sign-in', async () => {
    const { rt } = await setup();
    const me = async (s: Session) =>
      ((await (await s.req('GET', '/api/me')).json()) as { user: Record<string, unknown> }).user;
    const s = await signIn(rt, 'warga@example.com', { city: 'Bandung', postalCode: '40115' });
    expect(await me(s)).toMatchObject({
      adCity: 'Bandung',
      adPostalCode: '40115',
      adCityCode: '32.73',
      adAreaName: 'Kota Bandung',
    });
    // Drive does not edit it; the account does, and the next sign-in follows.
    expect((await s.req('PATCH', '/api/me', { adCityCode: '35.73' })).status).toBe(200);
    expect((await me(s)).adCityCode).toBe('32.73');
    const again = await signIn(rt, 'warga@example.com', { city: 'Atlantis', postalCode: '' });
    expect(await me(again)).toMatchObject({
      adCity: 'Atlantis',
      adPostalCode: null,
      adCityCode: null,
      adAreaName: null,
    });
    // An account with no city yet (older, or Google/GitHub) leaves what Drive had.
    rt.d1.sqlite
      .prepare(
        "UPDATE users SET ad_city = NULL, ad_postal_code = NULL, ad_city_code = '35.73' WHERE id = ?",
      )
      .run(s.userId);
    const old = await signIn(rt, 'warga@example.com', { city: '', postalCode: '' });
    expect(await me(old)).toMatchObject({ adCity: null, adCityCode: '35.73' });
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

describe('ad prices (ADR-043)', () => {
  it('charges per city up to a bundle, a bundle per ten cities, never more than nationwide', () => {
    const per = (n: number) => adCampaignPricePerDay(CONFIG_DEFAULTS, 'cities', n);
    expect([1, 2, 3, 10, 11, 12, 13, 20, 21, 40].map(per)).toEqual([
      1_000, 2_000, 3_000, 3_000, 4_000, 5_000, 6_000, 6_000, 7_000, 10_000,
    ]);
    expect(adCampaignPricePerDay(CONFIG_DEFAULTS, 'national', 0)).toBe(10_000);
  });
});

describe('ads entered by the operator and checked by hand (ADR-043)', () => {
  it('is the operator’s to enter; a word filter only flags; approving opens payment', async () => {
    const { rt } = await setup();
    const user = await signIn(rt, 'warung@example.com');
    expect((await user.req('GET', '/api/ops/ads/advertiser?email=warung@example.com')).status).toBe(
      404,
    );
    expect((await user.req('GET', '/api/advertiser')).status).toBe(200); // their own page, empty

    const op = operator(rt);
    const unknown = await op('GET', '/ads/advertiser?email=nobody@example.com');
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { message: string } }).error.message).toBe(
      'NO_DRIVE_USER',
    );

    // Every ad waits for a person, a suspicious one included: nothing is decided automatically.
    const bad = await placeAd(rt, op, {
      email: 'lain@example.com',
      kind: 'lainnya',
      title: 'Slot gacor maxwin',
    });
    const good = await placeAd(rt, op, { days: 3, areaCodes: ['35.73', '32.73'] });
    expect([bad.campaignStatus, good.campaignStatus]).toEqual(['pending', 'pending']);
    const queue = (await (await op('GET', '/ads?status=pending')).json()) as {
      items: Array<{
        id: string;
        flag: string | null;
        advertiserKind: string;
        waitingCampaigns: number;
      }>;
    };
    // UMKM, small businesses and students first, though this one came later.
    expect(queue.items.map((x) => x.id)).toEqual([good.creativeId, bad.creativeId]);
    expect(queue.items[1]).toMatchObject({ flag: 'judi/slot/togel', waitingCampaigns: 1 });
    expect(queue.items[0]!.flag).toBeNull();
    // The relay forwards JSON only: the picture under review comes back as a data URL.
    const pic = (await (await op('GET', `/ads/${good.creativeId}/image`)).json()) as {
      dataUrl: string;
    };
    expect(pic.dataUrl.startsWith('data:image/webp;base64,')).toBe(true);
    expect(Buffer.from(pic.dataUrl.split(',')[1]!, 'base64')).toEqual(Buffer.from(webp()));
    const notB64 = await op('PUT', `/ads/creatives/${good.creativeId}/image`, {
      advertiserId: good.advertiser.userId,
      imageBase64: '%%%',
    });
    expect(notB64.status).toBe(400);

    // Nothing is bought on the website, and no QRIS goes out before the check.
    expect(
      (
        await good.advertiser.req(
          'POST',
          `/api/advertiser/campaigns/${good.campaignId}/checkout`,
          {},
        )
      ).status,
    ).toBe(404);
    expect(
      rt.d1.sqlite.prepare('SELECT payment_id FROM ad_campaigns WHERE id = ?').get(good.campaignId),
    ).toEqual({
      payment_id: null,
    });

    await review(rt, bad.creativeId, 'reject', 'Judi');
    await review(rt, good.creativeId, 'approve');
    expect(status(rt, bad.campaignId)).toBe('rejected');
    expect(status(rt, good.campaignId)).toBe('awaiting_payment');
    const notice = (await noticesOf(rt, good.advertiser.userId)).filter(
      (n) => n.type === 'ad_status',
    );
    // Approval mails the QRIS itself (ADR-043): the amount, and a QR image Drive serves.
    const sent = notice.map((n) => JSON.parse(n.payload_json) as Record<string, unknown>);
    const mail = sent.find((n) => n.status === 'awaiting_payment')!;
    expect(mail).toMatchObject({ amountIdr: 6_000, startDate: TODAY });
    const qr = new URL(String(mail.qrUrl));
    const png = await rt.fetch(new Request(`${APP}${qr.pathname}${qr.search}`));
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect([...new Uint8Array(await png.arrayBuffer()).slice(0, 4)]).toEqual([
      0x89, 0x50, 0x4e, 0x47,
    ]);
    expect((await rt.fetch(new Request(`${APP}${qr.pathname}?t=forged`))).status).toBe(404);

    const dash = (await (await good.advertiser.req('GET', '/api/advertiser')).json()) as {
      campaigns: Array<{
        status: string;
        pricePerDayIdr: number;
        totalIdr: number;
        payIdr: number;
        areas: unknown[];
      }>;
    };
    expect(dash.campaigns[0]).toMatchObject({
      status: 'awaiting_payment',
      pricePerDayIdr: 2_000,
      totalIdr: 6_000,
      payIdr: 6_000,
    });
    expect(dash.campaigns[0]!.areas).toHaveLength(2);

    // An approved creative's next campaign waits for payment straight away; one never paid by its
    // first day expires that night.
    const again = await op('POST', '/ads/campaigns', {
      creativeId: good.creativeId,
      scope: 'national',
      startDate: TODAY,
      days: 1,
    });
    const k2 = (await again.json()) as {
      id: string;
      status: string;
      total_idr: number;
      payment_id: string | null;
    };
    expect(k2).toMatchObject({ status: 'awaiting_payment', total_idr: 10_000 });
    expect(k2.payment_id).not.toBeNull();
    expect(
      (
        await op('POST', '/ads/campaigns', {
          creativeId: good.creativeId,
          scope: 'cities',
          areaCodes: ['35'],
          startDate: TODAY,
          days: 1,
        })
      ).status,
    ).toBe(400); // a province is not a city
  });

  it('rotates every live ad for the viewer’s city and every national one, and counts per city', async () => {
    const { rt, clock } = await setup();
    const op = operator(rt);
    const city = await placeAd(rt, op, { days: 1 });
    const nation = await placeAd(rt, op, {
      email: 'besar@example.com',
      kind: 'lainnya',
      title: 'Toko Besar',
      scope: 'national',
      days: 2,
    });
    // Credit that covers it pays at approval; nothing to send.
    for (const x of [city, nation]) {
      fund(rt, x.advertiser.userId, 50_000);
      await review(rt, x.creativeId, 'approve');
      expect(status(rt, x.campaignId)).toBe('live');
    }

    // Malang sees both, the UMKM one twice as often; no slot limit; 15 seconds each.
    const malang = await rotationFor(rt, await viewerIn(rt, 'Malang'));
    expect(malang.rotateSeconds).toBe(15);
    const counts = malang.ads.reduce<Record<string, number>>(
      (m, a) => ((m[a.title] = (m[a.title] ?? 0) + 1), m),
      {},
    );
    expect(counts).toEqual({ 'Bakso Pak Kumis': 2, 'Toko Besar': 1 });
    const kumis = malang.ads.find((a) => a.title === 'Bakso Pak Kumis')!;
    expect(kumis).toMatchObject({ label: 'Iklan · Kota Malang', area: '35.73' });
    // Surabaya, and a visitor with no account, only get the national one.
    expect((await rotationFor(rt, await viewerIn(rt, 'Surabaya'))).ads.map((a) => a.title)).toEqual(
      ['Toko Besar'],
    );
    const anon = await rotationFor(rt);
    expect(anon.ads.map((a) => a.label)).toEqual(['Iklan · Indonesia']);

    // An impression needs its token; a click redirects to the CTA; both land per day and city.
    const beacon = (c: string, a: string, t: string) =>
      rt.fetch(
        new Request(`${APP}/ad/i`, {
          method: 'POST',
          body: JSON.stringify({ c, a, t }),
          headers: { 'content-type': 'application/json' },
        }),
      );
    expect((await beacon(kumis.campaignId!, '35.73', 'forged')).status).toBe(204);
    expect((await beacon(kumis.campaignId!, '32.73', kumis.token!)).status).toBe(204); // wrong city
    expect((await beacon(kumis.campaignId!, '35.73', kumis.token!)).status).toBe(204);
    const click = await rt.fetch(new Request(`${APP}${kumis.clickUrl}`, { redirect: 'manual' }));
    expect(click.status).toBe(302);
    expect(click.headers.get('location')).toBe('https://wa.me/6281234567890');
    expect(
      rt.d1.sqlite
        .prepare(
          'SELECT date, area_code, impressions, clicks FROM ad_campaign_stats WHERE campaign_id = ?',
        )
        .all(city.campaignId),
    ).toEqual([{ date: TODAY, area_code: '35.73', impressions: 1, clicks: 1 }]);
    const dash = (await (await city.advertiser.req('GET', '/api/advertiser')).json()) as {
      campaigns: Array<{
        impressions: number;
        clicks: number;
        ctr: number;
        byDay: unknown[];
        byArea: Array<{ name: string }>;
      }>;
    };
    expect(dash.campaigns[0]).toMatchObject({ impressions: 1, clicks: 1, ctr: 1 });
    expect(dash.campaigns[0]!.byArea[0]!.name).toBe('Kota Malang');

    // 00:05 WIB the next day: the one-day campaign completes, the national one keeps running.
    clock.set(Date.UTC(2026, 9, 10, 17, 6));
    await rt.runCron(CRON.dailyAds);
    expect([status(rt, city.campaignId), status(rt, nation.campaignId)]).toEqual([
      'completed',
      'live',
    ]);
    expect((await rotationFor(rt, await viewerIn(rt, 'Malang'))).ads.map((a) => a.title)).toEqual([
      'Toko Besar',
    ]);
  });

  it('pays by QRIS, expires what was never paid, and refunds the days a takedown leaves', async () => {
    const { rt, clock } = await setup();
    const op = operator(rt);
    const placed = await placeAd(rt, op, { days: 3 });
    const late = await placeAd(rt, op, {
      email: 'telat@example.com',
      startDate: addDaysWib(TODAY, 1),
      days: 1,
    });
    await review(rt, placed.creativeId, 'approve');
    await review(rt, late.creativeId, 'approve');
    // The QRIS from the approval email is paid; the gateway's word starts the campaign.
    const co = rt.d1.sqlite
      .prepare('SELECT payment_id, pay_amount_idr FROM ad_campaigns WHERE id = ?')
      .get(placed.campaignId) as { payment_id: string; pay_amount_idr: number };
    const signed = await MockPaymentProvider.signedBody(rt.env.PAYMENT_WEBHOOK_SECRET, {
      providerRef: `mock_${co.payment_id}`,
      status: 'paid',
      amountIdr: co.pay_amount_idr,
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
    expect(status(rt, placed.campaignId)).toBe('live');

    // Tomorrow 00:05 WIB the other one should have been paid by now; it is not, so it expires.
    clock.set(Date.UTC(2026, 9, 11, 17, 6));
    await rt.runCron(CRON.dailyAds);
    expect(status(rt, late.campaignId)).toBe('expired');
    const tooLate = await op('POST', `/ads/campaigns/${late.campaignId}/send-payment`, {});
    expect(tooLate.status).toBe(409);

    // Day 3 of 3 (12 Okt): a takedown gives back nothing shown yet, which is no days at all.
    const res = await op('POST', `/ads/${placed.creativeId}/suspend`, {
      severe: false,
      reason: 'Klaim menyesatkan',
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { refundedIdr: number }).refundedIdr).toBe(0);
    expect(status(rt, placed.campaignId)).toBe('suspended');
    expect((await rotationFor(rt, await viewerIn(rt, 'Malang'))).ads[0]!.internal).toBe(true);
    const audit = rt.d1.sqlite
      .prepare(`SELECT action FROM audit_logs WHERE target_id = ?`)
      .all(placed.creativeId);
    expect(audit).toContainEqual({ action: 'ad.suspend' });
  });

  it('a takedown before the last day refunds the days not shown as credit', async () => {
    const { rt } = await setup();
    const op = operator(rt);
    const placed = await placeAd(rt, op, { days: 3 });
    fund(rt, placed.advertiser.userId, 3_000);
    await review(rt, placed.creativeId, 'approve');
    expect(status(rt, placed.campaignId)).toBe('live');
    const res = await op('POST', `/ads/${placed.creativeId}/suspend`, {
      severe: false,
      reason: 'Klaim menyesatkan',
    });
    expect(((await res.json()) as { refundedIdr: number }).refundedIdr).toBe(2_000); // tomorrow and the day after
    expect(
      rt.d1.sqlite
        .prepare('SELECT balance_idr FROM wallets WHERE user_id = ?')
        .get(placed.advertiser.userId),
    ).toEqual({ balance_idr: 2_000 });
  });
});

describe('where ads never appear (SPEC §10.1)', () => {
  it('keeps download paths ad-free, respects plans.show_ads and the feature flag', async () => {
    const { rt } = await setup();
    const op = operator(rt);
    const placed = await placeAd(rt, op, { scope: 'national', days: 1 });
    fund(rt, placed.advertiser.userId, 100_000);
    await review(rt, placed.creativeId, 'approve');

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
    expect((await rotationFor(rt, owner)).ads).toEqual([]);
    expect(
      await (await rt.fetch(new Request(locked.share.url, { headers: ua }))).text(),
    ).not.toContain('Iklan ·');

    setConfig(rt, 'features', { ...(await createCtx(rt.env).config()).features, ads: false });
    expect((await rotationFor(rt)).ads).toEqual([]);
  });
});
