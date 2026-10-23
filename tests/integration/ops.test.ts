import { describe, expect, it } from 'vitest';
import { GIB } from '../../src/shared/constants';
import { APP, makeRuntime } from '../helpers/runtime';
import { signIn } from '../helpers/session';

// The relay's Zeiko Drive screen calls these (ADR-036).
const KEY = 'ops-key-for-tests-0123456789abcdef';

async function setup() {
  const rt = await makeRuntime({ vars: { ZEIKO_OPS_TOKEN: KEY } });
  const ops = (method: string, path: string, body?: unknown, key = KEY) =>
    rt.fetch(
      new Request(`${APP}/api/ops${path}`, {
        method,
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  return { rt, ops };
}

describe('ops API for the relay', () => {
  it('is a 404 without the key, or with no key set at all', async () => {
    const { ops } = await setup();
    expect((await ops('GET', '/overview', undefined, 'wrong-wrong-wrong-wrong-wrong-wrong')).status).toBe(404);
    const bare = await makeRuntime();
    const res = await bare.fetch(
      new Request(`${APP}/api/ops/overview`, { headers: { authorization: 'Bearer ' } }),
    );
    expect(res.status).toBe(404);
  });

  it('shows profit with fixed costs and the assumptions behind it', async () => {
    const { ops } = await setup();
    const res = await ops('GET', '/overview?days=30');
    expect(res.status).toBe(200);
    const d = (await res.json()) as {
      costs: { fixedIdr: number; totalIdr: number };
      assumptions: { usdIdrRate: number; r2UsdPerGbMonth: number };
      marginIdr: number;
    };
    expect(d.costs.fixedIdr).toBe(5 * d.assumptions.usdIdrRate);
    expect(d.marginIdr).toBe(-d.costs.totalIdr);
  });

  it('edits the catalog and config only with a reason, and audits it as the operator', async () => {
    const { ops } = await setup();
    expect((await ops('PATCH', '/catalog/plans/plus', { price_idr: 30_000 })).status).toBe(400);
    expect(
      (await ops('PATCH', '/catalog/plans/plus', { price_idr: 30_000, reason: 'harga baru' })).status,
    ).toBe(204);
    const cat = (await (await ops('GET', '/catalog')).json()) as {
      plans: Array<{ code: string; price_idr: number }>;
    };
    expect(cat.plans.find((p) => p.code === 'plus')?.price_idr).toBe(30_000);

    expect((await ops('PUT', '/config/min_topup_idr', { value: 20_000 })).status).toBe(400);
    expect(
      (await ops('PUT', '/config/min_topup_idr', { value: 20_000, reason: 'biaya QRIS' })).status,
    ).toBe(200);
    const audit = (await (await ops('GET', '/audit')).json()) as {
      items: Array<{ actorId: string; action: string }>;
    };
    expect(audit.items.map((a) => a.action)).toContain('catalog.update');
    expect(audit.items.every((a) => a.actorId === 'relay-operator')).toBe(true);
  });

  it('gives a plan, Saldo and bonus storage to a person', async () => {
    const { rt, ops } = await setup();
    const s = await signIn(rt, 'teman@example.com');
    const why = { reason: 'kompensasi gangguan' };
    expect((await ops('POST', `/users/${s.userId}/plan`, { planCode: 'plus', months: 2, ...why })).status).toBe(204);
    expect((await ops('POST', `/users/${s.userId}/balance`, { deltaIdr: 15_000, ...why })).status).toBe(200);
    expect((await ops('POST', `/users/${s.userId}/bonus`, { bonusBytes: 5 * GIB, ...why })).status).toBe(204);
    const found = (await (await ops('GET', '/users?q=teman')).json()) as {
      items: Array<{ planCode: string; balanceIdr: number; bonusBytes: number; limitBytes: number }>;
    };
    expect(found.items[0]).toMatchObject({ planCode: 'plus', balanceIdr: 15_000, bonusBytes: 5 * GIB });
    const me = (await (await s.req('GET', '/api/me')).json()) as {
      storage: { limitBytes: number };
      subscription: { planCode: string } | null;
    };
    expect(me.subscription?.planCode).toBe('plus');
    expect(me.storage.limitBytes).toBe(found.items[0]!.limitBytes);
  });

  it('answers for a page of Zeiko Accounts, by their ids (ADR-040)', async () => {
    const { rt, ops } = await setup();
    const a = await signIn(rt, 'ani@example.com');
    await signIn(rt, 'budi@example.com');
    await ops('POST', `/users/${a.userId}/plan`, { planCode: 'plus', months: 1, reason: 'uji coba' });
    // More ids than one statement may bind, most of them nobody's.
    const ids = [
      'zk_ani_example_com',
      ...Array.from({ length: 150 }, (_, i) => `zk_nobody_${i}`),
      'zk_budi_example_com',
    ];
    const res = await ops('POST', '/people', { zeikoIds: ids });
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as {
      items: Record<string, { id: string; planCode: string | null; planName: string | null; balanceIdr: number }>;
    };
    expect(Object.keys(items).sort()).toEqual(['zk_ani_example_com', 'zk_budi_example_com']);
    expect(items.zk_ani_example_com).toMatchObject({ id: a.userId, planCode: 'plus', planName: 'Plus', balanceIdr: 0 });
    expect(items.zk_budi_example_com?.planCode).toBeNull();
    expect((await ops('POST', '/people', { zeikoIds: ['x'] }, 'wrong-wrong-wrong-wrong-wrong-wrong')).status).toBe(404);
  });
});
