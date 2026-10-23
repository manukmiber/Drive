// The relay's storage screen (ADR-037): what R2 really holds and was asked to do this billing
// period, what Drive has promised (people × plan, add-ons, bonus), and what is left of the
// rupiah after R2's bill. Prices are R2's list (developers.cloudflare.com/r2/pricing), kept in
// app_config like every other business number.
import type { AppConfig } from '../../shared/config-defaults';
import type { R2Meters } from '../adapters/r2-metrics';
import { utcDays } from '../adapters/r2-metrics';
import type { Ctx } from '../context';
import { errorMessage, log } from '../lib/log';

const DAY_MS = 86_400_000;
/** Cloudflare's analytics lag by minutes anyway; this keeps the screen off its rate limit. */
const CACHE_TTL_S = 600;
const LIVE = `('active', 'grace', 'readonly', 'suspended')`;

// ── R2's price list ──

/** Operation classes as R2 bills them. Deletes and aborts are free; a 401 is not charged. */
const CLASS_A = new Set([
  'ListBuckets',
  'PutBucket',
  'ListObjects',
  'PutObject',
  'CopyObject',
  'CreateMultipartUpload',
  'UploadPart',
  'UploadPartCopy',
  'CompleteMultipartUpload',
  'ListMultipartUploads',
  'ListParts',
  'LifecycleStorageTierTransition',
  'PutBucketEncryption',
  'PutBucketCors',
  'PutBucketLifecycleConfiguration',
]);
const CLASS_B = new Set([
  'HeadBucket',
  'HeadObject',
  'GetObject',
  'UsageSummary',
  'GetBucketEncryption',
  'GetBucketLocation',
  'GetBucketCors',
  'GetBucketLifecycleConfiguration',
]);
const FREE_OPS = new Set(['DeleteObject', 'DeleteObjects', 'DeleteBucket', 'AbortMultipartUpload']);

export type OpClass = 'A' | 'B' | 'free' | 'unknown';

export function opClass(action: string): OpClass {
  if (CLASS_A.has(action)) return 'A';
  if (CLASS_B.has(action)) return 'B';
  if (FREE_OPS.has(action)) return 'free';
  return 'unknown';
}

export interface Tariff {
  storage: number;
  classA: number;
  classB: number;
  retrieval: number;
  free: { storage: number; classA: number; classB: number };
}

export function tariffs(cfg: AppConfig): { standard: Tariff; ia: Tariff } {
  const b = cfg.r2_billing;
  return {
    standard: {
      storage: cfg.r2_storage_usd_per_gb_month,
      classA: cfg.component_tariffs_usd.r2_class_a_per_million,
      classB: cfg.component_tariffs_usd.r2_class_b_per_million,
      retrieval: 0,
      free: { storage: b.free_storage_gb_month, classA: b.free_class_a, classB: b.free_class_b },
    },
    // No free tier for Infrequent Access.
    ia: {
      storage: b.ia_storage_usd_per_gb_month,
      classA: b.ia_class_a_per_million,
      classB: b.ia_class_b_per_million,
      retrieval: b.ia_retrieval_usd_per_gb,
      free: { storage: 0, classA: 0, classB: 0 },
    },
  };
}

/** The billing period holding `now`: from the latest `startDay` (UTC midnight) to the next. */
export function billingCycle(now: number, startDay: number) {
  const d = new Date(now);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  if (d.getUTCDate() < startDay) m -= 1;
  if (m < 0) {
    m = 11;
    y -= 1;
  }
  const start = Date.UTC(y, m, startDay);
  const end = Date.UTC(y, m + 1, startDay);
  return {
    start,
    end,
    days: Math.round((end - start) / DAY_MS),
    elapsedDays: (now - start) / DAY_MS,
    /** UTC days seen so far, today included (a day is billed at its peak). */
    daysSoFar: utcDays(start, now).length,
  };
}

export interface Usage {
  gbMonth: number;
  classA: number;
  classB: number;
  retrievalGb: number;
}

export interface BillLine {
  usage: number;
  free: number;
  /** Whole billing units after the free tier: GB-months, millions of operations, GB. */
  billable: number;
  usd: number;
}

export interface Bill {
  storage: BillLine;
  classA: BillLine;
  classB: BillLine;
  retrieval: BillLine;
  usd: number;
}

/** "Usage is rounded up to the next billing unit": 1,000,001 operations bill as 2 million. */
function line(usage: number, free: number, unit: number, price: number): BillLine {
  const over = Math.max(0, usage - free) / unit;
  const billable = Math.ceil(Number(over.toFixed(6)));
  return { usage, free, billable, usd: billable * price };
}

export function r2Bill(u: Usage, t: Tariff): Bill {
  const storage = line(u.gbMonth, t.free.storage, 1, t.storage);
  const classA = line(u.classA, t.free.classA, 1_000_000, t.classA);
  const classB = line(u.classB, t.free.classB, 1_000_000, t.classB);
  const retrieval = line(t.retrieval ? u.retrievalGb : 0, 0, 1, t.retrieval);
  return {
    storage,
    classA,
    classB,
    retrieval,
    usd: storage.usd + classA.usd + classB.usd + retrieval.usd,
  };
}

const add = (a: Usage, b: Usage): Usage => ({
  gbMonth: a.gbMonth + b.gbMonth,
  classA: a.classA + b.classA,
  classB: a.classB + b.classB,
  retrievalGb: a.retrievalGb + b.retrievalGb,
});

/**
 * What Drive adds to the account's bill: the bill with Drive's bucket minus the bill without it.
 * The free tier is the account's, so it goes to whatever else is in the account first.
 */
export function marginal(drive: Usage, others: Usage, t: Tariff) {
  const all = r2Bill(add(drive, others), t);
  const rest = r2Bill(others, t);
  return {
    storageUsd: all.storage.usd - rest.storage.usd,
    classAUsd: all.classA.usd - rest.classA.usd,
    classBUsd: all.classB.usd - rest.classB.usd,
    usd: all.usd - rest.usd,
    account: all,
  };
}

type Cycle = ReturnType<typeof billingCycle>;

/** One set of buckets' meters, turned into usage so far and projected to the period's end. */
function usageOf(meters: R2Meters, pick: (bucket: string) => boolean, cycle: Cycle, gb: number) {
  const perDay = new Map<
    string,
    { bytes: number; objects: number; uploads: number; a: number; b: number }
  >();
  const day = (d: string) => {
    let v = perDay.get(d);
    if (!v) perDay.set(d, (v = { bytes: 0, objects: 0, uploads: 0, a: 0, b: 0 }));
    return v;
  };
  for (const s of meters.storage) {
    if (!pick(s.bucket)) continue;
    const v = day(s.day);
    v.bytes += s.bytes;
    v.objects += s.objects;
    v.uploads += s.pendingUploads;
  }
  const byAction = new Map<string, number>();
  let classA = 0;
  let classB = 0;
  let freeOps = 0;
  let unknownOps = 0;
  for (const o of meters.ops) {
    if (!pick(o.bucket)) continue;
    byAction.set(o.action, (byAction.get(o.action) ?? 0) + o.requests);
    const c = opClass(o.action);
    if (c === 'A') {
      classA += o.requests;
      day(o.day).a += o.requests;
    } else if (c === 'B') {
      classB += o.requests;
      day(o.day).b += o.requests;
    } else if (c === 'free') freeOps += o.requests;
    else unknownOps += o.requests;
  }
  const daily = [...perDay.entries()]
    .sort(([x], [y]) => (x < y ? -1 : 1))
    .map(([d, v]) => ({
      day: d,
      bytes: v.bytes,
      objects: v.objects,
      pendingUploads: v.uploads,
      classA: v.a,
      classB: v.b,
    }));
  // The latest day R2 reported storage for (a day with only operations says nothing about it).
  const latest = [...daily].reverse().find((d) => d.bytes || d.objects) ?? null;
  const gbDays = daily.reduce((s, d) => s + d.bytes / gb, 0);
  const remaining = Math.max(0, cycle.days - cycle.daysSoFar);
  const download = meters.bandwidth
    .filter((b) => pick(b.bucket))
    .reduce((s, b) => s + b.downloadBytes, 0);
  const upload = meters.bandwidth
    .filter((b) => pick(b.bucket))
    .reduce((s, b) => s + b.uploadBytes, 0);
  // Operations go on at the pace seen so far; a day and a bit is too little to say much, so the
  // pace is never taken over less than one day.
  const pace = cycle.days / Math.max(1, cycle.elapsedDays);
  const soFar: Usage = { gbMonth: gbDays / cycle.days, classA, classB, retrievalGb: download / gb };
  const projected: Usage = {
    gbMonth: (gbDays + ((latest?.bytes ?? 0) / gb) * remaining) / cycle.days,
    classA: Math.round(classA * pace),
    classB: Math.round(classB * pace),
    retrievalGb: (download / gb) * pace,
  };
  return {
    bytes: latest?.bytes ?? 0,
    objects: latest?.objects ?? 0,
    pendingUploads: latest?.pendingUploads ?? 0,
    classA,
    classB,
    freeOps,
    unknownOps,
    downloadBytes: download,
    uploadBytes: upload,
    byAction: [...byAction.entries()]
      .map(([action, requests]) => ({ action, class: opClass(action), requests }))
      .sort((x, y) => y.requests - x.requests),
    daily,
    soFar,
    projected,
  };
}

// ── Cloudflare, cached ──

async function readMeters(ctx: Ctx, cycle: Cycle, now: number) {
  const r2 = ctx.adapters.r2metrics;
  if (r2.name === 'none') return { status: 'off' as const, meters: null, fetchedAt: null };
  const key = `r2meters:v1:${cycle.start}`;
  const cached = await ctx.env.CONFIG_KV.get<{ at: number; meters: R2Meters }>(key, 'json').catch(
    () => null,
  );
  if (cached && now - cached.at < CACHE_TTL_S * 1000)
    return { status: 'ok' as const, meters: cached.meters, fetchedAt: cached.at };
  try {
    const meters = await r2.read(cycle.start, now);
    await ctx.env.CONFIG_KV.put(key, JSON.stringify({ at: now, meters }), {
      expirationTtl: CACHE_TTL_S,
    });
    return { status: 'ok' as const, meters, fetchedAt: now };
  } catch (e) {
    log.warn('r2_metrics_failed', { message: errorMessage(e) });
    return { status: 'error' as const, meters: null, fetchedAt: null, error: errorMessage(e) };
  }
}

// ── The report ──

export async function storageReport(ctx: Ctx) {
  const DB = ctx.env.DB;
  const now = ctx.now();
  const cfg = await ctx.config();
  const t = tariffs(cfg);
  const gb = cfg.r2_billing.gb_bytes;
  const rate = cfg.usd_idr_rate;
  const cycle = billingCycle(now, cfg.r2_billing.cycle_start_day);
  const bucket = ctx.env.R2_BUCKET_NAME ?? '';

  const [cf, pools, noPlan, plans, addons, blobs, uploads, people, earned] = await Promise.all([
    readMeters(ctx, cycle, now),
    DB.prepare(
      `SELECT COUNT(*) AS pools, COALESCE(SUM(limit_bytes), 0) AS limitBytes, COALESCE(SUM(used_bytes), 0) AS usedBytes,
              COALESCE(SUM(reserved_bytes), 0) AS reservedBytes, COALESCE(SUM(bonus_bytes), 0) AS bonusBytes
       FROM storage_pools`,
    ).first<{
      pools: number;
      limitBytes: number;
      usedBytes: number;
      reservedBytes: number;
      bonusBytes: number;
    }>(),
    DB.prepare(
      `SELECT COUNT(*) AS pools, COALESCE(SUM(used_bytes), 0) AS usedBytes, COALESCE(SUM(limit_bytes), 0) AS limitBytes
       FROM storage_pools sp WHERE NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.pool_id = sp.id AND s.status IN ${LIVE})`,
    ).first<{ pools: number; usedBytes: number; limitBytes: number }>(),
    DB.prepare(
      `SELECT s.plan_code AS plan, p.name, p.price_idr AS priceIdr, p.storage_bytes AS quotaBytes, COUNT(*) AS subs,
              SUM(s.status = 'active') AS paying, COALESCE(SUM(sp.used_bytes), 0) AS usedBytes,
              COALESCE(SUM(sp.limit_bytes), 0) AS limitBytes
       FROM subscriptions s JOIN plans p ON p.code = s.plan_code JOIN storage_pools sp ON sp.id = s.pool_id
       WHERE s.status IN ${LIVE} GROUP BY s.plan_code ORDER BY p.price_idr`,
    ).all<{
      plan: string;
      name: string;
      priceIdr: number;
      quotaBytes: number;
      subs: number;
      paying: number;
      usedBytes: number;
      limitBytes: number;
    }>(),
    DB.prepare(
      `SELECT a.code, a.name, a.price_idr AS priceIdr, a.storage_bytes AS storageBytes, SUM(sa.qty) AS qty,
              SUM(CASE WHEN s.status = 'active' THEN sa.qty ELSE 0 END) AS payingQty
       FROM subscription_addons sa JOIN addons a ON a.code = sa.addon_code JOIN subscriptions s ON s.id = sa.subscription_id
       WHERE (sa.ends_at IS NULL OR sa.ends_at > ?1) AND s.status IN ${LIVE} GROUP BY a.code ORDER BY a.storage_bytes`,
    )
      .bind(now)
      .all<{
        code: string;
        name: string;
        priceIdr: number;
        storageBytes: number;
        qty: number;
        payingQty: number;
      }>(),
    DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes, COALESCE(SUM(thumb_key IS NOT NULL), 0) AS thumbs,
              COALESCE(SUM(CASE WHEN refcount = 0 THEN size ELSE 0 END), 0) AS orphanBytes FROM blobs`,
    ).first<{ n: number; bytes: number; thumbs: number; orphanBytes: number }>(),
    DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM uploads WHERE status = 'active'`,
    ).first<{ n: number; bytes: number }>(),
    DB.prepare(
      `SELECT (SELECT COUNT(*) FROM users WHERE status != 'deleted') AS total,
              (SELECT COUNT(DISTINCT payer_user_id) FROM subscriptions WHERE status IN ${LIVE}) AS subscribers,
              (SELECT COUNT(DISTINCT payer_user_id) FROM subscriptions WHERE status = 'active') AS paying`,
    ).first<{ total: number; subscribers: number; paying: number }>(),
    DB.prepare(
      `SELECT reason, -SUM(delta_idr) AS idr, COUNT(*) AS n FROM wallet_ledger
       WHERE delta_idr < 0 AND created_at >= ?1 AND reason IN ('plan', 'upgrade', 'renewal', 'addon') GROUP BY reason`,
    )
      .bind(cycle.start)
      .all<{ reason: string; idr: number; n: number }>(),
  ]);

  // ── allocation: what Drive has promised ──
  const planRows = plans.results.map((p) => ({
    ...p,
    paying: p.paying ?? 0,
    allocatedBytes: p.subs * p.quotaBytes,
    revenueIdr: (p.paying ?? 0) * p.priceIdr,
  }));
  const addonRows = addons.results.map((a) => ({
    ...a,
    bytes: a.qty * a.storageBytes,
    revenueIdr: (a.payingQty ?? 0) * a.priceIdr,
  }));
  const allocatedBytes = pools?.limitBytes ?? 0;
  const mrrIdr =
    planRows.reduce((s, p) => s + p.revenueIdr, 0) +
    addonRows.reduce((s, a) => s + a.revenueIdr, 0);

  // ── real usage: R2's meters when connected, Drive's own count otherwise ──
  const meters = cf.meters;
  const drive = meters ? usageOf(meters, (b) => b === bucket, cycle, gb) : null;
  const others = meters ? usageOf(meters, (b) => b !== bucket, cycle, gb) : null;
  const bucketSeen = Boolean(meters?.storage.some((s) => s.bucket === bucket));
  // Without the meters, Drive's blobs are what it believes R2 holds, for the whole period, and
  // operations are unknown (not zero — the screen says so).
  const accountedBytes = blobs?.bytes ?? 0;
  const none: Usage = { gbMonth: 0, classA: 0, classB: 0, retrievalGb: 0 };
  const driveProjected: Usage = drive?.projected ?? { ...none, gbMonth: accountedBytes / gb };
  const driveSoFar: Usage = drive?.soFar ?? {
    ...none,
    gbMonth: ((accountedBytes / gb) * cycle.daysSoFar) / cycle.days,
  };
  const othersProjected = others?.projected ?? none;
  const othersSoFar = others?.soFar ?? none;
  const realBytes = drive ? drive.bytes : accountedBytes;

  const cost = marginal(driveProjected, othersProjected, t.standard);
  const costSoFar = marginal(driveSoFar, othersSoFar, t.standard);
  const idr = (usd: number) => Math.round(usd * rate);

  // ── profit: a month of recurring revenue against a month of R2 and the rest ──
  const feePct = cfg.payment_methods.find((m) => m.code === 'qris')?.fee_pct ?? 0;
  const feesIdr = Math.round((mrrIdr * feePct) / 100);
  const fixedIdr = idr(cfg.fixed_costs_usd_per_month);
  const opsUsd = cost.classAUsd + cost.classBUsd;
  const profitAt = (driveGbMonth: number) => {
    const c = marginal({ ...driveProjected, gbMonth: driveGbMonth }, othersProjected, t.standard);
    return { r2Idr: idr(c.usd), profitIdr: mrrIdr - idr(c.usd) - feesIdr - fixedIdr };
  };
  const full = profitAt(allocatedBytes / gb);
  const perGbIdr = t.standard.storage * rate;
  const breakEvenFillPct =
    allocatedBytes > 0 && perGbIdr > 0
      ? Math.round(
          ((mrrIdr - feesIdr - fixedIdr - idr(opsUsd)) / ((allocatedBytes / gb) * perGbIdr)) * 1000,
        ) / 10
      : null;

  const ia = r2Bill(driveProjected, t.ia);
  const standardAlone = r2Bill(driveProjected, t.standard);

  return {
    now,
    cycle: { start: cycle.start, end: cycle.end, days: cycle.days, elapsedDays: cycle.elapsedDays },
    tariffs: {
      ...t,
      gbBytes: gb,
      usdIdrRate: rate,
      qrisFeePct: feePct,
      fixedUsdPerMonth: cfg.fixed_costs_usd_per_month,
    },
    cloudflare: {
      status: cf.status,
      error: 'error' in cf ? cf.error : null,
      fetchedAt: cf.fetchedAt,
      bucket,
      bucketSeen,
      buckets: meters ? bucketTable(meters, cycle, gb) : [],
    },
    real: {
      source: drive ? ('cloudflare' as const) : ('drive' as const),
      bytes: realBytes,
      objects: drive ? drive.objects : (blobs?.n ?? 0),
      pendingUploads: drive ? drive.pendingUploads : (uploads?.n ?? 0),
      gbMonthSoFar: driveSoFar.gbMonth,
      gbMonthProjected: driveProjected.gbMonth,
      ops: drive
        ? {
            classA: drive.classA,
            classB: drive.classB,
            free: drive.freeOps,
            unknown: drive.unknownOps,
            classAProjected: drive.projected.classA,
            classBProjected: drive.projected.classB,
            byAction: drive.byAction,
          }
        : null,
      downloadBytes: drive ? drive.downloadBytes : null,
      uploadBytes: drive ? drive.uploadBytes : null,
      daily: drive?.daily ?? [],
    },
    accounted: {
      usedBytes: pools?.usedBytes ?? 0,
      reservedBytes: pools?.reservedBytes ?? 0,
      blobs: blobs?.n ?? 0,
      blobBytes: accountedBytes,
      thumbnails: blobs?.thumbs ?? 0,
      orphanBytes: blobs?.orphanBytes ?? 0,
      pendingUploads: uploads?.n ?? 0,
      pendingUploadBytes: uploads?.bytes ?? 0,
    },
    allocation: {
      bytes: allocatedBytes,
      pools: pools?.pools ?? 0,
      bonusBytes: pools?.bonusBytes ?? 0,
      plans: planRows,
      addons: addonRows,
      noPlan: {
        pools: noPlan?.pools ?? 0,
        usedBytes: noPlan?.usedBytes ?? 0,
        limitBytes: noPlan?.limitBytes ?? 0,
      },
      people: {
        total: people?.total ?? 0,
        subscribers: people?.subscribers ?? 0,
        paying: people?.paying ?? 0,
      },
    },
    bill: {
      // Drive's share, projected to the period's end and so far.
      projected: {
        storageUsd: cost.storageUsd,
        classAUsd: cost.classAUsd,
        classBUsd: cost.classBUsd,
        usd: cost.usd,
        idr: idr(cost.usd),
      },
      soFar: { usd: costSoFar.usd, idr: idr(costSoFar.usd) },
      // The whole account, line by line, as Cloudflare would invoice it.
      account: cost.account,
      accountSoFar: costSoFar.account,
      // Drive's bucket on its own, Standard against Infrequent Access.
      standardAlone,
      ia,
    },
    money: {
      mrrIdr,
      earnedIdr: earned.results.reduce((s, r) => s + r.idr, 0),
      earned: earned.results,
      costs: {
        storageIdr: idr(cost.storageUsd),
        classAIdr: idr(cost.classAUsd),
        classBIdr: idr(cost.classBUsd),
        paymentFeesIdr: feesIdr,
        fixedIdr,
      },
      profitIdr: mrrIdr - idr(cost.usd) - feesIdr - fixedIdr,
      atFull: full,
      breakEvenFillPct,
      scenarios: cfg.usage_scenarios_pct.map((pct) => ({
        pct,
        ...profitAt(((allocatedBytes / gb) * pct) / 100),
      })),
      perGbIdr,
    },
  };
}

/** Every bucket in the account, so the free tier's other users are visible. */
function bucketTable(meters: R2Meters, cycle: Cycle, gb: number) {
  const names = new Set(
    [...meters.storage, ...meters.ops, ...meters.bandwidth].map((r) => r.bucket),
  );
  return [...names]
    .map((name) => {
      const u = usageOf(meters, (b) => b === name, cycle, gb);
      return {
        name,
        bytes: u.bytes,
        objects: u.objects,
        classA: u.classA,
        classB: u.classB,
        downloadBytes: u.downloadBytes,
      };
    })
    .sort((a, b) => b.bytes - a.bytes);
}
