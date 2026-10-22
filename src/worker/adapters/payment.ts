// PaymentProvider adapter (SPEC §12.3). The real one is Zeiko Accounts (`zeiko.ts`, ADR-036).
import type { PaymentStatus } from '../../shared/enums';
import { hmacBase64Url, timingSafeEqual } from '../lib/crypto';

export interface ChargeRequest {
  paymentId: string;
  amountIdr: number;
  method: string;
  description: string;
  customerEmail: string;
  /** The buyer's Zeiko Account id (provider `zeiko`). */
  customerRef?: string | undefined;
}

export interface Charge {
  providerRef: string;
  /** Hosted payment page (VA/e-wallet) or null for QR-only flows. */
  checkoutUrl: string | null;
  /** QRIS payload to render as a QR code, when the method is QRIS. */
  qrString: string | null;
  expiresAt: number;
  /**
   * What the buyer actually pays, when the provider changes it: a Zeiko QRIS adds a code of 1–999
   * rupiah so the operator can tell transfers apart. All of it lands in Saldo.
   */
  amountIdr?: number;
}

export interface WebhookEvent {
  providerRef: string;
  status: PaymentStatus;
  amountIdr: number;
  raw: unknown;
}

export interface PaymentProvider {
  readonly name: string;
  createCharge(req: ChargeRequest): Promise<Charge>;
  getStatus(providerRef: string): Promise<PaymentStatus>;
  /** Returns null when the signature is invalid. */
  verifyWebhook(req: Request): Promise<WebhookEvent | null>;
  refund?(providerRef: string, amountIdr: number): Promise<void>;
}

/**
 * Mock gateway: charges stay pending until the dev UI (or a test) posts a signed webhook via
 * `mockWebhookRequest`. Signature = HMAC(secret, body) in `x-mock-signature`.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';
  constructor(
    private secret: string,
    private appOrigin: string,
    private now: () => number,
  ) {}

  async createCharge(req: ChargeRequest): Promise<Charge> {
    const providerRef = `mock_${req.paymentId}`;
    return {
      providerRef,
      checkoutUrl: `${this.appOrigin}/dev/pay/${providerRef}`,
      qrString: req.method === 'qris' ? `00020101021226MOCKQRIS${providerRef}` : null,
      expiresAt: this.now() + 30 * 60_000,
    };
  }

  async getStatus(): Promise<PaymentStatus> {
    return 'pending';
  }

  async verifyWebhook(req: Request): Promise<WebhookEvent | null> {
    const body = await req.text();
    const sig = req.headers.get('x-mock-signature') ?? '';
    const expected = await hmacBase64Url(this.secret, body);
    if (!timingSafeEqual(sig, expected)) return null;
    const data = JSON.parse(body) as {
      providerRef: string;
      status: PaymentStatus;
      amountIdr: number;
    };
    return {
      providerRef: data.providerRef,
      status: data.status,
      amountIdr: data.amountIdr,
      raw: data,
    };
  }

  static async signedBody(
    secret: string,
    event: { providerRef: string; status: PaymentStatus; amountIdr: number },
  ): Promise<{ body: string; signature: string }> {
    const body = JSON.stringify(event);
    return { body, signature: await hmacBase64Url(secret, body) };
  }
}
