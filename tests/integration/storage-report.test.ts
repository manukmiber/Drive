import { describe, expect, it } from 'vitest';
import { CONFIG_DEFAULTS } from '../../src/shared/config-defaults';
import { GIB } from '../../src/shared/constants';
import { FakeClock } from '../../src/worker/adapters/clock';
import { GRAPHQL_URL, meterQuery, utcDays } from '../../src/worker/adapters/r2-metrics';
import {
  billingCycle,
  marginal,
  opClass,
  r2Bill,
  tariffs,
} from '../../src/worker/services/storage-report';
import { APP, makeRuntime } from '../helpers/runtime';
import { signIn } from '../helpers/session';

// The relay's storage screen (ADR-037): R2's bill from R2's own meters, against what Drive sold.
const KEY = 'ops-key-for-tests-0123456789abcdef';
const T0 = Date.UTC(2026, 9, 11, 12); // 11 Oct 2026, 12:00 UTC: day 11 of a 31-day period
const t = tariffs(CONFIG_DEFAULTS);

describe('R2 price list', () => {
  it('classes operations the way R2 bills them', () => {
    expect(
      ['PutObject', 'UploadPart', 'CompleteMultipartUpload', 'ListObjects'].map(opClass),
    ).toEqual(['A', 'A', 'A', 'A']);
    expect(['GetObject', 'HeadObject'].map(opClass)).toEqual(['B', 'B']);
    expect(['DeleteObject', 'AbortMultipartUpload'].map(opClass)).toEqual(['free', 'free']);
    expect(opClass('SomethingNew')).toBe('unknown');
  });

  it('matches the two worked examples on the pricing page', () => {
    const standard = r2Bill(
      { gbMonth: 1000, classA: 1000, classB: 1_000_000, retrievalGb: 1000 },
      t.standard,
    );
    expect(standard.storage.billable).toBe(990);
    expect(standard.usd).toBeCloseTo(14.85, 6);
    const ia = r2Bill({ gbMonth: 1000, classA: 1000, classB: 1_000_000, retrievalGb: 1000 }, t.ia);
    expect(ia.usd).toBeCloseTo(29.9, 6);
  });

  it('rounds up to the next unit after the free tier', () => {
    const b = r2Bill(
      { gbMonth: 11.1, classA: 2_000_001, classB: 10_000_000, retrievalGb: 0 },
      t.standard,
    );
    expect(b.storage.billable).toBe(2);
    expect(b.classA.billable).toBe(2);
    expect(b.classB.billable).toBe(0);
  });

  it('gives the free tier to the rest of the account first', () => {
    const drive = { gbMonth: 5, classA: 0, classB: 0, retrievalGb: 0 };
    const others = { gbMonth: 8, classA: 0, classB: 0, retrievalGb: 0 };
    expect(marginal(drive, others, t.standard).storageUsd).toBeCloseTo(3 * 0.015, 9);
    expect(marginal(drive, { ...others, gbMonth: 0 }, t.standard).storageUsd).toBe(0);
  });

  it('finds the billing period around now', () => {
    expect(billingCycle(T0, 1)).toMatchObject({
      start: Date.UTC(2026, 9, 1),
      end: Date.UTC(2026, 10, 1),
      days: 31,
      daysSoFar: 11,
    });
    const late = billingCycle(T0, 25);
    expect(late).toMatchObject({
      start: Date.UTC(2026, 8, 25),
      end: Date.UTC(2026, 9, 25),
      days: 30,
    });
    expect(billingCycle(Date.UTC(2027, 0, 5), 10).start).toBe(Date.UTC(2026, 11, 10));
  });

  it('asks Cloudflare one day at a time, with documented fields only', () => {
    const days = utcDays(Date.UTC(2026, 9, 1), T0);
    expect(days).toHaveLength(11);
    expect(days[10]).toMatchObject({ day: '2026-10-11', to: T0 });
    const q = meterQuery(days);
    expect(q).toContain('s10: r2StorageAdaptiveGroups');
    expect(q).toContain('o10: r2OperationsAdaptiveGroups');
    expect(q).toContain('max { payloadSize metadataSize objectCount uploadCount }');
  });
});

/** A stand-in for Cloudflare's GraphQL API: the same meters every day. */
function fakeCloudflare(calls: string[], answer?: () => Response) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== GRAPHQL_URL) return realFetch(input, init);
    calls.push(String(new Headers(init?.headers).get('authorization')));
    if (answer) return answer();
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    const days = [...query.matchAll(/s(\d+): r2StorageAdaptiveGroups/g)].length;
    const account: Record<string, unknown> = {};
    for (let i = 0; i < days; i++) {
      account[`s${i}`] = [
        {
          max: {
            payloadSize: 100 * GIB - 1000,
            metadataSize: 1000,
            objectCount: 5000,
            uploadCount: 2,
          },
          dimensions: { bucketName: 'zeiko-test' },
        },
        {
          max: { payloadSize: GIB, metadataSize: 0, objectCount: 3, uploadCount: 0 },
          dimensions: { bucketName: 'zeiko-models' },
        },
      ];
      account[`o${i}`] = [
        {
          sum: { requests: 30_000 },
          dimensions: { bucketName: 'zeiko-test', actionType: 'PutObject' },
        },
        {
          sum: { requests: 20_000 },
          dimensions: { bucketName: 'zeiko-test', actionType: 'UploadPart' },
        },
        {
          sum: { requests: 500_000 },
          dimensions: { bucketName: 'zeiko-test', actionType: 'GetObject' },
        },
        {
          sum: { requests: 100_000 },
          dimensions: { bucketName: 'zeiko-test', actionType: 'HeadObject' },
        },
        {
          sum: { requests: 1_000 },
          dimensions: { bucketName: 'zeiko-test', actionType: 'DeleteObject' },
        },
        {
          sum: { requests: 7 },
          dimensions: { bucketName: 'zeiko-test', actionType: 'SomethingNew' },
        },
        {
          sum: { requests: 24 },
          dimensions: { bucketName: 'zeiko-models', actionType: 'PutObject' },
        },
        {
          sum: { requests: 1_000 },
          dimensions: { bucketName: 'zeiko-models', actionType: 'GetObject' },
        },
      ];
    }
    account.bw = [
      {
        sum: { bytesDownload: 50 * GIB, bytesUpload: 20 * GIB },
        dimensions: { bucketName: 'zeiko-test' },
      },
    ];
    return Response.json({ data: { viewer: { accounts: [account] } }, errors: null });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

async function setup(vars: Record<string, string> = {}) {
  const rt = await makeRuntime({
    clock: new FakeClock(T0),
    vars: { ZEIKO_OPS_TOKEN: KEY, R2_BUCKET_NAME: 'zeiko-test', ...vars },
  });
  const ops = async (method: string, path: string, body?: unknown) =>
    rt.fetch(
      new Request(`${APP}/api/ops${path}`, {
        method,
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  return { rt, ops };
}

interface Report {
  cloudflare: {
    status: string;
    error: string | null;
    bucketSeen: boolean;
    buckets: Array<{ name: string }>;
  };
  real: {
    source: string;
    bytes: number;
    objects: number;
    pendingUploads: number;
    gbMonthProjected: number;
    ops: null | {
      classA: number;
      classB: number;
      free: number;
      unknown: number;
      classAProjected: number;
    };
    daily: unknown[];
  };
  allocation: {
    bytes: number;
    bonusBytes: number;
    plans: Array<{
      plan: string;
      subs: number;
      paying: number;
      allocatedBytes: number;
      revenueIdr: number;
    }>;
    people: { subscribers: number; paying: number };
  };
  bill: {
    projected: {
      storageUsd: number;
      classAUsd: number;
      classBUsd: number;
      usd: number;
      idr: number;
    };
  };
  money: {
    mrrIdr: number;
    profitIdr: number;
    costs: { paymentFeesIdr: number; fixedIdr: number };
    atFull: { r2Idr: number; profitIdr: number };
    scenarios: Array<{ pct: number }>;
  };
  tariffs: { usdIdrRate: number };
}

describe('GET /api/ops/storage', () => {
  it('bills R2 from its own meters and sets it against people × plan', async () => {
    const calls: string[] = [];
    const restore = fakeCloudflare(calls);
    try {
      const { rt, ops } = await setup({ CF_ACCOUNT_ID: 'acc123', CF_ANALYTICS_TOKEN: 'cf-token' });
      const a = await signIn(rt, 'plus@example.com');
      const b = await signIn(rt, 'mini@example.com');
      const why = { reason: 'tes laporan storage' };
      expect(
        (await ops('POST', `/users/${a.userId}/plan`, { planCode: 'plus', months: 1, ...why }))
          .status,
      ).toBe(204);
      expect(
        (await ops('POST', `/users/${b.userId}/plan`, { planCode: 'mini', months: 1, ...why }))
          .status,
      ).toBe(204);
      expect(
        (await ops('POST', `/users/${b.userId}/bonus`, { bonusBytes: 5 * GIB, ...why })).status,
      ).toBe(204);

      const res = await ops('GET', '/storage');
      expect(res.status, await res.clone().text()).toBe(200);
      const d = (await res.json()) as Report;
      expect(calls).toEqual(['Bearer cf-token']);

      expect(d.cloudflare).toMatchObject({ status: 'ok', bucketSeen: true });
      expect(d.cloudflare.buckets.map((x) => x.name)).toEqual(['zeiko-test', 'zeiko-models']);
      expect(d.real).toMatchObject({
        source: 'cloudflare',
        bytes: 100 * GIB,
        objects: 5000,
        pendingUploads: 2,
      });
      expect(d.real.daily).toHaveLength(11);
      // 11 days at 100 GB, then the same for the 20 days left.
      expect(d.real.gbMonthProjected).toBeCloseTo(100, 9);
      expect(d.real.ops).toMatchObject({
        classA: 11 * 50_000,
        classB: 11 * 600_000,
        free: 11_000,
        unknown: 77,
      });
      expect(d.real.ops!.classAProjected).toBe(Math.round(11 * 50_000 * (31 / 10.5)));

      // Account: 101 GB-month − 10 free → 91; A ≈ 1.62M − 1M → 1 million; B ≈ 19.5M − 10M → 10 million.
      expect(d.bill.projected.storageUsd).toBeCloseTo(91 * 0.015, 9);
      expect(d.bill.projected.classAUsd).toBeCloseTo(4.5, 9);
      expect(d.bill.projected.classBUsd).toBeCloseTo(3.6, 9);
      expect(d.bill.projected.idr).toBe(
        Math.round((91 * 0.015 + 4.5 + 3.6) * d.tariffs.usdIdrRate),
      );

      const plan = (code: string) => d.allocation.plans.find((p) => p.plan === code)!;
      expect(plan('plus')).toMatchObject({
        subs: 1,
        paying: 1,
        allocatedBytes: 120 * GIB,
        revenueIdr: 25_000,
      });
      expect(plan('mini')).toMatchObject({ subs: 1, allocatedBytes: 3 * GIB, revenueIdr: 1_000 });
      expect(d.allocation).toMatchObject({ bytes: 128 * GIB, bonusBytes: 5 * GIB });
      expect(d.allocation.people).toMatchObject({ subscribers: 2, paying: 2 });

      expect(d.money.mrrIdr).toBe(26_000);
      expect(d.money.profitIdr).toBe(
        26_000 - d.bill.projected.idr - d.money.costs.paymentFeesIdr - d.money.costs.fixedIdr,
      );
      // Every promised GB filled: 128 + 1 − 10 → 119 GB-month.
      expect(d.money.atFull.r2Idr).toBe(
        Math.round((119 * 0.015 + 4.5 + 3.6) * d.tariffs.usdIdrRate),
      );
      expect(d.money.scenarios.map((s) => s.pct)).toEqual([20, 50, 100]);

      // Cached: a second look does not ask Cloudflare again.
      expect((await ops('GET', '/storage')).status).toBe(200);
      expect(calls).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it('falls back to Drive’s own count and says operations are unknown when not set up', async () => {
    const { ops } = await setup();
    const d = (await (await ops('GET', '/storage')).json()) as Report;
    expect(d.cloudflare.status).toBe('off');
    expect(d.real.source).toBe('drive');
    expect(d.real.ops).toBeNull();
    expect(d.bill.projected.usd).toBe(0);
  });

  it('says what Cloudflare refused, and still answers', async () => {
    const calls: string[] = [];
    const restore = fakeCloudflare(calls, () =>
      Response.json({ data: null, errors: [{ message: 'not authorized for that account' }] }),
    );
    try {
      const { ops } = await setup({ CF_ACCOUNT_ID: 'acc123', CF_ANALYTICS_TOKEN: 'wrong' });
      const d = (await (await ops('GET', '/storage')).json()) as Report;
      expect(d.cloudflare.status).toBe('error');
      expect(d.cloudflare.error).toContain('not authorized');
      expect(d.real.source).toBe('drive');
    } finally {
      restore();
    }
  });
});
