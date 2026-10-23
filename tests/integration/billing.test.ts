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
    balanceIdr: number;
    storage: { limitBytes: number };
    subscription: {
      planCode: string;
      nextPlanCode: string | null;
      status: string;
      periodEnd: number;
    } | null;
    paymentMethods: Array<{ code: string }>;
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

async function topup(rt: DevRuntime, s: Session, amountIdr: number) {
  const res = await s.req('POST', '/api/billing/topups', { amountIdr, method: 'qris' });
  expect(res.status).toBe(201);
  const t = (await res.json()) as { paymentId: string; amountIdr: number; qrString: string };
  const ref = `mock_${t.paymentId}`;
  expect(
    (await webhook(rt, { providerRef: ref, status: 'paid', amountIdr: t.amountIdr })).status,
  ).toBe(200);
  return { ...t, ref };
}

const ledgerSum = (rt: DevRuntime, userId: string) =>
  (
    rt.d1.sqlite
      .prepare('SELECT COALESCE(SUM(delta_idr), 0) AS s FROM wallet_ledger WHERE user_id = ?')
      .get(userId) as { s: number }
  ).s;

describe('Saldo & payments (SPEC §12.2–12.3)', () => {
  it('tops up via QRIS; webhook replay is idempotent and status only moves forward', async () => {
    const { rt, s } = await setup();
    const t = await topup(rt, s, 20_000);
    expect(t.qrString).toContain('QRIS');
    expect((await summary(s)).balanceIdr).toBe(20_000);
    // Replays and backwards transitions change nothing
    await webhook(rt, { providerRef: t.ref, status: 'paid', amountIdr: 20_000 });
    await webhook(rt, { providerRef: t.ref, status: 'failed', amountIdr: 20_000 });
    expect((await summary(s)).balanceIdr).toBe(20_000);
    expect(ledgerSum(rt, s.userId)).toBe(20_000);
    // Forged signature
    expect(
      (await webhook(rt, { providerRef: t.ref, status: 'refunded', amountIdr: 20_000 }, 'bogus'))
        .status,
    ).toBe(401);
  });

  it('rejects amounts below the minimum and mismatched webhook amounts', async () => {
    const { rt, s } = await setup();
    expect(
      (await s.req('POST', '/api/billing/topups', { amountIdr: 5_000, method: 'qris' })).status,
    ).toBe(400);
    // Drive takes QRIS only (ADR-038), at any amount crypto would have taken.
    expect(
      (await s.req('POST', '/api/billing/topups', { amountIdr: 60_000, method: 'crypto' })).status,
    ).toBe(400);
    expect((await summary(s)).paymentMethods.map((m) => m.code)).toEqual(['qris']);
    const res = await s.req('POST', '/api/billing/topups', { amountIdr: 15_000, method: 'qris' });
    const { paymentId } = (await res.json()) as { paymentId: string };
    await webhook(rt, { providerRef: `mock_${paymentId}`, status: 'paid', amountIdr: 1 });
    expect((await summary(s)).balanceIdr).toBe(0);
  });

  it('mock checkout page simulates payment outside production', async () => {
    const { rt, s } = await setup();
    const res = await s.req('POST', '/api/billing/topups', { amountIdr: 10_000, method: 'qris' });
    const { checkoutUrl } = (await res.json()) as { checkoutUrl: string };
    const pageRes = await rt.fetch(new Request(checkoutUrl));
    expect(await pageRes.text()).toContain('Simulasi pembayaran');
    const paid = await rt.fetch(
      new Request(checkoutUrl, { method: 'POST', body: new URLSearchParams({ status: 'paid' }) }),
    );
    expect(paid.status).toBe(303);
    expect((await summary(s)).balanceIdr).toBe(10_000);
  });

  it('"bayar langsung" pays and buys the plan in one go', async () => {
    const { rt, s } = await setup();
    const res = await s.req('POST', '/api/billing/topups', {
      amountIdr: 10_000,
      method: 'qris',
      then: { kind: 'plan', code: 'basic' },
    });
    const { paymentId } = (await res.json()) as { paymentId: string };
    await webhook(rt, { providerRef: `mock_${paymentId}`, status: 'paid', amountIdr: 10_000 });
    const sum = await summary(s);
    expect(sum.subscription?.planCode).toBe('basic');
    expect(sum.balanceIdr).toBe(5_000);
  });
});

describe('plans (SPEC §12.4)', () => {
  it('subscribes from Saldo, sets the quota and issues a numbered invoice; new users can then upload', async () => {
    const { rt, s } = await setup();
    const root = await rootOf(s);
    expect((await simpleUpload(s, root, 'a.txt', 'a')).status).toBe(413);
    expect((await s.req('POST', '/api/billing/plan', { planCode: 'mini' })).status).toBe(402);
    await topup(rt, s, 10_000);
    const r = (await (await s.req('POST', '/api/billing/plan', { planCode: 'mini' })).json()) as {
      kind: string;
      chargedIdr: number;
      invoiceId: string;
    };
    expect(r).toMatchObject({ kind: 'subscribed', chargedIdr: 1_000 });
    const sum = await summary(s);
    expect(sum.balanceIdr).toBe(9_000);
    expect(sum.storage.limitBytes).toBe(3 * 2 ** 30);
    expect(sum.subscription?.periodEnd).toBe(Date.UTC(2026, 10, 10, 3, 0));
    const inv = (await (await s.req('GET', `/api/billing/invoices/${r.invoiceId}`)).json()) as {
      number: string;
      totalIdr: number;
    };
    expect(inv).toMatchObject({ number: 'ZK-202610-000001', totalIdr: 1_000 });
    await uploadText(s, root, 'a.txt', 'a');
    // Credits from the plan's monthly compress quota
    const credits = rt.d1.sqlite
      .prepare(
        "SELECT SUM(remaining) AS n FROM credit_ledger WHERE user_id = ? AND source = 'plan'",
      )
      .get(s.userId) as { n: number };
    expect(credits.n).toBe(50);
  });

  it('upgrade charges the pro-rata difference now; downgrade waits for the next period', async () => {
    const { rt, s, clock } = await setup();
    await topup(rt, s, 100_000);
    await s.req('POST', '/api/billing/plan', { planCode: 'basic' }); // 5.000
    clock.advance(15 * DAY_MS); // half of a 31-day period left (16/31)
    const up = (await (await s.req('POST', '/api/billing/plan', { planCode: 'plus' })).json()) as {
      kind: string;
      chargedIdr: number;
    };
    expect(up.kind).toBe('upgraded');
    expect(up.chargedIdr).toBe(Math.ceil((20_000 * 16) / 31));
    expect((await summary(s)).storage.limitBytes).toBe(120 * 2 ** 30);
    const down = (await (
      await s.req('POST', '/api/billing/plan', { planCode: 'mini' })
    ).json()) as { kind: string };
    expect(down.kind).toBe('downgrade_scheduled');
    let sum = await summary(s);
    expect(sum.subscription).toMatchObject({ planCode: 'plus', nextPlanCode: 'mini' });
    // Renewal applies the downgrade and charges the new price
    const before = sum.balanceIdr;
    clock.set(sum.subscription!.periodEnd + 1);
    await rt.runCron('0 * * * *');
    sum = await summary(s);
    expect(sum.subscription).toMatchObject({
      planCode: 'mini',
      nextPlanCode: null,
      status: 'active',
    });
    expect(sum.balanceIdr).toBe(before - 1_000);
    expect(sum.storage.limitBytes).toBe(3 * 2 ** 30);
  });

  it('add-ons are pro-rated, raise the quota and renew with the plan', async () => {
    const { rt, s } = await setup();
    await topup(rt, s, 50_000);
    expect((await s.req('POST', '/api/billing/addons', { addonCode: 'addon_10' })).status).toBe(
      409,
    ); // no plan
    await s.req('POST', '/api/billing/plan', { planCode: 'basic' });
    const a = (await (
      await s.req('POST', '/api/billing/addons', { addonCode: 'addon_10' })
    ).json()) as { chargedIdr: number };
    expect(a.chargedIdr).toBe(5_000);
    expect((await summary(s)).storage.limitBytes).toBe(30 * 2 ** 30);
  });
});

describe('dunning cycle with a fake clock (SPEC §12.5)', () => {
  it('grace → readonly → suspended → delete (dry-run first, then live)', async () => {
    const { rt, s, clock } = await setup();
    await topup(rt, s, 10_000);
    await s.req('POST', '/api/billing/plan', { planCode: 'mini' });
    const root = await rootOf(s);
    const f = await uploadText(s, root, 'penting.txt', 'data');
    await rt.settle();
    // Spend the rest (9.000 → 0) so the renewal fails
    expect(
      (await s.req('POST', '/api/billing/compress-packs', { packCode: 'kompres_500' })).status,
    ).toBe(201);
    expect(
      (await s.req('POST', '/api/billing/compress-packs', { packCode: 'kompres_100' })).status,
    ).toBe(201);
    expect((await summary(s)).balanceIdr).toBe(0);
    let sum = await summary(s);
    const due = sum.subscription!.periodEnd;

    clock.set(due + 1);
    await rt.runCron('0 * * * *');
    expect((await summary(s)).subscription?.status).toBe('grace');
    await rt.settle();
    const mails = () =>
      rt.d1.sqlite
        .prepare(
          'SELECT type, payload_json FROM notifications WHERE user_id = ? ORDER BY created_at',
        )
        .all(s.userId) as Array<{ type: string }>;
    expect(mails().map((m) => m.type)).toContain('renewal_failed');

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

  it('paying while overdue restores everything; pending payments block deletion', async () => {
    const { rt, s, clock } = await setup();
    await topup(rt, s, 10_000);
    await s.req('POST', '/api/billing/plan', { planCode: 'mini' });
    // Spend the rest (9.000 → 0) so the renewal fails
    expect(
      (await s.req('POST', '/api/billing/compress-packs', { packCode: 'kompres_500' })).status,
    ).toBe(201);
    expect(
      (await s.req('POST', '/api/billing/compress-packs', { packCode: 'kompres_100' })).status,
    ).toBe(201);
    expect((await summary(s)).balanceIdr).toBe(0);
    const due = (await summary(s)).subscription!.periodEnd;
    clock.set(due + 31 * DAY_MS);
    await rt.runCron('0 * * * *');
    await rt.runCron('0 19 * * *');
    expect((await summary(s)).subscription?.status).toBe('suspended');
    await topup(rt, s, 10_000);
    const r = (await (await s.req('POST', '/api/billing/plan', { planCode: 'mini' })).json()) as {
      kind: string;
    };
    expect(r.kind).toBe('reactivated');
    expect((await summary(s)).subscription?.status).toBe('active');
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

  it('puts the whole QRIS amount, its code included, in Saldo — once', async () => {
    const opened: unknown[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('https://door.test/')) {
        opened.push(JSON.parse(String(init?.body)));
        return Response.json({
          id: 'pay_zk1',
          payUrl: 'https://site.test/account/pay?id=pay_zk1',
          amountIdr: 20_123,
          expiresAt: T0 + 3_600_000,
        });
      }
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      const clock = new FakeClock(T0);
      const rt = await makeRuntime({ clock, vars });
      const s = await signIn(rt, 'qris@example.com');
      const res = await s.req('POST', '/api/billing/topups', { amountIdr: 20_000, method: 'qris' });
      expect(res.status, await res.clone().text()).toBe(201);
      const t = (await res.json()) as { amountIdr: number; checkoutUrl: string };
      expect(t).toMatchObject({ amountIdr: 20_123, checkoutUrl: 'https://site.test/account/pay?id=pay_zk1' });
      expect(opened[0]).toMatchObject({ accountId: 'zk_qris_example_com', amountIdr: 20_000, method: 'qris' });

      const callback = async (body: Record<string, unknown>, key = OPS) =>
        rt.fetch(
          await ZeikoPaymentProvider.signedRequest(`${APP}/api/payments/webhook/zeiko`, key, body, clock.now()),
        );
      const paid = { event: 'paid', id: 'pay_zk1', status: 'paid', amountIdr: 20_123 };
      expect((await callback(paid, 'wrong-key')).status).toBe(401);
      expect((await callback(paid)).status).toBe(200);
      expect((await callback(paid)).status).toBe(200); // the relay retries; nothing doubles
      expect((await summary(s)).balanceIdr).toBe(20_123);
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
        return Response.json({ id: 'pay_zk2', payUrl: 'https://x.test', amountIdr: 60_000 });
      if (url === 'https://door.test/apps/v1/payments/pay_zk2')
        return Response.json({ id: 'pay_zk2', status: paid ? 'paid' : 'pending', amountIdr: 60_000 });
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      const clock = new FakeClock(T0);
      const rt = await makeRuntime({ clock, vars });
      const s = await signIn(rt, 'lost@example.com');
      const res = await s.req('POST', '/api/billing/topups', { amountIdr: 60_000, method: 'qris' });
      expect(res.status, await res.clone().text()).toBe(201);
      clock.advance(5 * 60_000);
      await rt.runCron(CRON.hourly);
      expect((await summary(s)).balanceIdr).toBe(0); // still open at the door
      paid = true;
      clock.advance(60 * 60_000);
      await rt.runCron(CRON.hourly);
      expect((await summary(s)).balanceIdr).toBe(60_000);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
