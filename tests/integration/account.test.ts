import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/worker/adapters/clock';
import { DAY_MS } from '../../src/shared/constants';
import { makeRuntime } from '../helpers/runtime';
import { signIn } from '../helpers/session';
import { grantPlan, rootOf, uploadText } from '../helpers/files';

describe('account rights (SPEC §14.5)', () => {
  it('exports personal data as JSON', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'ekspor@example.com');
    await grantPlan(rt, s.userId);
    await uploadText(s, await rootOf(s), 'catatan.txt', 'abc');
    const res = await s.req('GET', '/api/me/export');
    expect(res.headers.get('content-disposition')).toContain('zeiko-data-saya.json');
    const data = (await res.json()) as {
      account: { email: string };
      files: Array<{ name: string }>;
    };
    expect(data.account.email).toBe('ekspor@example.com');
    expect(data.files.map((f) => f.name)).toContain('catatan.txt');
  });

  it('deletes the account after the waiting period, unless cancelled', async () => {
    const clock = new FakeClock(Date.UTC(2026, 9, 1));
    const rt = await makeRuntime({ clock });
    const s = await signIn(rt, 'pergi@example.com');
    await grantPlan(rt, s.userId);
    const f = await uploadText(s, await rootOf(s), 'a.txt', 'abc');
    await rt.settle();
    expect(
      (await s.req('POST', '/api/me/delete', { confirmEmail: 'salah@example.com' })).status,
    ).toBe(400);
    expect(
      (await s.req('POST', '/api/me/delete', { confirmEmail: 'Pergi@Example.com' })).status,
    ).toBe(200);
    clock.advance(6 * DAY_MS);
    await rt.runCron('0 19 * * *');
    await rt.settle();
    expect(rt.d1.sqlite.prepare('SELECT status FROM users WHERE id = ?').get(s.userId)).toEqual({
      status: 'active',
    });
    clock.advance(DAY_MS + 1);
    await rt.runCron('0 19 * * *');
    await rt.settle();
    const u = rt.d1.sqlite
      .prepare('SELECT status, email FROM users WHERE id = ?')
      .get(s.userId) as { status: string; email: string };
    expect(u.status).toBe('deleted');
    expect(u.email).toMatch(/@deleted\.invalid$/);
    expect(rt.d1.sqlite.prepare('SELECT COUNT(*) AS n FROM nodes WHERE id = ?').get(f.id)).toEqual({
      n: 0,
    });
    expect((await s.req('GET', '/api/me')).status).toBe(401);
  });

  it('cancelling keeps the account', async () => {
    const clock = new FakeClock(Date.UTC(2026, 9, 1));
    const rt = await makeRuntime({ clock });
    const s = await signIn(rt, 'batal@example.com');
    await s.req('POST', '/api/me/delete', { confirmEmail: 'batal@example.com' });
    expect((await s.req('DELETE', '/api/me/delete')).status).toBe(204);
    clock.advance(30 * DAY_MS);
    await rt.runCron('0 19 * * *');
    expect(rt.d1.sqlite.prepare('SELECT status FROM users WHERE id = ?').get(s.userId)).toEqual({
      status: 'active',
    });
  });
});
