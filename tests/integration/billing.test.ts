import { describe, expect, it } from 'vitest';
import { MockPaymentProvider } from '../../src/worker/adapters/payment';
import { ZeikoPaymentProvider } from '../../src/worker/adapters/zeiko';
import { FakeClock } from '../../src/worker/adapters/clock';
import { CRON, DAY_MS } from '../../src/shared/constants';
import { APP, makeRuntime } from '../helpers/runtime';
import { signIn, type Session } from '../helpers/session';
import { rootOf, simpleUpload, uploadText } from '../helpers/files';
import type { DevRuntime } from '../../dev/env';

const T0 = Date.UTC(2026, 9, 10, 3, 0); // 10 Okt 2026 10:00 WIB

async function setup(email = 'bayar@example.com') {
  const clock = new FakeClock(T0);
  const rt = await makeRuntime({ clock });
  const s = await signIn(rt, email);
  return { rt, s, clock };
}

const summary = async (s: Session) =>
  (await (await s.req('GET', '/api/billing')).json()) as {
    creditIdr: number;
    renewIdr: number | null;
    storage: { limitBytes: number };
    subscription: {
      planCode: string;
      nextPlanCode: string | null;
      status: string;
      periodEnd: number;
    } | null;
    pendingPayments: Array<{ id: string }>;
  };

async function webhook(
  rt: DevRuntime,
  event: { providerRef: string; status: string; amountIdr: number },
  signature?: string,
) {
  const signed = await MockPaymentProvider.signedBody(
    rt.env.PAYMENT_WEBHOOK_SECRET,
    event as never,
  );
  return rt.fetch(
    new Request(`${APP}/api/payments/webhook/mock`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mock-signature': signature ?? signed.signature,
      },
      body: signed.body,
    }),
  );
}

type Item = { kind: 'plan' | 'addon' | 'compress'; code: string } | { kind: 'renew' };
type Started = {
  status: 'payment';
  payment: { paymentId: string; amountIdr: number; qrString: string; checkoutUrl: string };
  creditUsedIdr: number;
};

/** Starts buying `item`: the QRIS it asks for (201), or the purchase made at once (200). */
async function checkout(s: Session, item: Item) {
  const res = await s.req('POST', '/api/billing/checkout', { item });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Buys `item` by QRIS and pays it (ADR-041). */
async function buy(rt: DevRuntime, s: Session, item: Item) {
  const r = await checkout(s, item);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const { payment } = r.body as unknown as Started;
  const ref = `mock_${payment.paymentId}`;
  expect(
    (await webhook(rt, { providerRef: ref, status: 'paid', amountIdr: payment.amountIdr })).status,
  ).toBe(200);
  return { ...payment, ref };
}

const ledgerSum = (rt: DevRuntime, userId: string) =>
  (
    rt.d1.sqlite
      .prepare('SELECT COALESCE(SUM(delta_idr), 0) AS s FROM wallet_ledger WHERE user_id = ?')
      .get(userId) as { s: number }
  ).s;

const notices = (rt: DevRuntime, userId: string) =>
  rt.d1.sqlite
    .prepare('SELECT type, payload_json FROM notifications WHERE user_id = ? ORDER BY created_at')
    .all(userId) as Array<{ type: string; payload_json: string }>;

describe('paying by QRIS, one purchase at a time (ADR-041)', () => {
  it('buys a plan by QRIS; webhook replay is idempotent and status only moves forward', async () => {
    const { rt, s } = await setup();
    const root = await rootOf(s);
    expect((await simpleUpload(s, root, 'a.txt', 'a')).status).toBe(413);
    const started = await checkout(s, { kind: 'plan', code: 'mini' });
    expect(started.status).toBe(201);
    const { payment } = started.body as unknown as Started;
    expect(payment.amountIdr).toBe(1_000);
    expect(payment.qrString).toContain('QRIS');
    // Nothing is bought until the money arrives.
    expect((await summary(s)).subscription).toBeNull();
    expect((await summary(s)).pendingPayments.map((p) => p.id)).toEqual([payment.paymentId]);
    const status = async () =>
      ((await (await s.req('GET', `/api/billing/payments/${payment.paymentId}`)).json()) as {
        status: string;
      }).status;
    expect(await status()).toBe('pending');

    const ref = `mock_${payment.paymentId}`;
    expect((await webhook(rt, { providerRef: ref, status: 'paid', amountIdr: 1_000 })).status).toBe(
      200,
    );
    expect(await status()).toBe('paid');
    let sum = await summary(s);
    expect(sum.subscription).toMatchObject({ planCode: 'mini', status: 'active' });
    expect(sum.subscription?.periodEnd).toBe(Date.UTC(2026, 10, 10, 3, 0));
    expect(sum.storage.limitBytes).toBe(3 * 2 ** 30);
    expect(sum.creditIdr).toBe(0);
    // Replays and backwards transitions change nothing; the payment in and the purchase out net to 0.
    await webhook(rt, { providerRef: ref, status: 'paid', amountIdr: 1_000 });
    await webhook(rt, { providerRef: ref, status: 'failed', amountIdr: 1_000 });
    sum = await summary(s);
    expect(sum.subscription?.planCode).toBe('mini');
    expect(sum.creditIdr).toBe(0);
    expect(ledgerSum(rt, s.userId)).toBe(0);
    // Forged signature
    expect(
      (await webhook(rt, { providerRef: ref, status: 'refunded', amountIdr: 1_000 }, 'bogus'))
        .status,
    ).toBe(401);

    await uploadText(s, root, 'a.txt', 'a');
    const credits = rt.d1.sqlite
      .prepare(
        "SELECT SUM(remaining) AS n FROM credit_ledger WHERE user_id = ? AND source = 'plan'",
      )
      .get(s.userId) as { n: number };
    expect(credits.n).toBe(50);

    // A receipt that says what was bought; no invoice is sent or shown, but the books keep one.
    await rt.settle();
    const types = notices(rt, s.userId).map((n) => n.type);
    expect(types).toContain('payment_paid');
    expect(types).not.toContain('invoice');
    const paid = notices(rt, s.userId).find((n) => n.type === 'payment_paid')!;
    expect(JSON.parse(paid.payload_json)).toMatchObject({ amountIdr: 1_000, summary: 'Paket Mini aktif.' });
    expect(rt.d1.sqlite.prepare('SELECT number FROM invoices WHERE user_id = ?').get(s.userId)).toEqual({
      number: 'ZK-202610-000001',
    });
    expect((await s.req('GET', '/api/billing/ledger')).status).toBe(404);
    expect((await s.req('GET', '/api/billing/invoices')).status).toBe(404);
    expect((await s.req('POST', '/api/billing/topups', { amountIdr: 20_000 })).status).toBe(404);
  });

  it('ignores a wrong amount; what a payment leaves is credit, and credit pays without a QRIS', async () => {
    const { rt, s, clock } = await setup();
    const pack = await checkout(s, { kind: 'compress', code: 'kompres_100' });
    const { payment } = pack.body as unknown as Started;
    expect(payment.amountIdr).toBe(2_000);
    await webhook(rt, { providerRef: `mock_${payment.paymentId}`, status: 'paid', amountIdr: 1 });
    expect((await summary(s)).pendingPayments).toHaveLength(1);
    expect(ledgerSum(rt, s.userId)).toBe(0);

    // The operator's minimum is higher than a Mini plan: the rest stays as credit.
    const { setConfig } = await import('../../src/worker/services/config');
    await setConfig(
      rt.env,
      'payment_methods',
      [{ code: 'qris', label: 'QRIS', min_idr: 10_000, fee_flat_idr: 0, fee_pct: 0.7, active: true }],
      s.userId,
      clock.now(),
    );
    const mini = await buy(rt, s, { kind: 'plan', code: 'mini' });
    expect(mini.amountIdr).toBe(10_000);
    expect((await summary(s)).creditIdr).toBe(9_000);
    const done = await checkout(s, { kind: 'compress', code: 'kompres_500' });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'done', done: { kind: 'compress' } });
    expect((await summary(s)).creditIdr).toBe(2_000);
    // Part of the next price: the QRIS asks only the rest, and says so.
    const next = await checkout(s, { kind: 'compress', code: 'kompres_1500' });
    expect(next.body).toMatchObject({ status: 'payment', creditUsedIdr: 2_000 });
    expect((next.body as unknown as Started).payment.amountIdr).toBe(16_000);
  });

  it('mock checkout page simulates payment outside production', async () => {
    const { rt, s } = await setup();
    const { payment } = (await checkout(s, { kind: 'plan', code: 'basic' })).body as unknown as Started;
    const pageRes = await rt.fetch(new Request(payment.checkoutUrl));
    expect(await pageRes.text()).toContain('Simulasi pembayaran');
    const paid = await rt.fetch(
      new Request(payment.checkoutUrl, {
        method: 'POST',
        body: new URLSearchParams({ status: 'paid' }),
      }),
    );
    expect(paid.status).toBe(303);
    expect((await summary(s)).subscription?.planCode).toBe('basic');
  });
});

describe('plans (SPEC §12.4)', () => {
  it('upgrade pays the pro-rata difference; downgrade waits; nothing renews by itself', async () => {
    const { rt, s, clock } = await setup();
    await buy(rt, s, { kind: 'plan', code: 'basic' }); // 5.000
    clock.advance(15 * DAY_MS); // 16 of a 31-day period left
    const up = await buy(rt, s, { kind: 'plan', code: 'plus' });
    expect(up.amountIdr).toBe(Math.ceil((20_000 * 16) / 31));
    expect((await summary(s)).storage.limitBytes).toBe(120 * 2 ** 30);
    const down = await checkout(s, { kind: 'plan', code: 'mini' });
    expect(down).toMatchObject({ status: 200, body: { status: 'done', done: { kind: 'downgrade_scheduled' } } });
    let sum = await summary(s);
    expect(sum.subscription).toMatchObject({ planCode: 'plus', nextPlanCode: 'mini' });

    // The period ends unpaid: grace, not a charge.
    clock.set(sum.subscription!.periodEnd + 1);
    await rt.runCron('0 * * * *');
    sum = await summary(s);
    expect(sum.subscription?.status).toBe('grace');
    expect(sum.renewIdr).toBe(1_000); // the plan it was moving to
    await buy(rt, s, { kind: 'renew' });
    sum = await summary(s);
    expect(sum.subscription).toMatchObject({ planCode: 'mini', nextPlanCode: null, status: 'active' });
    expect(sum.storage.limitBytes).toBe(3 * 2 ** 30);
  });

  it('renewing early runs on from the end of the period, add-ons included; reminders ask to pay', async () => {
    const { rt, s, clock } = await setup();
    expect((await checkout(s, { kind: 'addon', code: 'addon_10' })).status).toBe(409); // no plan
    await buy(rt, s, { kind: 'plan', code: 'basic' });
    const addon = await buy(rt, s, { kind: 'addon', code: 'addon_10' });
    expect(addon.amountIdr).toBe(5_000);
    let sum = await summary(s);
    expect(sum.storage.limitBytes).toBe(30 * 2 ** 30);
    expect(sum.renewIdr).toBe(10_000);
    const end = sum.subscription!.periodEnd;

    clock.set(end - 3 * DAY_MS + 60_000);
    await rt.runCron(CRON.nightly);
    await rt.settle();
    const reminder = notices(rt, s.userId).find((n) => n.type === 'billing_reminder');
    expect(JSON.parse(reminder!.payload_json)).toMatchObject({ days: 3, amountIdr: 10_000, creditIdr: 0 });

    const renew = await buy(rt, s, { kind: 'renew' });
    expect(renew.amountIdr).toBe(10_000);
    sum = await summary(s);
    expect(sum.subscription).toMatchObject({ status: 'active', periodEnd: Date.UTC(2026, 11, 10, 3, 0) });
    expect(sum.storage.limitBytes).toBe(30 * 2 ** 30);
    clock.set(end + 1);
    await rt.runCron('0 * * * *');
    expect((await summary(s)).subscription?.status).toBe('active'); // already paid
  });
});

describe('dunning cycle with a fake clock (SPEC §12.5)', () => {
  it('grace → readonly → suspended → delete (dry-run first, then live)', async () => {
    const { rt, s, clock } = await setup();
    await buy(rt, s, { kind: 'plan', code: 'mini' });
    const root = await rootOf(s);
    const f = await uploadText(s, root, 'penting.txt', 'data');
    await rt.settle();
    let sum = await summary(s);
    const due = sum.subscription!.periodEnd;

    clock.set(due + 1);
    await rt.runCron('0 * * * *');
    expect((await summary(s)).subscription?.status).toBe('grace');
    await rt.settle();
    expect(notices(rt, s.userId).map((m) => m.type)).toContain('renewal_failed');

    clock.set(due + 3 * DAY_MS + 1);
    await rt.runCron('0 19 * * *');
    expect((await summary(s)).subscription?.status).toBe('readonly');
    expect((await simpleUpload(s, root, 'b.txt', 'b')).status).toBe(403);
    expect((await s.req('POST', '/api/shares', { nodeIds: [f.id] })).status).toBe(403);
    expect((await s.req('GET', `/api/files/${f.id}/download`)).status).toBe(200); // download still allowed

    clock.set(due + 30 * DAY_MS + 1);
    await rt.runCron('0 19 * * *');
    expect((await summary(s)).subscription?.status).toBe('suspended');
    expect((await s.req('GET', `/api/files/${f.id}/download`)).status).toBe(403);

    clock.set(due + 37 * DAY_MS + 1);
    await rt.runCron('0 19 * * *');
    expect((await summary(s)).subscription?.status).toBe('suspended'); // dry-run by default
    const audit = () =>
      (
        rt.d1.sqlite
          .prepare(
            "SELECT action FROM audit_logs WHERE action LIKE 'dunning.%' ORDER BY created_at",
          )
          .all() as Array<{ action: string }>
      ).map((a) => a.action);
    expect(audit()).toEqual(['dunning.delete.dry_run']);
    expect(rt.d1.sqlite.prepare('SELECT COUNT(*) AS n FROM nodes WHERE id = ?').get(f.id)).toEqual({
      n: 1,
    });

    const { setConfig } = await import('../../src/worker/services/config');
    await setConfig(rt.env, 'dunning_delete_mode', 'live', s.userId, clock.now());
    clock.advance(DAY_MS);
    await rt.runCron('0 19 * * *');
    await rt.settle();
    sum = await summary(s);
    expect(sum.subscription).toBeNull(); // deleted subscriptions are no longer live
    expect(audit()).toEqual(['dunning.delete.dry_run', 'dunning.delete.live']);
    expect(rt.d1.sqlite.prepare('SELECT COUNT(*) AS n FROM nodes WHERE id = ?').get(f.id)).toEqual({
      n: 0,
    });
  });

  it('paying while overdue restores everything from today', async () => {
    const { rt, s, clock } = await setup();
    await buy(rt, s, { kind: 'plan', code: 'mini' });
    const due = (await summary(s)).subscription!.periodEnd;
    clock.set(due + 31 * DAY_MS);
    await rt.runCron('0 * * * *');
    await rt.runCron('0 19 * * *');
    expect((await summary(s)).subscription?.status).toBe('suspended');
    expect((await summary(s)).renewIdr).toBe(1_000);
    await buy(rt, s, { kind: 'renew' });
    const sum = await summary(s);
    expect(sum.subscription).toMatchObject({ status: 'active', planCode: 'mini' });
    expect(sum.subscription!.periodEnd).toBeGreaterThan(clock.now() + 27 * DAY_MS);
    await rt.settle();
    const paid = notices(rt, s.userId).filter((n) => n.type === 'payment_paid').pop()!;
    expect(JSON.parse(paid.payload_json)).toMatchObject({ summary: 'Paketmu aktif lagi.' });
  });
});

describe('paying through Zeiko Accounts (ADR-036)', () => {
  const OPS = 'ops-key-for-tests-0123456789abcdef';
  const vars = {
    ADAPTER_PAYMENT: 'zeiko',
    ZEIKO_DOOR_URL: 'https://door.test',
    ZEIKO_SITE_URL: 'https://site.test',
    ZEIKO_APP_TOKEN: 'app-token-for-tests-0123456789abcd',
    ZEIKO_OPS_TOKEN: OPS,
  };

  it('keeps the QRIS code as credit — once', async () => {
    const opened: unknown[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('https://door.test/')) {
        opened.push(JSON.parse(String(init?.body)));
        return Response.json({
          id: 'pay_zk1',
          payUrl: 'https://site.test/account/pay?id=pay_zk1',
          amountIdr: 25_123,
          expiresAt: T0 + 3_600_000,
        });
      }
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      const clock = new FakeClock(T0);
      const rt = await makeRuntime({ clock, vars });
      const s = await signIn(rt, 'qris@example.com');
      const r = await checkout(s, { kind: 'plan', code: 'plus' });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect((r.body as unknown as Started).payment).toMatchObject({
        amountIdr: 25_123,
        checkoutUrl: 'https://site.test/account/pay?id=pay_zk1',
      });
      expect(opened[0]).toMatchObject({ accountId: 'zk_qris_example_com', amountIdr: 25_000, method: 'qris' });

      const callback = async (body: Record<string, unknown>, key = OPS) =>
        rt.fetch(
          await ZeikoPaymentProvider.signedRequest(`${APP}/api/payments/webhook/zeiko`, key, body, clock.now()),
        );
      const paid = { event: 'paid', id: 'pay_zk1', status: 'paid', amountIdr: 25_123 };
      expect((await callback(paid, 'wrong-key')).status).toBe(401);
      expect((await callback(paid)).status).toBe(200);
      expect((await callback(paid)).status).toBe(200); // the relay retries; nothing doubles
      const sum = await summary(s);
      expect(sum.subscription?.planCode).toBe('plus');
      expect(sum.creditIdr).toBe(123);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('asks the door about a payment whose callback never came', async () => {
    let paid = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === 'https://door.test/apps/v1/payments')
        return Response.json({ id: 'pay_zk2', payUrl: 'https://x.test', amountIdr: 50_000 });
      if (url === 'https://door.test/apps/v1/payments/pay_zk2')
        return Response.json({ id: 'pay_zk2', status: paid ? 'paid' : 'pending', amountIdr: 50_000 });
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      const clock = new FakeClock(T0);
      const rt = await makeRuntime({ clock, vars });
      const s = await signIn(rt, 'lost@example.com');
      const r = await checkout(s, { kind: 'plan', code: 'pro' });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      clock.advance(5 * 60_000);
      await rt.runCron(CRON.hourly);
      expect((await summary(s)).subscription).toBeNull(); // still open at the door
      paid = true;
      clock.advance(60 * 60_000);
      await rt.runCron(CRON.hourly);
      expect((await summary(s)).subscription?.planCode).toBe('pro');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
