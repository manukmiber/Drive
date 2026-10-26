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
import { CloudflareMediaProcessor, MockMediaProcessor, type MediaProcessor } from './media';
import { ContainerArchiver, MockArchiver, NoArchiver, type Archiver } from './archiver';
import { GraphqlR2Metrics, NoR2Metrics, type R2Metrics } from './r2-metrics';
import { HttpVirusTotal, MockVirusTotal, type VirusTotal } from './virustotal';
import { CloudflareHostnames, MockHostnames, type Hostnames } from './hostnames';
import { MockNotices, RelayNotices, type NoticeStore } from './notices';

export interface Adapters {
  email: EmailSender;
  payment: PaymentProvider;
  scanner: Scanner;
  csam: CsamDetector;
  media: MediaProcessor;
  archiver: Archiver;
  accounts: ZeikoAccounts;
  r2metrics: R2Metrics;
  /** Null: VirusTotal is not set up here (ADR-046). */
  virustotal: VirusTotal | null;
  /** Null: no own S3 addresses here (ADR-048). */
  hostnames: Hostnames | null;
  /** The bell, email switches and unsubscribes: kept by the relay (ADR-064). */
  notices: NoticeStore;
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
  // Like sign-in: the relay where Zeiko Accounts is set up, KV rows in dev and tests.
  const notices: NoticeStore =
    env.ADAPTER_ACCOUNTS === 'zeiko' && zeikoReady(env)
      ? new RelayNotices(env.ZEIKO_DOOR_URL!, env.ZEIKO_APP_TOKEN!)
      : new MockNotices(env.CONFIG_KV, () => clock.now());
  const scanner: Scanner =
    env.ADAPTER_SCANNER === 'container' && env.SCANNER
      ? new ContainerScanner(env.BUCKET, env.SCANNER, Number(env.SCANNER_INSTANCES ?? 3))
      : new MockScanner(env.BUCKET);
  const csam = new MockCsamDetector();
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
  const virustotal: VirusTotal | null = env.VIRUSTOTAL_API_KEY
    ? new HttpVirusTotal(env.VIRUSTOTAL_API_KEY)
    : env.ADAPTER_VIRUSTOTAL === 'mock' && env.APP_ENV !== 'production'
      ? new MockVirusTotal()
      : null;
  const hostnames: Hostnames | null =
    env.CF_HOSTNAMES_TOKEN && env.CF_ACCOUNT_ID && env.CF_ZONE_ID && env.WORKER_NAME
      ? new CloudflareHostnames(
          env.CF_HOSTNAMES_TOKEN,
          env.CF_ACCOUNT_ID,
          env.CF_ZONE_ID,
          env.WORKER_NAME,
        )
      : env.ADAPTER_HOSTNAMES === 'mock' && env.APP_ENV !== 'production'
        ? new MockHostnames()
        : null;
  return {
    email,
    payment,
    scanner,
    csam,
    media,
    archiver,
    accounts,
    r2metrics,
    virustotal,
    hostnames,
    notices,
  };
}
