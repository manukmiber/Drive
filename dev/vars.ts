// Dev vars/secrets: .dev.vars (KEY=VALUE, same format wrangler uses) overrides these defaults.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEV_DEFAULTS: Record<string, string> = {
  APP_ENV: 'dev',
  APP_ORIGIN: 'http://localhost:5173',
  USERCONTENT_ORIGIN: 'http://uc.localhost:8790',
  EMAIL_FROM: 'no-reply@zeiko.biz.id',
  ADAPTER_EMAIL: 'mock',
  ADAPTER_PAYMENT: 'mock',
  ADAPTER_SCANNER: 'mock',
  ADAPTER_CSAM: 'mock',
  ADAPTER_MEDIA: 'mock',
  ADAPTER_ARCHIVER: 'mock',
  // Insecure, dev-only secrets. Real ones come from `wrangler secret put`.
  BETTER_AUTH_SECRET: 'dev-only-better-auth-secret-change-me-0000000000',
  DOWNLOAD_SECRET: 'dev-only-download-secret',
  SHARE_LINK_SECRET: 'dev-only-share-link-secret',
  PREVIEW_SECRET: 'dev-only-preview-secret',
  CONTACTS_ENC_KEY: 'ZGV2LW9ubHktY29udGFjdHMta2V5LTMyLWJ5dGVzISE=',
  IP_HASH_SECRET: 'dev-only-ip-hash-secret',
  PAYMENT_WEBHOOK_SECRET: 'dev-only-payment-webhook-secret',
};

export function loadDevVars(root: string): Record<string, string> {
  const vars = { ...DEV_DEFAULTS };
  const file = join(root, '.dev.vars');
  if (!existsSync(file)) return vars;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    vars[m[1]!] = m[2]!.replace(/^"(.*)"$/, '$1');
  }
  return vars;
}
