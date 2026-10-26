// Zeiko Accounts (ADR-036): the sign-in door of the owner's relay (`ZEIKO_DOOR_URL`,
// https://auth.zeiko.biz.id) knows who a person is and takes their payments in rupiah. Drive asks
// for QRIS only (ADR-038), checked by the operator. Server to server with `ZEIKO_APP_TOKEN`; the
// relay's payment callbacks are signed with `ZEIKO_OPS_TOKEN`.
import type { PaymentStatus } from '../../shared/enums';
import { AppError } from '../lib/errors';
import { hmacSha256, timingSafeEqual, toHex } from '../lib/crypto';
import { log } from '../lib/log';
import type { Charge, ChargeRequest, PaymentProvider, WebhookEvent } from './payment';

/** Who a Zeiko Account is, as the door says it (never a password). */
export interface ZeikoAccount {
  id: string;
  email: string;
  username: string;
  name: string;
  emailVerified: boolean;
  /** Where they said they live, for local ads (ADR-041): city required at sign-up, postal code not. */
  city: string;
  postalCode: string;
}

export interface ZeikoAccounts {
  readonly name: string;
  /** Turns a one-time sign-in ticket (from the visitor's browser) into the account. */
  redeemTicket(ticket: string): Promise<ZeikoAccount>;
}

/** How far a callback's timestamp may be from now, seconds. */
export const WEBHOOK_TOLERANCE_S = 300;

interface Answer {
  status: number;
  data: Record<string, unknown> | null;
}

/** The door's `/apps/v1` routes. */
export class Door {
  /**
   * Called as a plain function, never as `this.fetcher(…)`: the Workers runtime refuses its global
   * `fetch` called with another `this` ("Illegal invocation"), which Node lets through, so the
   * tests never saw it and every sign-in failed in production.
   */
  private send: typeof fetch;

  constructor(
    private base: string,
    private token: string,
    fetcher: typeof fetch,
  ) {
    this.send = (input, init) => fetcher(input, init);
  }

  async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Answer> {
    let res: Response;
    try {
      res = await this.send(`${this.base.replace(/\/+$/, '')}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      log.warn('zeiko_door_unreachable', { path, error: String(e) });
      throw new AppError('ACCOUNTS_UNAVAILABLE', 'Zeiko Accounts is not answering');
    }
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    // 5xx, or the door's 404 for a wrong token: nothing the visitor can fix.
    if (res.status >= 500 || res.status === 404 || res.status === 401) {
      log.warn('zeiko_door_refused', { path, status: res.status });
      if (res.status === 404 && path.startsWith('/apps/v1/payments/'))
        return { status: res.status, data };
      throw new AppError('ACCOUNTS_UNAVAILABLE', 'Zeiko Accounts is not answering');
    }
    return { status: res.status, data };
  }
}

function account(raw: unknown): ZeikoAccount {
  const a = (raw ?? {}) as Record<string, unknown>;
  if (typeof a.id !== 'string' || !a.id) throw new AppError('ACCOUNTS_UNAVAILABLE', 'bad account');
  return {
    id: a.id,
    email: typeof a.email === 'string' ? a.email : '',
    username: typeof a.username === 'string' ? a.username : '',
    name: typeof a.name === 'string' ? a.name : '',
    emailVerified: a.emailVerified === true,
    city: typeof a.city === 'string' ? a.city.trim().slice(0, 80) : '',
    postalCode: typeof a.postalCode === 'string' ? a.postalCode.trim().slice(0, 10) : '',
  };
}

/** A refusal in the door's own words (they are written for customers). */
function said(a: Answer): string {
  const e = (a.data?.error ?? {}) as { message?: unknown };
  return typeof e.message === 'string' ? e.message : 'refused';
}

export class RelayZeikoAccounts implements ZeikoAccounts {
  readonly name = 'zeiko';
  private door: Door;
  constructor(base: string, token: string, fetcher: typeof fetch = fetch) {
    this.door = new Door(base, token, fetcher);
  }

  async redeemTicket(ticket: string): Promise<ZeikoAccount> {
    const r = await this.door.call('POST', '/apps/v1/tickets/redeem', { ticket });
    if (r.status !== 200) throw new AppError('SIGN_IN_EXPIRED', said(r));
    return account(r.data?.account);
  }
}

/** Dev/test: tickets are KV rows written by the dev door (`/__dev/door`). */
export class MockZeikoAccounts implements ZeikoAccounts {
  readonly name = 'mock';
  constructor(private kv: KVNamespace) {}

  static key(ticket: string): string {
    return `dev:zeiko-ticket:${ticket}`;
  }

  /** Issue a ticket for `a`, as the door would for a signed-in browser. */
  static async issue(kv: KVNamespace, a: ZeikoAccount): Promise<string> {
    const ticket = crypto.randomUUID().replace(/-/g, '');
    await kv.put(MockZeikoAccounts.key(ticket), JSON.stringify(a), { expirationTtl: 120 });
    return ticket;
  }

  async redeemTicket(ticket: string): Promise<ZeikoAccount> {
    const key = MockZeikoAccounts.key(ticket);
    const raw = await this.kv.get(key);
    if (!raw) throw new AppError('SIGN_IN_EXPIRED', 'That sign-in has expired. Try again.');
    await this.kv.delete(key);
    return account(JSON.parse(raw));
  }
}

const STATUS: Record<string, PaymentStatus> = {
  pending: 'pending',
  paid: 'paid',
  failed: 'failed',
  expired: 'expired',
};

export class ZeikoPaymentProvider implements PaymentProvider {
  readonly name = 'zeiko';
  private door: Door;
  constructor(
    base: string,
    token: string,
    private opsToken: string,
    private returnUrl: string,
    private now: () => number,
    fetcher: typeof fetch = fetch,
  ) {
    this.door = new Door(base, token, fetcher);
  }

  async createCharge(req: ChargeRequest): Promise<Charge> {
    if (!req.customerRef) throw new AppError('PAYMENT_UNAVAILABLE', 'no Zeiko Account linked');
    const r = await this.door.call('POST', '/apps/v1/payments', {
      accountId: req.customerRef,
      orderRef: req.paymentId,
      amountIdr: req.amountIdr,
      description: req.description,
      method: req.method,
      returnUrl: this.returnUrl,
    });
    if (r.status !== 200 || !r.data) {
      throw new AppError(
        r.status === 409 || r.status === 429 ? 'PAYMENT_UNAVAILABLE' : 'VALIDATION',
        said(r),
      );
    }
    const d = r.data;
    return {
      providerRef: String(d.id),
      checkoutUrl: typeof d.payUrl === 'string' ? d.payUrl : null,
      // The QRIS text with the rupiah in it (a relay from 2026-10-24 on), for a QR in an email.
      qrString: typeof d.qris === 'string' ? d.qris : null,
      expiresAt: typeof d.expiresAt === 'number' ? d.expiresAt : this.now() + 60 * 60_000,
      ...(typeof d.amountIdr === 'number' ? { amountIdr: d.amountIdr } : {}),
    };
  }

  async getStatus(providerRef: string): Promise<PaymentStatus> {
    const r = await this.door.call('GET', `/apps/v1/payments/${encodeURIComponent(providerRef)}`);
    if (r.status !== 200) return 'pending';
    return STATUS[String(r.data?.status)] ?? 'pending';
  }

  async verifyWebhook(req: Request): Promise<WebhookEvent | null> {
    const body = await req.text();
    const ts = Number(req.headers.get('x-zeiko-timestamp'));
    const sig = req.headers.get('x-zeiko-signature') ?? '';
    if (!Number.isInteger(ts) || Math.abs(this.now() / 1000 - ts) > WEBHOOK_TOLERANCE_S)
      return null;
    const expected = toHex(await hmacSha256(this.opsToken, `${ts}.${body}`));
    if (!timingSafeEqual(sig, expected)) return null;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return null;
    }
    const status = STATUS[String(data.status)];
    if (!status || typeof data.id !== 'string' || typeof data.amountIdr !== 'number') return null;
    return { providerRef: data.id, status, amountIdr: data.amountIdr, raw: data };
  }

  /** What the relay sends, for tests. */
  static async signedRequest(
    url: string,
    opsToken: string,
    body: Record<string, unknown>,
    nowMs: number,
  ): Promise<Request> {
    const text = JSON.stringify(body);
    const ts = Math.floor(nowMs / 1000);
    const sig = toHex(await hmacSha256(opsToken, `${ts}.${text}`));
    return new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-zeiko-timestamp': String(ts),
        'x-zeiko-signature': sig,
      },
      body: text,
    });
  }
}
