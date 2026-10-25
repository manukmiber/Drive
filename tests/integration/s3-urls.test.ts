// Zeiko S3 addresses of their own (ADR-048): s3.<name>.<zone> for Rp3.000 or the person's own
// domain for Rp5.000, bought once while a plan is active, answering for that account only, and
// released when the plan goes unpaid for s3_url_release_days.
import {
  CreateBucketCommand,
  GetObjectCommand,
  ListBucketsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import type { DevRuntime } from '../../dev/env';
import { DAY_MS, WIB_OFFSET_MS } from '../../src/shared/constants';
import { FakeClock } from '../../src/worker/adapters/clock';
import { MockPaymentProvider } from '../../src/worker/adapters/payment';
import { createCtx } from '../../src/worker/context';
import { refreshPendingUrls, releaseLapsedUrls } from '../../src/worker/services/s3-urls';
import { APP, makeRuntime } from '../helpers/runtime';
import { OPS_KEY, RuntimeHandler, S3_ORIGIN, s3Client } from '../helpers/s3';
import { signIn, type Session } from '../helpers/session';

const wib = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) - WIB_OFFSET_MS;

async function runtime() {
  const clock = new FakeClock(wib(2026, 11, 1));
  const rt = await makeRuntime({
    vars: {
      ZEIKO_OPS_TOKEN: OPS_KEY,
      S3_ORIGIN,
      S3_SUBDOMAIN_SUFFIX: 'zeiko.test',
      S3_CNAME_TARGET: 'custom-s3.zeiko.test',
    },
    clock,
  });
  return { rt, clock, ctx: () => createCtx(rt.env) };
}

function fund(rt: DevRuntime, userId: string, idr: number) {
  rt.d1.sqlite
    .prepare(
      `INSERT INTO wallets (user_id, balance_idr, updated_at) VALUES (?, ?, 0)
       ON CONFLICT (user_id) DO UPDATE SET balance_idr = excluded.balance_idr`,
    )
    .run(userId, idr);
}

async function paidWebhook(rt: DevRuntime, paymentId: string, amountIdr: number) {
  const signed = await MockPaymentProvider.signedBody(rt.env.PAYMENT_WEBHOOK_SECRET, {
    providerRef: `mock_${paymentId}`,
    status: 'paid',
    amountIdr,
  } as never);
  return rt.fetch(
    new Request(`${APP}/api/payments/webhook/mock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mock-signature': signed.signature },
      body: signed.body,
    }),
  );
}

type UrlReq = { type: 'zeiko'; name: string } | { type: 'custom'; hostname: string };

async function checkout(s: Session, item: unknown) {
  const res = await s.req('POST', '/api/billing/checkout', { item });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Pays by QRIS; returns what the QRIS asked for. */
async function buy(rt: DevRuntime, s: Session, item: unknown): Promise<number> {
  const r = await checkout(s, item);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const { payment } = r.body as { payment: { paymentId: string; amountIdr: number } };
  expect((await paidWebhook(rt, payment.paymentId, payment.amountIdr)).status).toBe(200);
  return payment.amountIdr;
}

/** A person with a 3 GB plan and an access key. */
async function customer(rt: DevRuntime, email: string) {
  const user = await signIn(rt, email);
  await buy(rt, user, { kind: 's3_plan', gb: 3, replicas: 1 });
  const created = await user.req('POST', '/api/s3/keys', { label: 'laptop' });
  expect(created.status).toBe(201);
  const key = ((await created.json()) as { key: { id: string; secret: string } }).key;
  return { user, key };
}

function clientAt(rt: DevRuntime, endpoint: string, key: { id: string; secret: string }) {
  return new S3Client({
    region: 'auto',
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: key.id, secretAccessKey: key.secret },
    requestHandler: new RuntimeHandler(rt) as never,
    maxAttempts: 1,
  });
}

const reason = (body: Record<string, unknown>) =>
  (body.error as { data?: { reason?: string } } | undefined)?.data?.reason;

async function overviewUrl(s: Session) {
  const res = await s.req('GET', '/api/s3');
  return ((await res.json()) as { url: Record<string, unknown> | null }).url;
}

describe('own Zeiko S3 addresses', () => {
  it('sells s3.<name>.<zone> for Rp3.000 and answers there for its owner only', async () => {
    const { rt } = await runtime();
    const budi = await customer(rt, 'budi@zeiko.test');
    const sari = await customer(rt, 'sari@zeiko.test');

    const url: UrlReq = { type: 'zeiko', name: 'tokobudi' };
    expect(await buy(rt, budi.user, { kind: 's3_url', url })).toBe(3_000);
    expect(await overviewUrl(budi.user)).toMatchObject({
      hostname: 's3.tokobudi.zeiko.test',
      kind: 'zeiko',
      status: 'active',
      url: 'https://s3.tokobudi.zeiko.test',
    });

    // Budi's key works on his own address, path-style, exactly like the shared endpoint.
    const own = clientAt(rt, 'https://s3.tokobudi.zeiko.test', budi.key);
    await own.send(new CreateBucketCommand({ Bucket: 'toko-budi' }));
    await own.send(new PutObjectCommand({ Bucket: 'toko-budi', Key: 'a.txt', Body: 'halo' }));
    const got = await own.send(new GetObjectCommand({ Bucket: 'toko-budi', Key: 'a.txt' }));
    expect(await got.Body!.transformToString()).toBe('halo');
    // …and the same bucket is still there on the shared endpoint.
    const shared = await s3Client(rt, budi.key).send(new ListBucketsCommand({}));
    expect(shared.Buckets?.map((b) => b.Name)).toEqual(['toko-budi']);

    // Sari's key is refused there, and her buckets don't exist there.
    await s3Client(rt, sari.key).send(new CreateBucketCommand({ Bucket: 'punya-sari' }));
    const intruder = clientAt(rt, 'https://s3.tokobudi.zeiko.test', sari.key);
    await expect(intruder.send(new ListBucketsCommand({}))).rejects.toMatchObject({
      name: 'AccessDenied',
    });
    await expect(
      own.send(new PutObjectCommand({ Bucket: 'punya-sari', Key: 'x', Body: 'x' })),
    ).rejects.toMatchObject({ name: 'NoSuchBucket' });

    // The name is Budi's now, and one address per account.
    const taken = await checkout(sari.user, { kind: 's3_url', url });
    expect([taken.status, reason(taken.body)]).toEqual([409, 'URL_TAKEN']);
    fund(rt, budi.user.userId, 10_000);
    const second = await checkout(budi.user, {
      kind: 's3_url',
      url: { type: 'zeiko', name: 'budi-lain' },
    });
    expect([second.status, reason(second.body)]).toEqual([409, 'URL_EXISTS']);

    // An address nobody has is just the app's (no S3 there).
    const stray = await rt.fetch(new Request('https://s3.siapa.zeiko.test/'));
    expect(stray.headers.get('x-amz-request-id')).toBeNull();
  });

  it('refuses without a plan, names kept for Zeiko, and names that are not names', async () => {
    const { rt } = await runtime();
    const tanpa = await signIn(rt, 'tanpa@zeiko.test');
    fund(rt, tanpa.userId, 10_000);
    const noPlan = await checkout(tanpa, { kind: 's3_url', url: { type: 'zeiko', name: 'abc' } });
    expect([noPlan.status, reason(noPlan.body)]).toEqual([409, 'NO_PLAN']);

    const { user } = await customer(rt, 'coba@zeiko.test');
    for (const [url, why] of [
      [{ type: 'zeiko', name: 'drive' }, 'URL_RESERVED'],
      [{ type: 'zeiko', name: 'zeiko-resmi' }, 'URL_RESERVED'],
      [{ type: 'zeiko', name: 'ab' }, 'URL_INVALID'],
      [{ type: 'zeiko', name: 'Toko_Budi' }, 'URL_INVALID'],
      [{ type: 'zeiko', name: '-toko' }, 'URL_INVALID'],
      [{ type: 'custom', hostname: 'tokobudi.com' }, 'URL_INVALID'],
      [{ type: 'custom', hostname: 's3.palsu.zeiko.test' }, 'URL_INVALID'],
      [{ type: 'custom', hostname: 'drive.zeiko.test' }, 'URL_INVALID'],
    ] as const) {
      const r = await checkout(user, { kind: 's3_url', url });
      expect([r.status, reason(r.body)], JSON.stringify(url)).toEqual([400, why]);
    }
    expect(rt.d1.sqlite.prepare('SELECT COUNT(*) AS n FROM s3_urls').get()).toEqual({ n: 0 });
  });

  it('sells a domain of their own for Rp5.000: pending until its CNAME is in place', async () => {
    const { rt, ctx } = await runtime();
    const { user, key } = await customer(rt, 'domain@zeiko.test');
    fund(rt, user.userId, 5_000);
    const r = await checkout(user, {
      kind: 's3_url',
      url: { type: 'custom', hostname: 'S3.TokoBudi.com.' },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.done).toMatchObject({ kind: 's3_url', chargedIdr: 5_000 });
    expect(await overviewUrl(user)).toMatchObject({
      hostname: 's3.tokobudi.com',
      kind: 'custom',
      status: 'pending',
      records: [{ type: 'CNAME', name: 's3.tokobudi.com', value: 'custom-s3.zeiko.test' }],
    });

    // The mock sees the CNAME the next time it is asked (here: the hourly task).
    await refreshPendingUrls(ctx());
    expect(await overviewUrl(user)).toMatchObject({ status: 'active' });
    const own = clientAt(rt, 'https://s3.tokobudi.com', key);
    await own.send(new CreateBucketCommand({ Bucket: 'arsip' }));
    expect((await own.send(new ListBucketsCommand({}))).Buckets?.map((b) => b.Name)).toEqual([
      'arsip',
    ]);

    // Let go by its owner: gone, not refunded, and the name is free again.
    expect((await user.req('DELETE', '/api/s3/url')).status).toBe(204);
    expect(await overviewUrl(user)).toBeNull();
    const after = await rt.fetch(new Request('https://s3.tokobudi.com/'));
    expect(after.headers.get('x-amz-request-id')).toBeNull();
    const balance = rt.d1.sqlite
      .prepare('SELECT balance_idr FROM wallets WHERE user_id = ?')
      .get(user.userId) as { balance_idr: number };
    expect(balance.balance_idr).toBe(0);
  });

  it('keeps the address while the plan is renewed, releases it after a month unpaid', async () => {
    const { rt, clock, ctx } = await runtime();
    const { user } = await customer(rt, 'telat@zeiko.test');
    await buy(rt, user, { kind: 's3_url', url: { type: 'zeiko', name: 'telat' } });
    const end = (
      rt.d1.sqlite
        .prepare('SELECT period_end FROM s3_subscriptions WHERE user_id = ?')
        .get(user.userId) as { period_end: number }
    ).period_end;

    // Unpaid, but not yet for a month: still there.
    clock.set(end + 29 * DAY_MS);
    expect(await releaseLapsedUrls(ctx())).toBe(0);
    expect(await overviewUrl(user)).toMatchObject({ hostname: 's3.telat.zeiko.test' });

    // A month unpaid: released, the person is told, and it has to be bought again.
    clock.set(end + 30 * DAY_MS + 1);
    expect(await releaseLapsedUrls(ctx())).toBe(1);
    expect(rt.d1.sqlite.prepare('SELECT COUNT(*) AS n FROM s3_urls').get()).toEqual({ n: 0 });
    const told = rt.d1.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND type = ?`)
      .get(user.userId, 's3_url_released') as { n: number };
    expect(told.n).toBe(1);

    await buy(rt, user, { kind: 's3_renew' });
    expect(await buy(rt, user, { kind: 's3_url', url: { type: 'zeiko', name: 'telat' } })).toBe(
      3_000,
    );
  });
});
