import type { Env } from '../env';
import { CloudflareEmailSender, MockEmailSender, type EmailSender } from './email';
import { MockPaymentProvider, type PaymentProvider } from './payment';
import { ContainerScanner, MockScanner, type Scanner } from './scanner';
import { MockCsamDetector, type CsamDetector } from './csam';
import type { Clock } from './clock';

export interface Adapters {
  email: EmailSender;
  payment: PaymentProvider;
  scanner: Scanner;
  csam: CsamDetector;
}

export function createAdapters(env: Env, clock: Clock): Adapters {
  const email: EmailSender =
    env.ADAPTER_EMAIL === 'cloudflare'
      ? new CloudflareEmailSender(env.EMAIL, env.EMAIL_FROM)
      : new MockEmailSender(env.CONFIG_KV, env.EMAIL_FROM);
  // Only the mock gateway exists until the owner picks a provider (SPEC §16 #2).
  const payment = new MockPaymentProvider(env.PAYMENT_WEBHOOK_SECRET, env.APP_ORIGIN, () =>
    clock.now(),
  );
  const scanner: Scanner =
    env.ADAPTER_SCANNER === 'container' && env.SCANNER
      ? new ContainerScanner(env.BUCKET, env.SCANNER, Number(env.SCANNER_INSTANCES ?? 3))
      : new MockScanner(env.BUCKET);
  const csam = new MockCsamDetector();
  return { email, payment, scanner, csam };
}
