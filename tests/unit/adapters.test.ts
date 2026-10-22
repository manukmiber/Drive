import { describe, expect, it } from 'vitest';
import { RelayEmailSender } from '../../src/worker/adapters/email';

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
