import { describe, expect, it } from 'vitest';
import { RelayNotices } from '../../src/worker/adapters/notices';
import { AppError } from '../../src/worker/lib/errors';

const TOKEN = 'drive-app-token-for-tests-0123456789';

/** A stand-in relay: records what Drive asked and answers from `reply`. */
function relay(reply: (path: string, body: unknown) => [number, unknown]) {
  const asked: Array<{ method: string; path: string; body: unknown; auth: string | null }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname + url.search;
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    asked.push({
      method: init?.method ?? 'GET',
      path,
      body,
      auth: new Headers(init?.headers).get('authorization'),
    });
    const [status, data] = reply(path, body);
    return new Response(JSON.stringify(data), { status });
  }) as typeof fetch;
  return { asked, store: new RelayNotices('https://auth.example.test/', TOKEN, fetcher) };
}

describe('notices on the relay (ADR-064)', () => {
  it('speaks the relay’s /apps/v1 notice routes with the app token', async () => {
    const { asked, store } = relay((path) => {
      if (path === '/apps/v1/notices') return [200, { id: 'n1', emailOff: true }];
      if (path.startsWith('/apps/v1/notices?'))
        return [
          200,
          {
            unread: 1,
            items: [{ id: 'n1', type: 'quota', payload: { pct: 80 }, readAt: null, createdAt: 5 }],
          },
        ];
      if (path.startsWith('/apps/v1/notices/prefs?'))
        return [200, { items: [{ type: 'quota', channel: 'email', enabled: false }] }];
      if (path.startsWith('/apps/v1/suppressions/')) return [200, { suppressed: true }];
      return [200, {}];
    });
    expect(
      await store.add({
        id: 'n1',
        userId: 'u 1',
        type: 'quota',
        payload: { pct: 80 },
        createdAt: 5,
      }),
    ).toEqual({ emailOff: true });
    expect((await store.list('u 1', 50)).items[0]?.payload).toEqual({ pct: 80 });
    expect(await store.prefs('u 1')).toEqual([{ type: 'quota', channel: 'email', enabled: false }]);
    await store.markRead('u 1', 'all');
    await store.setPref('u 1', { type: 'quota', channel: 'email', enabled: true });
    await store.forget('u 1');
    await store.prune(123);
    expect(await store.suppressed('ab'.repeat(32))).toBe(true);
    await store.suppress('ab'.repeat(32), 'unsubscribe');
    expect(asked.map((a) => `${a.method} ${a.path}`)).toEqual([
      'POST /apps/v1/notices',
      'GET /apps/v1/notices?userId=u%201&limit=50',
      'GET /apps/v1/notices/prefs?userId=u%201',
      'POST /apps/v1/notices/read',
      'POST /apps/v1/notices/prefs',
      'POST /apps/v1/notices/forget',
      'POST /apps/v1/notices/prune',
      `GET /apps/v1/suppressions/${'ab'.repeat(32)}`,
      'POST /apps/v1/suppressions',
    ]);
    expect(new Set(asked.map((a) => a.auth))).toEqual(new Set([`Bearer ${TOKEN}`]));
    expect(asked[3]?.body).toEqual({ userId: 'u 1', ids: 'all' });
  });

  it('throws ACCOUNTS_UNAVAILABLE when the relay does not have the routes or refuses', async () => {
    for (const status of [404, 400, 503]) {
      const { store } = relay(() => [status, { error: { message: 'no' } }]);
      const err = await store
        .add({ id: 'n1', userId: 'u1', type: 'quota', payload: {}, createdAt: 1 })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('ACCOUNTS_UNAVAILABLE');
    }
  });
});
