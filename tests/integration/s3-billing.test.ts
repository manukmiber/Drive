// Zeiko S3 billed after the month from usage (ADR-047): hourly storage samples, egress, bills on
// the 1st, paying them by QRIS or credit, and the dunning cycle for unpaid ones.
import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  PutBucketAclCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import type { DevRuntime } from '../../dev/env';
import { DAY_MS, HOUR_MS, MIB, WIB_OFFSET_MS, GIB } from '../../src/shared/constants';
import { FakeClock } from '../../src/worker/adapters/clock';
import { MockPaymentProvider } from '../../src/worker/adapters/payment';
import { createCtx } from '../../src/worker/context';
import { invalidateConfigMemo } from '../../src/worker/services/config';
import { issueS3Bills, runS3Dunning, sampleS3Storage } from '../../src/worker/services/s3-billing';
import { APP, makeRuntime } from '../helpers/runtime';
import { OPS_KEY, S3_ORIGIN, s3Setup } from '../helpers/s3';

/** UTC ms of a WIB wall-clock time. */
const wib = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h) - WIB_OFFSET_MS;

async function billingRuntime(start: number) {
  const clock = new FakeClock(start);
  const rt = await makeRuntime({ vars: { ZEIKO_OPS_TOKEN: OPS_KEY, S3_ORIGIN }, clock });
  const setup = await s3Setup({ rt, limitBytes: 10 * GIB, email: 'tagihan@zeiko.test' });
  return { ...setup, clock, ctx: () => createCtx(rt.env) };
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

function setUsage(
  rt: DevRuntime,
  userId: string,
  period: string,
  gibHours: number,
  egress: number,
) {
  rt.d1.sqlite
    .prepare(
      `INSERT INTO s3_usage (user_id, period, gib_hours, egress_bytes, last_hour, updated_at)
       VALUES (?, ?, ?, ?, 0, 0)
       ON CONFLICT (user_id, period) DO UPDATE SET gib_hours = excluded.gib_hours, egress_bytes = excluded.egress_bytes`,
    )
    .run(userId, period, gibHours, egress);
}

const usageRow = (rt: DevRuntime, userId: string, period: string) =>
  rt.d1.sqlite
    .prepare('SELECT gib_hours, egress_bytes FROM s3_usage WHERE user_id = ? AND period = ?')
    .get(userId, period) as { gib_hours: number; egress_bytes: number } | undefined;

type BillRow = {
  id: string;
  period: string;
  status: string;
  subtotal_idr: number;
  total_idr: number;
  due_at: number | null;
  carried_into: string | null;
  lines_json: string;
};
const bills = (rt: DevRuntime, userId: string) =>
  rt.d1.sqlite
    .prepare('SELECT * FROM s3_bills WHERE user_id = ? ORDER BY period')
    .all(userId) as BillRow[];

const state = (rt: DevRuntime, userId: string) =>
  rt.d1.sqlite
    .prepare('SELECT status, billing_state FROM s3_accounts WHERE user_id = ?')
    .get(userId) as { status: string; billing_state: string };

const notices = (rt: DevRuntime, userId: string, type: string) =>
  (
    rt.d1.sqlite
      .prepare(
        'SELECT payload_json FROM notifications WHERE user_id = ? AND type = ? ORDER BY created_at',
      )
      .all(userId, type) as Array<{ payload_json: string }>
  ).map((n) => JSON.parse(n.payload_json) as Record<string, unknown>);

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

// 10 GiB all November (720 hours) = Rp5.000; 2.5 MiB egress with 1 MiB free in 1 MiB blocks at
// Rp5.000 = 2 blocks = Rp10.000.
const SMALL_EGRESS = {
  s3_egress_free_bytes: MIB,
  s3_egress_block_bytes: MIB,
  s3_egress_block_idr: 5_000,
};

describe('Zeiko S3 billing (ADR-047)', () => {
  it('samples stored bytes by the hour and counts every byte served, also to strangers', async () => {
    const { rt, user, client, clock, ctx } = await billingRuntime(wib(2026, 11, 10, 9));
    await client.send(new CreateBucketCommand({ Bucket: 'meter' }));
    await client.send(
      new PutObjectCommand({ Bucket: 'meter', Key: 'a.bin', Body: new Uint8Array(MIB) }),
    );
    await rt.settle();

    expect(await sampleS3Storage(ctx())).toBe(1);
    await sampleS3Storage(ctx()); // the same hour again changes nothing
    expect(usageRow(rt, user.userId, '2026-11')?.gib_hours).toBeCloseTo(1 / 1024);
    clock.advance(HOUR_MS);
    await sampleS3Storage(ctx());
    // The cron missed four runs: the late sample stands for at most three hours.
    clock.advance(5 * HOUR_MS);
    await sampleS3Storage(ctx());
    expect(usageRow(rt, user.userId, '2026-11')?.gib_hours).toBeCloseTo(5 / 1024);

    const full = await client.send(new GetObjectCommand({ Bucket: 'meter', Key: 'a.bin' }));
    await full.Body!.transformToByteArray();
    const part = await client.send(
      new GetObjectCommand({ Bucket: 'meter', Key: 'a.bin', Range: 'bytes=0-99' }),
    );
    await part.Body!.transformToByteArray();
    await client.send(new HeadObjectCommand({ Bucket: 'meter', Key: 'a.bin' }));
    await client.send(new PutBucketAclCommand({ Bucket: 'meter', ACL: 'public-read' }));
    const anon = await rt.fetch(`${S3_ORIGIN}/meter/a.bin`);
    expect(anon.status).toBe(200);
    await anon.arrayBuffer();
    await rt.settle();
    expect(usageRow(rt, user.userId, '2026-11')?.egress_bytes).toBe(2 * MIB + 100);
  });

  it('bills last month on the 1st, once, and the bill is paid by QRIS', async () => {
    const { rt, user, clock, ctx } = await billingRuntime(wib(2026, 11, 20));
    setConfig(rt, SMALL_EGRESS);
    setUsage(rt, user.userId, '2026-11', 720 * 10, 2.5 * MIB);
    expect(await issueS3Bills(ctx())).toBe(0); // November is not over yet

    clock.set(wib(2026, 12, 1, 2));
    expect(await issueS3Bills(ctx())).toBe(1);
    expect(await issueS3Bills(ctx())).toBe(0);
    const [bill] = bills(rt, user.userId);
    expect(bill).toMatchObject({
      period: '2026-11',
      status: 'open',
      subtotal_idr: 15_000,
      total_idr: 15_000,
      due_at: wib(2026, 12, 1, 2) + 7 * DAY_MS,
    });
    expect(
      (JSON.parse(bill!.lines_json) as Array<{ kind: string; amountIdr: number }>).map((l) => [
        l.kind,
        l.amountIdr,
      ]),
    ).toEqual([
      ['storage', 5_000],
      ['egress', 10_000],
    ]);
    expect(notices(rt, user.userId, 's3_bill')).toEqual([
      expect.objectContaining({ period: '2026-11', totalIdr: 15_000, paid: false }),
    ]);

    const page = (await (await user.req('GET', '/api/s3')).json()) as {
      billing: { outstanding: { billIds: string[]; totalIdr: number }; bills: unknown[] };
    };
    expect(page.billing.outstanding).toMatchObject({ billIds: [bill!.id], totalIdr: 15_000 });

    const started = await user.req('POST', '/api/billing/checkout', {
      item: { kind: 's3_bills', billIds: page.billing.outstanding.billIds },
    });
    expect(started.status).toBe(201);
    const { payment } = (await started.json()) as {
      payment: { paymentId: string; amountIdr: number };
    };
    expect(payment.amountIdr).toBe(15_000);
    expect((await paidWebhook(rt, payment.paymentId, payment.amountIdr)).status).toBe(200);
    expect(bills(rt, user.userId)[0]).toMatchObject({ status: 'paid' });
    expect(
      rt.d1.sqlite
        .prepare(
          `SELECT reason, delta_idr FROM wallet_ledger WHERE user_id = ? ORDER BY created_at`,
        )
        .all(user.userId),
    ).toEqual([
      { reason: 'topup', delta_idr: 15_000 },
      { reason: 's3_bill', delta_idr: -15_000 },
    ]);
    // Paid once: the same bills cannot be bought again.
    expect(
      (
        await user.req('POST', '/api/billing/checkout', {
          item: { kind: 's3_bills', billIds: [bill!.id] },
        })
      ).status,
    ).toBe(409);
  });

  it('unpaid: read-only after 3 days, locked after 14; paying from credit opens it again', async () => {
    const { rt, user, client, clock, ctx } = await billingRuntime(wib(2026, 11, 20));
    setConfig(rt, SMALL_EGRESS);
    await client.send(new CreateBucketCommand({ Bucket: 'nunggak' }));
    await client.send(new PutObjectCommand({ Bucket: 'nunggak', Key: 'a.txt', Body: 'isi' }));
    await client.send(new PutBucketAclCommand({ Bucket: 'nunggak', ACL: 'public-read' }));
    await rt.settle();
    setUsage(rt, user.userId, '2026-11', 720 * 10, 0);
    clock.set(wib(2026, 12, 1, 2));
    await issueS3Bills(ctx());
    const due = bills(rt, user.userId)[0]!.due_at!;

    clock.set(due + 3 * DAY_MS + HOUR_MS);
    await runS3Dunning(ctx());
    expect(state(rt, user.userId)).toEqual({ status: 'active', billing_state: 'readonly' });
    expect(notices(rt, user.userId, 's3_dunning')).toEqual([
      expect.objectContaining({ stage: 'readonly', owedIdr: 5_000 }),
    ]);
    await expect(
      client.send(new PutObjectCommand({ Bucket: 'nunggak', Key: 'b.txt', Body: 'baru' })),
    ).rejects.toMatchObject({ name: 'AccountProblem', $metadata: { httpStatusCode: 403 } });
    const read = await client.send(new GetObjectCommand({ Bucket: 'nunggak', Key: 'a.txt' }));
    expect(await read.Body!.transformToString()).toBe('isi');
    expect((await rt.fetch(`${S3_ORIGIN}/nunggak/a.txt`)).status).toBe(403);
    const pub = await user.req('PATCH', '/api/s3/buckets/nunggak', { public: true });
    expect(pub.status).toBe(403);
    expect(((await pub.json()) as { error: { data?: { reason?: string } } }).error.data).toEqual({
      reason: 'AccountProblem',
    });

    clock.set(due + 14 * DAY_MS + HOUR_MS);
    await runS3Dunning(ctx());
    expect(state(rt, user.userId).billing_state).toBe('locked');
    await expect(client.send(new ListBucketsCommand({}))).rejects.toMatchObject({
      name: 'AccountProblem',
    });

    rt.d1.sqlite
      .prepare(`INSERT INTO wallets (user_id, balance_idr, updated_at) VALUES (?, 5000, 0)`)
      .run(user.userId);
    const paid = await user.req('POST', '/api/billing/checkout', {
      item: { kind: 's3_bills', billIds: [bills(rt, user.userId)[0]!.id] },
    });
    expect(paid.status).toBe(200);
    expect(state(rt, user.userId).billing_state).toBe('ok');
    await client.send(new PutObjectCommand({ Bucket: 'nunggak', Key: 'b.txt', Body: 'baru' }));
    await client.send(
      new DeleteObjectsCommand({
        Bucket: 'nunggak',
        Delete: { Objects: [{ Key: 'a.txt' }, { Key: 'b.txt' }] },
      }),
    );
  });

  it('deletes an account 30 days past due only when dunning_delete_mode is live', async () => {
    const { rt, user, clock, ctx } = await billingRuntime(wib(2026, 11, 20));
    setUsage(rt, user.userId, '2026-11', 720 * 10, 0);
    clock.set(wib(2026, 12, 1, 2));
    await issueS3Bills(ctx());
    const due = bills(rt, user.userId)[0]!.due_at!;
    clock.set(due + 30 * DAY_MS + HOUR_MS);
    const dry = await runS3Dunning(ctx());
    expect(dry.dryRun).toEqual([user.userId]);
    expect(state(rt, user.userId)).toEqual({ status: 'active', billing_state: 'locked' });

    setConfig(rt, { dunning_delete_mode: 'live' });
    expect((await runS3Dunning(ctx())).deleted).toBe(1);
    expect(rt.queues.CLEANUP_QUEUE.sent).toContainEqual({ type: 's3_purge', userId: user.userId });
    await rt.settle();
    expect(state(rt, user.userId)).toBeUndefined();
    // The debt stays on the books.
    expect(bills(rt, user.userId)[0]).toMatchObject({ status: 'open', total_idr: 5_000 });
  });

  it('carries a bill under the minimum into the next month; the operator can waive one', async () => {
    const { rt, user, clock, ctx, ops } = await billingRuntime(wib(2026, 11, 20));
    setUsage(rt, user.userId, '2026-11', 720 * 1, 0); // 1 GB-month: Rp500, under Rp1.000
    clock.set(wib(2026, 12, 1, 2));
    await issueS3Bills(ctx());
    expect(bills(rt, user.userId)[0]).toMatchObject({ status: 'carried', total_idr: 500 });
    expect(notices(rt, user.userId, 's3_bill')).toEqual([]);

    setUsage(rt, user.userId, '2026-12', 744 * 2, 0); // 2 GB-month in December: Rp1.000
    clock.set(wib(2027, 1, 1, 2));
    await issueS3Bills(ctx());
    const [nov, dec] = bills(rt, user.userId);
    expect(dec).toMatchObject({ status: 'open', subtotal_idr: 1_500, total_idr: 1_500 });
    expect(nov!.carried_into).toBe(dec!.id);
    expect((JSON.parse(dec!.lines_json) as Array<{ kind: string }>).map((l) => l.kind)).toEqual([
      'storage',
      'egress',
      'carried',
    ]);

    expect((await ops('POST', `/s3/bills/${dec!.id}/waive`, { reason: '' })).status).toBe(400);
    expect(
      (await ops('POST', `/s3/bills/${dec!.id}/waive`, { reason: 'bulan pertama gratis' })).status,
    ).toBe(204);
    expect(bills(rt, user.userId)[1]).toMatchObject({ status: 'waived' });
    const view = (await (await ops('GET', `/s3/accounts/${user.userId}`)).json()) as {
      billing: { outstanding: { totalIdr: number } };
    };
    expect(view.billing.outstanding.totalIdr).toBe(0);
  });
});
