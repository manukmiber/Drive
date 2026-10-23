// R2's own meters (ADR-037), read from Cloudflare's GraphQL Analytics API — the same datasets the
// Cloudflare dashboard and the bill are built from (developers.cloudflare.com/r2/platform/
// metrics-analytics). Drive's D1 knows what it *accounted*; only these know what R2 *holds* and
// how many Class A/B operations it was asked for. Server to server with an API token that has
// Account Analytics: Read (`CF_ANALYTICS_TOKEN`) for `CF_ACCOUNT_ID`.
//
// Every bucket in the account is read, not just Drive's: R2's free tier is per account, so what
// Drive adds to the bill depends on what the other buckets already use.

/** One bucket's peak on one UTC day: what R2 averages into GB-months. */
export interface R2StorageDay {
  bucket: string;
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  /** Payload + metadata, the billed size. */
  bytes: number;
  objects: number;
  /** Multipart uploads started and not yet completed or aborted. */
  pendingUploads: number;
}

export interface R2OpsDay {
  bucket: string;
  day: string;
  /** The S3-style name R2 reports, e.g. `PutObject`, `GetObject`. */
  action: string;
  requests: number;
}

export interface R2Bandwidth {
  bucket: string;
  /** Transfers under 100 KiB are not counted by Cloudflare. */
  downloadBytes: number;
  uploadBytes: number;
}

export interface R2Meters {
  storage: R2StorageDay[];
  ops: R2OpsDay[];
  bandwidth: R2Bandwidth[];
}

export interface R2Metrics {
  readonly name: string;
  /** Every bucket in the account, per UTC day from `from` up to `to` (at most 31 days). */
  read(from: number, to: number): Promise<R2Meters>;
}

export const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
const DAY_MS = 86_400_000;
/** The API refuses ranges longer than this. */
export const MAX_RANGE_DAYS = 31;

/** UTC midnight-aligned days covering [from, to). */
export function utcDays(
  from: number,
  to: number,
): Array<{ day: string; from: number; to: number }> {
  const out: Array<{ day: string; from: number; to: number }> = [];
  for (let start = Math.floor(from / DAY_MS) * DAY_MS; start < to; start += DAY_MS) {
    out.push({
      day: new Date(start).toISOString().slice(0, 10),
      from: Math.max(start, from),
      to: Math.min(start + DAY_MS, to),
    });
  }
  return out;
}

/**
 * One request for the whole period. Storage and operations are asked once per day (aliases
 * `s0…`, `o0…`) and grouped by bucket only, using just the fields Cloudflare documents: `max`
 * over a day is that day's peak, which is exactly what R2 bills, and nothing depends on how often
 * Cloudflare samples.
 */
export function meterQuery(days: Array<{ from: number; to: number }>): string {
  const range = (d: { from: number; to: number }) =>
    `{ datetime_geq: "${new Date(d.from).toISOString()}", datetime_lt: "${new Date(d.to).toISOString()}" }`;
  const parts = days.map(
    (d, i) => `
      s${i}: r2StorageAdaptiveGroups(limit: 1000, filter: ${range(d)}) {
        max { payloadSize metadataSize objectCount uploadCount }
        dimensions { bucketName }
      }
      o${i}: r2OperationsAdaptiveGroups(limit: 10000, filter: ${range(d)}) {
        sum { requests }
        dimensions { bucketName actionType }
      }`,
  );
  const whole = { from: days[0]!.from, to: days[days.length - 1]!.to };
  return `query R2Meters($account: string!) {
  viewer {
    accounts(filter: { accountTag: $account }) {${parts.join('')}
      bw: r2BandwidthUsageAdaptiveGroups(limit: 1000, filter: ${range(whole)}) {
        sum { bytesDownload bytesUpload }
        dimensions { bucketName }
      }
    }
  }
}`;
}

interface StorageGroup {
  max?: { payloadSize?: number; metadataSize?: number; objectCount?: number; uploadCount?: number };
  dimensions?: { bucketName?: string };
}
interface OpsGroup {
  sum?: { requests?: number };
  dimensions?: { bucketName?: string; actionType?: string };
}
interface BandwidthGroup {
  sum?: { bytesDownload?: number; bytesUpload?: number };
  dimensions?: { bucketName?: string };
}

/** Turns the API's answer into plain rows, day by day. */
export function parseMeters(
  account: Record<string, unknown>,
  days: Array<{ day: string }>,
): R2Meters {
  const storage: R2StorageDay[] = [];
  const ops: R2OpsDay[] = [];
  days.forEach(({ day }, i) => {
    for (const g of (account[`s${i}`] as StorageGroup[] | undefined) ?? []) {
      storage.push({
        bucket: g.dimensions?.bucketName ?? '',
        day,
        bytes: (g.max?.payloadSize ?? 0) + (g.max?.metadataSize ?? 0),
        objects: g.max?.objectCount ?? 0,
        pendingUploads: g.max?.uploadCount ?? 0,
      });
    }
    for (const g of (account[`o${i}`] as OpsGroup[] | undefined) ?? []) {
      ops.push({
        bucket: g.dimensions?.bucketName ?? '',
        day,
        action: g.dimensions?.actionType ?? 'unknown',
        requests: g.sum?.requests ?? 0,
      });
    }
  });
  const bandwidth = ((account.bw as BandwidthGroup[] | undefined) ?? []).map((g) => ({
    bucket: g.dimensions?.bucketName ?? '',
    downloadBytes: g.sum?.bytesDownload ?? 0,
    uploadBytes: g.sum?.bytesUpload ?? 0,
  }));
  return { storage, ops, bandwidth };
}

export class GraphqlR2Metrics implements R2Metrics {
  readonly name = 'cloudflare';
  constructor(
    private accountId: string,
    private token: string,
    private fetcher: typeof fetch = (...a) => fetch(...a),
  ) {}

  async read(from: number, to: number): Promise<R2Meters> {
    if (to - from > MAX_RANGE_DAYS * DAY_MS) throw new Error('r2 metrics: more than 31 days');
    const days = utcDays(from, to);
    if (!days.length) return { storage: [], ops: [], bandwidth: [] };
    const res = await this.fetcher(GRAPHQL_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: meterQuery(days), variables: { account: this.accountId } }),
    });
    const body = (await res.json().catch(() => null)) as {
      data?: { viewer?: { accounts?: Array<Record<string, unknown>> } } | null;
      errors?: Array<{ message?: string }> | null;
    } | null;
    if (!res.ok || body?.errors?.length) {
      const why = body?.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
      throw new Error(`Cloudflare analytics: ${why}`);
    }
    const account = body?.data?.viewer?.accounts?.[0];
    if (!account) throw new Error('Cloudflare analytics: account not found for that token');
    return parseMeters(account, days);
  }
}

/** Not set up: the storage screen falls back to Drive's own counts and says so. */
export class NoR2Metrics implements R2Metrics {
  readonly name = 'none';
  async read(): Promise<R2Meters> {
    throw new Error('CF_ACCOUNT_ID and CF_ANALYTICS_TOKEN are not set');
  }
}
