import type { Env } from '../env';
import { basePath } from '../lib/paths';
import {
  CloudflareEmailSender,
  MockEmailSender,
  RelayEmailSender,
  type EmailSender,
} from './email';
import { MockPaymentProvider, type PaymentProvider } from './payment';
import {
  MockZeikoAccounts,
  RelayZeikoAccounts,
  ZeikoPaymentProvider,
  type ZeikoAccounts,
} from './zeiko';
import { ContainerScanner, MockScanner, type Scanner } from './scanner';
import { MockCsamDetector, type CsamDetector } from './csam';
import type { Clock } from './clock';
import { BotApiTelegram, MockTelegram, type TelegramClient } from './telegram';
import { CloudflareMediaProcessor, MockMediaProcessor, type MediaProcessor } from './media';
import { ContainerArchiver, MockArchiver, NoArchiver, type Archiver } from './archiver';
import { GraphqlR2Metrics, NoR2Metrics, type R2Metrics } from './r2-metrics';

export interface Adapters {
  email: EmailSender;
  payment: PaymentProvider;
  scanner: Scanner;
  csam: CsamDetector;
  telegram: TelegramClient;
  media: MediaProcessor;
  archiver: Archiver;
  accounts: ZeikoAccounts;
  r2metrics: R2Metrics;
}

/** Zeiko Accounts is set up: the door's address and the app token. */
export function zeikoReady(env: Env): boolean {
  return Boolean(env.ZEIKO_DOOR_URL && env.ZEIKO_APP_TOKEN);
}

export function createAdapters(env: Env, clock: Clock): Adapters {
  const email: EmailSender =
    env.ADAPTER_EMAIL === 'cloudflare' && env.EMAIL
      ? new CloudflareEmailSender(env.EMAIL, env.EMAIL_FROM)
      : env.ADAPTER_EMAIL === 'relay' && env.MAIL_RELAY_URL && env.MAIL_RELAY_TOKEN
        ? new RelayEmailSender(env.MAIL_RELAY_URL, env.MAIL_RELAY_TOKEN)
        : new MockEmailSender(env.CONFIG_KV, env.EMAIL_FROM);
  const base = basePath(env);
  const payment: PaymentProvider =
    env.ADAPTER_PAYMENT === 'zeiko' && zeikoReady(env) && env.ZEIKO_OPS_TOKEN
      ? new ZeikoPaymentProvider(
          env.ZEIKO_DOOR_URL!,
          env.ZEIKO_APP_TOKEN!,
          env.ZEIKO_OPS_TOKEN,
          `${env.APP_ORIGIN}${base}/paket`,
          () => clock.now(),
        )
      : new MockPaymentProvider(env.PAYMENT_WEBHOOK_SECRET, env.APP_ORIGIN, () => clock.now());
  // The dev door's tickets only exist in dev and tests; anywhere else, no Zeiko Accounts means
  // nobody can sign in (the routes say so) rather than a door anyone could walk through.
  const accounts: ZeikoAccounts =
    env.ADAPTER_ACCOUNTS === 'zeiko' && zeikoReady(env)
      ? new RelayZeikoAccounts(env.ZEIKO_DOOR_URL!, env.ZEIKO_APP_TOKEN!)
      : new MockZeikoAccounts(env.CONFIG_KV);
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
  const r2metrics: R2Metrics =
    env.CF_ACCOUNT_ID && env.CF_ANALYTICS_TOKEN
      ? new GraphqlR2Metrics(env.CF_ACCOUNT_ID, env.CF_ANALYTICS_TOKEN)
      : new NoR2Metrics();
  return { email, payment, scanner, csam, telegram, media, archiver, accounts, r2metrics };
}
