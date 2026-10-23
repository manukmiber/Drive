import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/worker/adapters/clock';
import { CRON } from '../../src/shared/constants';
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

  it('sends the old /dashboard address of the app to its own pages', async () => {
    const rt = await makeRuntime();
    const res = await rt.fetch(`${APP}/dashboard/masuk?next=%2Fpaket`);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/masuk?next=%2Fpaket');
    expect((await rt.fetch(`${APP}/dashboard`)).headers.get('location')).toBe('/');
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

describe('combined cron (Workers Free, ADR-035)', () => {
  it('runs the hourly tasks every hour and the daily ones in their UTC hour', async () => {
    const clock = new FakeClock(Date.UTC(2026, 9, 22, 10, 5));
    const rt = await makeRuntime({ clock });
    const names = async () => (await rt.runCron(CRON.combined)).ran;
    const hourly = await names();
    expect(hourly).toContain('usage_counters_gc');
    expect(hourly).not.toContain('ads_daily');
    expect(hourly).not.toContain('purge_old_logs');
    clock.set(Date.UTC(2026, 9, 22, 17, 5));
    expect(await names()).toEqual(expect.arrayContaining(['usage_counters_gc', 'ads_daily']));
    clock.set(Date.UTC(2026, 9, 22, 19, 5));
    const nightly = await names();
    expect(nightly).toEqual(expect.arrayContaining(['usage_counters_gc', 'purge_old_logs']));
    expect(nightly).not.toContain('ads_daily');
  });
});
