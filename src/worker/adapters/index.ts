import type { Env } from '../env';
import {
  CloudflareEmailSender,
  MockEmailSender,
  RelayEmailSender,
  type EmailSender,
} from './email';
import { MockPaymentProvider, type PaymentProvider } from './payment';
import { ContainerScanner, MockScanner, type Scanner } from './scanner';
import { MockCsamDetector, type CsamDetector } from './csam';
import type { Clock } from './clock';
import { BotApiTelegram, MockTelegram, type TelegramClient } from './telegram';
import { CloudflareMediaProcessor, MockMediaProcessor, type MediaProcessor } from './media';
import { ContainerArchiver, MockArchiver, NoArchiver, type Archiver } from './archiver';

export interface Adapters {
  email: EmailSender;
  payment: PaymentProvider;
  scanner: Scanner;
  csam: CsamDetector;
  telegram: TelegramClient;
  media: MediaProcessor;
  archiver: Archiver;
}

export function createAdapters(env: Env, clock: Clock): Adapters {
  const email: EmailSender =
    env.ADAPTER_EMAIL === 'cloudflare' && env.EMAIL
      ? new CloudflareEmailSender(env.EMAIL, env.EMAIL_FROM)
      : env.ADAPTER_EMAIL === 'relay' && env.MAIL_RELAY_URL && env.MAIL_RELAY_TOKEN
        ? new RelayEmailSender(env.MAIL_RELAY_URL, env.MAIL_RELAY_TOKEN)
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
  const telegram: TelegramClient =
    env.TELEGRAM_BOT_TOKEN && env.APP_ENV !== 'dev'
      ? new BotApiTelegram(env.TELEGRAM_BOT_TOKEN)
      : new MockTelegram(env.CONFIG_KV);
  const media: MediaProcessor =
    env.ADAPTER_MEDIA === 'cloudflare'
      ? new CloudflareMediaProcessor(env.IMAGES, env.MEDIA, env.MEDIA_CONTAINER)
      : new MockMediaProcessor(env.ADAPTER_MEDIA !== 'mock-nocontainer');
  const archiver: Archiver =
    env.ADAPTER_ARCHIVER === 'container' && env.ARCHIVER
      ? new ContainerArchiver(env.ARCHIVER)
      : env.ADAPTER_ARCHIVER === 'mock'
        ? new MockArchiver(env.BUCKET)
        : new NoArchiver();
  return { email, payment, scanner, csam, telegram, media, archiver };
}
