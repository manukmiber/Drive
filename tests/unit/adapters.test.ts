import { describe, expect, it } from 'vitest';
import { RelayEmailSender } from '../../src/worker/adapters/email';
import { RelayZeikoAccounts, ZeikoPaymentProvider } from '../../src/worker/adapters/zeiko';

describe('RelayEmailSender (ADR-035)', () => {
  it('posts one request per recipient with the bearer token', async () => {
    const calls: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        auth: new Headers(init.headers).get('authorization'),
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      });
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    const sender = new RelayEmailSender('https://mailer.example', 'tok', fake);
    const r = await sender.send({
      to: ['a@example.com', 'b@example.com'],
      subject: 'Kode masuk',
      text: '123456',
      html: '<b>123456</b>',
      tag: 'otp',
    });
    expect(r.id).toMatch(/^relay-/);
    expect(calls.map((c) => c.body.to)).toEqual(['a@example.com', 'b@example.com']);
    expect(calls[0]).toMatchObject({
      url: 'https://mailer.example',
      auth: 'Bearer tok',
      body: { subject: 'Kode masuk', text: '123456', html: '<b>123456</b>', fromName: 'Zeiko' },
    });
  });

  it('throws on a refused message so the caller can retry', async () => {
    const fake = (async () =>
      Response.json({ error: 'unauthorized' }, { status: 401 })) as unknown as typeof fetch;
    const sender = new RelayEmailSender('https://mailer.example', 'bad', fake);
    await expect(
      sender.send({ to: ['a@example.com'], subject: 's', text: 't', tag: 'otp' }),
    ).rejects.toThrow(/mail relay 401 \(otp\)/);
  });
});

describe('Zeiko Accounts payments (ADR-036)', () => {
  const NOW = 1_790_000_000_000;
  const door = (answer: (url: string, init: RequestInit) => Response) => {
    const calls: Array<{ url: string; auth: string | null; body: unknown }> = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        auth: new Headers(init.headers).get('authorization'),
        body: init.body ? JSON.parse(String(init.body)) : null,
      });
      return answer(url, init);
    }) as unknown as typeof fetch;
    return { calls, fake };
  };

  it('opens a payment in rupiah and keeps the amount the door asks', async () => {
    const { calls, fake } = door(() =>
      Response.json({
        id: 'pay_1',
        payUrl: 'https://site.test/account/pay?id=pay_1',
        amountIdr: 25_437,
        expiresAt: NOW + 3_600_000,
      }),
    );
    const p = new ZeikoPaymentProvider('https://door.test/', 'app-tok', 'ops', 'https://d.test/paket', () => NOW, fake);
    const charge = await p.createCharge({
      paymentId: '01JPAY',
      amountIdr: 25_000,
      method: 'qris',
      description: 'Isi Saldo',
      customerEmail: 'a@example.com',
      customerRef: 'zk_a',
    });
    expect(charge).toEqual({
      providerRef: 'pay_1',
      checkoutUrl: 'https://site.test/account/pay?id=pay_1',
      qrString: null,
      expiresAt: NOW + 3_600_000,
      amountIdr: 25_437,
    });
    expect(calls[0]).toEqual({
      url: 'https://door.test/apps/v1/payments',
      auth: 'Bearer app-tok',
      body: {
        accountId: 'zk_a',
        orderRef: '01JPAY',
        amountIdr: 25_000,
        description: 'Isi Saldo',
        method: 'qris',
        returnUrl: 'https://d.test/paket',
      },
    });
  });

  it('says the door refused in its own words', async () => {
    const { fake } = door(() =>
      Response.json({ error: { message: 'Paying by QRIS is not open right now.' } }, { status: 409 }),
    );
    const p = new ZeikoPaymentProvider('https://door.test', 't', 'o', 'https://d.test/x', () => NOW, fake);
    await expect(
      p.createCharge({ paymentId: 'x', amountIdr: 1, method: 'qris', description: '', customerEmail: '', customerRef: 'z' }),
    ).rejects.toThrow(/not open right now/);
  });

  it('accepts only a fresh callback signed with the ops key', async () => {
    const p = new ZeikoPaymentProvider('https://door.test', 't', 'ops-key', 'https://d.test/x', () => NOW);
    const body = { event: 'paid', id: 'pay_1', status: 'paid', amountIdr: 25_437 };
    const url = 'https://d.test/api/payments/webhook/zeiko';
    const ok = await p.verifyWebhook(await ZeikoPaymentProvider.signedRequest(url, 'ops-key', body, NOW));
    expect(ok).toMatchObject({ providerRef: 'pay_1', status: 'paid', amountIdr: 25_437 });
    expect(await p.verifyWebhook(await ZeikoPaymentProvider.signedRequest(url, 'other', body, NOW))).toBeNull();
    expect(
      await p.verifyWebhook(await ZeikoPaymentProvider.signedRequest(url, 'ops-key', body, NOW - 10 * 60_000)),
    ).toBeNull();
  });

  it('reads a payment status, pending when unsure', async () => {
    const { fake } = door((url) =>
      url.endsWith('/pay_ok') ? Response.json({ status: 'paid' }) : Response.json({}, { status: 404 }),
    );
    const p = new ZeikoPaymentProvider('https://door.test', 't', 'o', 'https://d.test/x', () => NOW, fake);
    expect(await p.getStatus('pay_ok')).toBe('paid');
    expect(await p.getStatus('pay_gone')).toBe('pending');
  });
});

describe('Zeiko Accounts sign-in tickets', () => {
  it('redeems a ticket at the door with the app token', async () => {
    let seen: { url: string; auth: string | null; body: string } | null = null;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, auth: new Headers(init.headers).get('authorization'), body: String(init.body) };
      return Response.json({ account: { id: 'zk_1', email: 'a@x.test', username: 'a', name: '', emailVerified: true } });
    }) as unknown as typeof fetch;
    const a = await new RelayZeikoAccounts('https://door.test', 'app', fake).redeemTicket('tkt');
    expect(a).toEqual({ id: 'zk_1', email: 'a@x.test', username: 'a', name: '', emailVerified: true });
    expect(seen).toEqual({ url: 'https://door.test/apps/v1/tickets/redeem', auth: 'Bearer app', body: '{"ticket":"tkt"}' });
  });

  it('treats a wrong token (the door’s 404) as the door being down, not the ticket', async () => {
    const fake = (async () => Response.json({}, { status: 404 })) as unknown as typeof fetch;
    await expect(new RelayZeikoAccounts('https://door.test', 'bad', fake).redeemTicket('t')).rejects.toMatchObject({
      code: 'ACCOUNTS_UNAVAILABLE',
    });
  });
});

/**
 * The Workers runtime's `fetch` throws "Illegal invocation" when called with a `this` other than
 * the global one (Node's does not), so an adapter calling `this.fetcher(…)` fails only in
 * production. This stand-in behaves like the runtime.
 */
function workersFetch(answer: () => Response): typeof fetch {
  return function (this: unknown) {
    if (this !== undefined && this !== globalThis) {
      return Promise.reject(new TypeError('Illegal invocation'));
    }
    return Promise.resolve(answer());
  } as typeof fetch;
}

describe('adapters call fetch the way the Workers runtime allows', () => {
  it('redeems a ticket', async () => {
    const fake = workersFetch(() =>
      Response.json({
        account: { id: 'zk_1', email: 'a@b.test', username: 'a', name: 'A', emailVerified: true },
      }),
    );
    const a = await new RelayZeikoAccounts('https://door.test', 'app', fake).redeemTicket('t');
    expect(a.id).toBe('zk_1');
  });

  it('sends a mail through the relay mailer', async () => {
    const fake = workersFetch(() => Response.json({ id: 'm1' }));
    const sender = new RelayEmailSender('https://mailer.example', 'tok', fake);
    await expect(
      sender.send({ to: ['x@y.test'], subject: 's', text: 't', tag: 'share' }),
    ).resolves.toBeTruthy();
  });
});
