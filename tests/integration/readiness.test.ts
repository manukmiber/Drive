// What works here and what each feature still needs (ADR-049): the public catalog's capabilities
// (what the app shows) and the ops API's list for the relay's Features tab.
import { describe, expect, it } from 'vitest';
import type { DevRuntime } from '../../dev/env';
import { APP, makeRuntime } from '../helpers/runtime';
import { OPS_KEY, opsCall, S3_ORIGIN } from '../helpers/s3';

interface Feature {
  id: string;
  ready: boolean;
  hidden: boolean;
  after: string[];
  needs: Array<{ name: string; kind: string; ok: boolean; how: string }>;
}

async function capabilities(rt: DevRuntime) {
  const res = await rt.fetch(new Request(`${APP}/api/public/catalog`));
  expect(res.status).toBe(200);
  return ((await res.json()) as { capabilities: Record<string, boolean> }).capabilities;
}

async function features(rt: DevRuntime) {
  const res = await opsCall(rt)('GET', '/readiness');
  expect(res.status).toBe(200);
  const body = (await res.json()) as { env: string; features: Feature[] };
  return new Map(body.features.map((f) => [f.id, f]));
}

describe('feature readiness', () => {
  it('shows everything that is set up, and the relay sees the same', async () => {
    const rt = await makeRuntime({ vars: { ZEIKO_OPS_TOKEN: OPS_KEY, S3_ORIGIN } });
    expect(await capabilities(rt)).toEqual({
      antivirus: false,
      asyncArchives: true,
      emailShare: true,
      s3: true,
      s3ThreeCopies: true,
      s3UrlZeiko: true,
      s3UrlCustom: true,
    });
    // The website draws its Zeiko S3 section from the same catalog: prices, nothing more.
    const res = await rt.fetch(new Request(`${APP}/api/public/catalog`));
    const { config } = (await res.json()) as { config: Record<string, unknown> };
    expect(config).toMatchObject({
      s3_price_idr_per_gb_month: 500,
      s3_price_idr_per_gb_month_3x: 1250,
      s3_min_gb: 3,
      s3_egress_block_idr: 5000,
      s3_url_zeiko_idr: 3000,
      s3_url_custom_idr: 5000,
    });
    const f = await features(rt);
    for (const id of ['s3', 's3_three_copies', 's3_url_zeiko', 's3_url_custom'])
      expect(f.get(id)?.ready, id).toBe(true);
    // Not a key of its own here, so VirusTotal says what it needs and how.
    const vt = f.get('virustotal')!;
    expect(vt.ready).toBe(false);
    expect(vt.needs).toEqual([
      expect.objectContaining({ name: 'VIRUSTOTAL_API_KEY', kind: 'secret', ok: false }),
    ]);
    expect(vt.needs[0]!.how).toMatch(/API Key/);
  });

  it('hides what is missing, and what waits on it', async () => {
    const rt = await makeRuntime({ vars: { ZEIKO_OPS_TOKEN: OPS_KEY, S3_ORIGIN } });
    const env = rt.env as unknown as Record<string, unknown>;
    // No replica buckets, no SaaS target: one copy, and only Zeiko's own subdomains.
    delete env.S3_REPLICA_B;
    delete env.S3_CNAME_TARGET;
    expect(await capabilities(rt)).toMatchObject({
      s3: true,
      s3ThreeCopies: false,
      s3UrlZeiko: true,
      s3UrlCustom: false,
    });
    let f = await features(rt);
    expect(f.get('s3_three_copies')).toMatchObject({ ready: false, hidden: true });
    expect(f.get('s3_three_copies')!.needs.find((n) => !n.ok)).toMatchObject({
      name: 'S3_REPLICA_B',
      kind: 'deploy',
    });
    expect(f.get('s3_url_custom')!.needs).toEqual([
      expect.objectContaining({ name: 'S3_CNAME_TARGET', kind: 'cloudflare', ok: false }),
    ]);

    // No S3 key seal: no Zeiko S3 at all, and nothing that hangs off it either.
    delete env.S3_KEYS_ENC_KEY;
    expect(await capabilities(rt)).toMatchObject({
      s3: false,
      s3ThreeCopies: false,
      s3UrlZeiko: false,
      s3UrlCustom: false,
    });
    f = await features(rt);
    expect(f.get('s3_url_zeiko')).toMatchObject({ ready: false, after: ['s3'] });
    expect(f.get('s3_url_zeiko')!.needs.every((n) => n.ok)).toBe(true);
  });

  it('hides sharing by email in production until Drive sends real mail', async () => {
    const rt = await makeRuntime({
      vars: { ZEIKO_OPS_TOKEN: OPS_KEY, S3_ORIGIN, APP_ENV: 'production' },
    });
    expect((await capabilities(rt)).emailShare).toBe(false);
    expect((await features(rt)).get('email')).toMatchObject({ ready: false, hidden: true });
  });
});
