import { describe, expect, it } from 'vitest';
import { APP, jsonReq, makeRuntime } from '../helpers/runtime';

describe('worker skeleton', () => {
  it('serves health', async () => {
    const rt = await makeRuntime();
    const res = await rt.fetch(`${APP}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, env: 'dev' });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('serves the public catalog with client-safe config only', async () => {
    const rt = await makeRuntime();
    const body = (await (await rt.fetch(`${APP}/api/public/catalog`)).json()) as {
      plans: Array<{ code: string }>;
      config: Record<string, unknown>;
    };
    expect(body.plans.map((p) => p.code)).toEqual(['mini', 'basic', 'plus', 'pro', 'max']);
    expect(body.config).toHaveProperty('upload_part_concurrency', 4);
    expect(body.config).not.toHaveProperty('usd_idr_rate');
  });

  it('rejects mutations from another origin', async () => {
    const rt = await makeRuntime();
    const res = await rt.fetch(
      jsonReq('POST', '/api/health', {}, { origin: 'https://evil.example' }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'ORIGIN_MISMATCH' } });
  });

  it('returns JSON 404 for unknown API routes', async () => {
    const rt = await makeRuntime();
    const res = await rt.fetch(`${APP}/api/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('serves nothing but previews on the user-content host', async () => {
    const rt = await makeRuntime();
    for (const path of ['/api/health', '/', '/__dev/mail']) {
      const res = await rt.fetch(new Request(`http://uc.localhost:8790${path}`));
      expect(res.status, path).toBe(404);
    }
  });

  it('runs the hourly cron', async () => {
    const rt = await makeRuntime();
    const out = await rt.runCron('0 * * * *');
    expect(out.failed).toEqual([]);
    expect(out.ran).toContain('usage_counters_gc');
  });
});
