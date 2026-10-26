// /.well-known/assetlinks.json (ADR-063): lets the Android app open https://<app>/app/callback, so
// only the real app receives its sign-in answer there. 404 until the owner gives the package and
// the signing certificate's fingerprints (readiness `app_links`).
import { Hono } from 'hono';
import type { AppBindings } from '../types';

export const assetLinks = new Hono<AppBindings>().get('/assetlinks.json', (c) => {
  const pkg = c.env.ANDROID_APP_PACKAGE;
  const certs = (c.env.ANDROID_CERT_SHA256 ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(s));
  if (!pkg || !certs.length) return c.notFound();
  c.header('Cache-Control', 'public, max-age=3600');
  return c.json([
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: pkg, sha256_cert_fingerprints: certs },
    },
  ]);
});
