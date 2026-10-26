// Zeiko S3 plans paid upfront (ADR-047): a size of at least 3 GB with 1 or 3 copies, changes,
// renewals with egress past the free allowance, three real copies, and plans not renewed.
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListBucketsCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import type { DevRuntime } from '../../dev/env';
import { DAY_MS, GIB, HOUR_MS, MIB, WIB_OFFSET_MS } from '../../src/shared/constants';
import { addBillingMonth } from '../../src/shared/time';
import { FakeClock } from '../../src/worker/adapters/clock';
import { MockPaymentProvider } from '../../src/worker/adapters/payment';
import { createCtx } from '../../src/worker/context';
import { invalidateConfigMemo } from '../../src/worker/services/config';
import {
  remindS3Renewals,
  renewS3FromCredit,
  renewS3Plan,
  runS3Dunning,
} from '../../src/worker/services/s3-billing';
import { APP, makeRuntime } from '../helpers/runtime';
import { OPS_KEY, S3_ORIGIN, s3Client } from '../helpers/s3';
import { signIn, type Session } from '../helpers/session';
import { noticesOf } from '../helpers/notices';

/** UTC ms of a WIB wall-clock time. */
const wib = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h) - WIB_OFFSET_MS;

async function runtime(start = wib(2026, 11, 1)) {
  const clock = new FakeClock(start);
  const rt = await makeRuntime({ vars: { ZEIKO_OPS_TOKEN: OPS_KEY, S3_ORIGIN }, clock });
  const user = await signIn(rt, 'paket@zeiko.test');
  return { rt, clock, user, ctx: () => createCtx(rt.env) };
}

function setConfig(rt: DevRuntime, values: Record<string, unknown>) {
  for (const [key, value] of Object.entries(values)) {
    rt.d1.sqlite
      .prepare(
        `INSERT INTO app_config (key, value_json, updated_by, updated_at) VALUES (?, ?, 'test', 0)
         ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
      )
      .run(key, JSON.stringify(value));
  }
  void rt.env.CONFIG_KV.delete('config:v1');
  invalidateConfigMemo(rt.env);
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

type Item = { kind: 's3_plan'; gb: number; replicas: number } | { kind: 's3_renew' };

async function checkout(s: Session, item: Item) {
  const res = await s.req('POST', '/api/billing/checkout', { item });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Buys by QRIS and pays it: what the QRIS asked for. */
async function buy(rt: DevRuntime, s: Session, item: Item): Promise<number> {
  const r = await checkout(s, item);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const { payment } = r.body as { payment: { paymentId: string; amountIdr: number } };
  expect((await paidWebhook(rt, payment.paymentId, payment.amountIdr)).status).toBe(200);
  return payment.amountIdr;
}

const sub = (rt: DevRuntime, userId: string) =>
  rt.d1.sqlite
    .prepare(
      'SELECT gb, replicas, next_gb, next_replicas, period_start, period_end FROM s3_subscriptions WHERE user_id = ?',
    )
    .get(userId) as
    | {
        gb: number;
        replicas: number;
        next_gb: number | null;
        next_replicas: number | null;
        period_start: number;
        period_end: number;
      }
    | undefined;

const account = (rt: DevRuntime, userId: string) =>
  rt.d1.sqlite
    .prepare('SELECT status, billing_state, limit_bytes FROM s3_accounts WHERE user_id = ?')
    .get(userId) as { status: string; billing_state: string; limit_bytes: number } | undefined;

const charges = (rt: DevRuntime, userId: string) =>
  (
    rt.d1.sqlite
      .prepare(
        `SELECT delta_idr FROM wallet_ledger WHERE user_id = ? AND reason = 's3_plan' ORDER BY created_at`,
      )
      .all(userId) as Array<{ delta_idr: number }>
  ).map((r) => -r.delta_idr);

const notices = async (rt: DevRuntime, userId: string, type: string) =>
  (await noticesOf(rt, userId)).filter((n) => n.type === type).map((n) => n.payload);

async function newKey(s: Session) {
  const res = await s.req('POST', '/api/s3/keys', { label: 'laptop' });
  expect(res.status).toBe(201);
  return ((await res.json()) as { key: { id: string; secret: string } }).key;
}

const blobKey = (rt: DevRuntime, userId: string, key: string) => {
  const row = rt.d1.sqlite
    .prepare('SELECT blob_id, replicated FROM s3_objects WHERE user_id = ? AND key = ?')
    .get(userId, key) as { blob_id: string; replicated: number };
  return { r2: `s3/${userId}/${row.blob_id}`, replicated: row.replicated };
};

describe('Zeiko S3 plans (ADR-047)', () => {
  it('buys at least 3 GB upfront by QRIS; the account starts with that much storage', async () => {
    const { rt, user } = await runtime();
    const page = (await (await user.req('GET', '/api/s3')).json()) as {
      enabled: boolean;
      plan: { prices: { minGb: number; perGbMonthIdr: number; perGbMonth3xIdr: number } };
    };
    expect(page.enabled).toBe(false);
    expect(page.plan.prices).toMatchObject({ minGb: 3, perGbMonthIdr: 500, perGbMonth3xIdr: 1500 });

    expect((await checkout(user, { kind: 's3_plan', gb: 2, replicas: 1 })).status).toBe(400);
    expect((await checkout(user, { kind: 's3_plan', gb: 3.5, replicas: 1 })).status).toBe(400);
    expect((await checkout(user, { kind: 's3_plan', gb: 3, replicas: 2 })).status).toBe(400);
    expect(await buy(rt, user, { kind: 's3_plan', gb: 3, replicas: 1 })).toBe(1_500);
    expect(account(rt, user.userId)).toEqual({
      status: 'active',
      billing_state: 'ok',
      limit_bytes: 3 * GIB,
    });
    const now = wib(2026, 11, 1);
    expect(sub(rt, user.userId)).toMatchObject({
      gb: 3,
      replicas: 1,
      period_start: now,
      period_end: addBillingMonth(now, 1),
    });
    expect(charges(rt, user.userId)).toEqual([1_500]);
    await newKey(user);
  });

  it('three copies: every object is in both replica buckets, a lost copy is read from another', async () => {
    const { rt, user } = await runtime();
    expect(await buy(rt, user, { kind: 's3_plan', gb: 3, replicas: 3 })).toBe(4_500);
    const client = s3Client(rt, await newKey(user));
    await client.send(new CreateBucketCommand({ Bucket: 'tiga-salinan' }));
    await client.send(
      new PutObjectCommand({ Bucket: 'tiga-salinan', Key: 'a.txt', Body: 'aman di tiga tempat' }),
    );
    await rt.settle();
    const { r2, replicated } = blobKey(rt, user.userId, 'a.txt');
    expect(replicated).toBe(1);
    expect(await rt.env.S3_REPLICA_A!.head(r2)).not.toBeNull();
    expect(await rt.env.S3_REPLICA_B!.head(r2)).not.toBeNull();

    await rt.env.BUCKET.delete(r2); // the first copy is lost
    const read = await client.send(new GetObjectCommand({ Bucket: 'tiga-salinan', Key: 'a.txt' }));
    expect(await read.Body!.transformToString()).toBe('aman di tiga tempat');

    await client.send(new DeleteObjectCommand({ Bucket: 'tiga-salinan', Key: 'a.txt' }));
    expect(await rt.env.S3_REPLICA_A!.head(r2)).toBeNull();
    expect(await rt.env.S3_REPLICA_B!.head(r2)).toBeNull();
  });

  it('a pricier plan starts now for the rest of the period, a cheaper one next period', async () => {
    const { rt, clock, user, ctx } = await runtime(wib(2026, 11, 1));
    await buy(rt, user, { kind: 's3_plan', gb: 10, replicas: 1 });
    clock.advance(15 * DAY_MS); // half of November
    // 20 GB costs Rp5.000 more a month: half of it for the half month left.
    expect(await buy(rt, user, { kind: 's3_plan', gb: 20, replicas: 1 })).toBe(2_500);
    expect(account(rt, user.userId)?.limit_bytes).toBe(20 * GIB);
    expect((await checkout(user, { kind: 's3_plan', gb: 20, replicas: 1 })).status).toBe(409);

    // Cheaper: from the next period, nothing to pay now.
    const later = await checkout(user, { kind: 's3_plan', gb: 4, replicas: 1 });
    expect(later.status).toBe(200);
    expect(sub(rt, user.userId)).toMatchObject({ gb: 20, next_gb: 4, next_replicas: 1 });
    expect(account(rt, user.userId)?.limit_bytes).toBe(20 * GIB);

    // Not smaller than what is stored.
    rt.d1.sqlite
      .prepare('UPDATE s3_accounts SET used_bytes = ? WHERE user_id = ?')
      .run(5 * GIB, user.userId);
    const tooSmall = await checkout(user, { kind: 's3_plan', gb: 4, replicas: 1 });
    expect(tooSmall.status).toBe(409);
    expect(tooSmall.body).toMatchObject({ error: { data: { reason: 'S3_TOO_SMALL' } } });
    rt.d1.sqlite
      .prepare('UPDATE s3_accounts SET used_bytes = 0 WHERE user_id = ?')
      .run(user.userId);

    // The renewal is the smaller plan's month.
    fund(rt, user.userId, 2_000);
    clock.set(sub(rt, user.userId)!.period_end - HOUR_MS);
    expect((await renewS3Plan(ctx(), user.userId)).kind).toBe('s3_renewed');
    expect(sub(rt, user.userId)).toMatchObject({ gb: 4, next_gb: null });
    expect(account(rt, user.userId)?.limit_bytes).toBe(4 * GIB);
    expect(charges(rt, user.userId)).toEqual([5_000, 2_500, 2_000]);
  });

  it('moving from 3 copies to 1 drops the extra copies at the renewal', async () => {
    const { rt, clock, user, ctx } = await runtime();
    await buy(rt, user, { kind: 's3_plan', gb: 3, replicas: 3 });
    const client = s3Client(rt, await newKey(user));
    await client.send(new CreateBucketCommand({ Bucket: 'turun' }));
    await client.send(new PutObjectCommand({ Bucket: 'turun', Key: 'b.txt', Body: 'isi' }));
    await rt.settle();
    const { r2 } = blobKey(rt, user.userId, 'b.txt');
    expect(await rt.env.S3_REPLICA_A!.head(r2)).not.toBeNull();

    expect((await checkout(user, { kind: 's3_plan', gb: 3, replicas: 1 })).status).toBe(200);
    fund(rt, user.userId, 1_500);
    clock.set(sub(rt, user.userId)!.period_end - HOUR_MS);
    await renewS3Plan(ctx(), user.userId);
    await rt.settle();
    expect(await rt.env.S3_REPLICA_A!.head(r2)).toBeNull();
    expect(await rt.env.S3_REPLICA_B!.head(r2)).toBeNull();
    expect(blobKey(rt, user.userId, 'b.txt').replicated).toBe(0);
    const read = await client.send(new GetObjectCommand({ Bucket: 'turun', Key: 'b.txt' }));
    expect(await read.Body!.transformToString()).toBe('isi');

    // Back to 3 copies now: what is there is copied again. The renewed month has not started yet,
    // so the difference is for all of it (Rp4.500 − Rp1.500), never more.
    expect(await buy(rt, user, { kind: 's3_plan', gb: 3, replicas: 3 })).toBe(3_000);
    await rt.settle();
    expect(await rt.env.S3_REPLICA_B!.head(r2)).not.toBeNull();
  });

  it('egress past the free allowance of an earlier period is added to a renewal, once', async () => {
    const { rt, clock, user, ctx } = await runtime();
    setConfig(rt, {
      s3_egress_free_bytes: MIB,
      s3_egress_block_bytes: MIB,
      s3_egress_block_idr: 5_000,
    });
    await buy(rt, user, { kind: 's3_plan', gb: 3, replicas: 1 });
    const client = s3Client(rt, await newKey(user));
    await client.send(new CreateBucketCommand({ Bucket: 'unduhan' }));
    await client.send(
      new PutObjectCommand({ Bucket: 'unduhan', Key: 'm.bin', Body: new Uint8Array(MIB) }),
    );
    await rt.settle();
    for (let i = 0; i < 3; i++) {
      const got = await client.send(new GetObjectCommand({ Bucket: 'unduhan', Key: 'm.bin' }));
      await got.Body!.transformToByteArray();
    }
    await rt.settle();
    const view = (await (await user.req('GET', '/api/s3')).json()) as {
      plan: { egress: { bytes: number; pendingIdr: number }; plan: { renewIdr: number } };
    };
    // 3 MiB served, 1 MiB free: 2 blocks, waiting while the period runs.
    expect(view.plan.egress).toMatchObject({ bytes: 3 * MIB, pendingIdr: 10_000 });
    expect(view.plan.plan.renewIdr).toBe(1_500);

    // Renewed early: the running period is not finished, so only the plan.
    fund(rt, user.userId, 1_500);
    clock.set(sub(rt, user.userId)!.period_end - DAY_MS);
    await renewS3Plan(ctx(), user.userId);
    expect(charges(rt, user.userId)).toEqual([1_500, 1_500]);

    // The next renewal brings that egress; only what the credit covers is taken now.
    clock.set(sub(rt, user.userId)!.period_end - DAY_MS);
    fund(rt, user.userId, 6_500);
    await renewS3Plan(ctx(), user.userId);
    expect(charges(rt, user.userId)).toEqual([1_500, 1_500, 6_500]);
    clock.set(sub(rt, user.userId)!.period_end - DAY_MS);
    fund(rt, user.userId, 20_000);
    await renewS3Plan(ctx(), user.userId);
    expect(charges(rt, user.userId)).toEqual([1_500, 1_500, 6_500, 6_500]);
    clock.set(sub(rt, user.userId)!.period_end - DAY_MS);
    await renewS3Plan(ctx(), user.userId);
    expect(charges(rt, user.userId)).toEqual([1_500, 1_500, 6_500, 6_500, 1_500]);
  });

  it('not renewed: reminders, read-only after 3 days, locked after 14; credit renews by itself', async () => {
    const { rt, clock, user, ctx } = await runtime();
    await buy(rt, user, { kind: 's3_plan', gb: 3, replicas: 1 });
    const client = s3Client(rt, await newKey(user));
    await client.send(new CreateBucketCommand({ Bucket: 'lupa' }));
    await client.send(new PutObjectCommand({ Bucket: 'lupa', Key: 'a.txt', Body: 'isi' }));
    await rt.settle();
    const end = sub(rt, user.userId)!.period_end;

    clock.set(end - 3 * DAY_MS + HOUR_MS);
    await remindS3Renewals(ctx());
    await remindS3Renewals(ctx());
    expect(await notices(rt, user.userId, 's3_reminder')).toEqual([
      expect.objectContaining({ days: 3, amountIdr: 1_500, creditCovers: false }),
    ]);

    clock.set(end + 3 * DAY_MS + HOUR_MS);
    await runS3Dunning(ctx());
    expect(account(rt, user.userId)?.billing_state).toBe('readonly');
    expect(await notices(rt, user.userId, 's3_dunning')).toEqual([
      expect.objectContaining({ stage: 'readonly' }),
    ]);
    await expect(
      client.send(new PutObjectCommand({ Bucket: 'lupa', Key: 'b.txt', Body: 'baru' })),
    ).rejects.toMatchObject({ name: 'AccountProblem', $metadata: { httpStatusCode: 403 } });
    const read = await client.send(new GetObjectCommand({ Bucket: 'lupa', Key: 'a.txt' }));
    expect(await read.Body!.transformToString()).toBe('isi');

    clock.set(end + 14 * DAY_MS + HOUR_MS);
    await runS3Dunning(ctx());
    expect(account(rt, user.userId)?.billing_state).toBe('locked');
    await expect(client.send(new ListBucketsCommand({}))).rejects.toMatchObject({
      name: 'AccountProblem',
    });

    // Renewing a plan that ran out starts it again from today.
    fund(rt, user.userId, 1_500);
    expect((await checkout(user, { kind: 's3_renew' })).status).toBe(200);
    expect(account(rt, user.userId)?.billing_state).toBe('ok');
    expect(sub(rt, user.userId)?.period_start).toBe(end + 14 * DAY_MS + HOUR_MS);
    await client.send(new PutObjectCommand({ Bucket: 'lupa', Key: 'b.txt', Body: 'baru' }));

    // Enough credit at the end of the month: renewed without anyone asking.
    fund(rt, user.userId, 1_500);
    clock.set(sub(rt, user.userId)!.period_end + HOUR_MS);
    expect(await renewS3FromCredit(ctx())).toBe(1);
    expect(sub(rt, user.userId)!.period_end).toBeGreaterThan(clock.now());
  });

  it('deletes an account 30 days after its plan ended, only when dunning_delete_mode is live', async () => {
    const { rt, clock, user, ctx } = await runtime();
    await buy(rt, user, { kind: 's3_plan', gb: 3, replicas: 1 });
    clock.set(sub(rt, user.userId)!.period_end + 30 * DAY_MS + HOUR_MS);
    expect((await runS3Dunning(ctx())).dryRun).toEqual([user.userId]);
    expect(account(rt, user.userId)?.status).toBe('active');

    setConfig(rt, { dunning_delete_mode: 'live' });
    expect((await runS3Dunning(ctx())).deleted).toBe(1);
    await rt.settle();
    expect(account(rt, user.userId)).toBeUndefined();
    expect(sub(rt, user.userId)).toBeUndefined();
  });
});
