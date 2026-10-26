// AWS Signature Version 4 as S3 uses it (Zeiko S3, ADR-044): the Authorization header and presigned
// URLs, S3's canonical URI (the key encoded once, "/" kept), and the per-chunk signatures of
// `aws-chunked` bodies. The caller looks up the secret for the access key; this file only does maths.
import { S3Error } from './s3-errors';
import { toHex } from './crypto';

export const ALGORITHM = 'AWS4-HMAC-SHA256';
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
export const STREAMING_SIGNED = 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD';
export const STREAMING_SIGNED_TRAILER = 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER';
export const STREAMING_UNSIGNED_TRAILER = 'STREAMING-UNSIGNED-PAYLOAD-TRAILER';
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** Requests may be this far from our clock (S3 allows 15 minutes). */
export const MAX_SKEW_MS = 15 * 60_000;
/** Presigned URLs live at most 7 days, like S3. */
export const MAX_PRESIGN_SECONDS = 7 * 24 * 3600;

const enc = new TextEncoder();

/** AWS URI encoding: RFC 3986 unreserved characters stay, every other UTF-8 byte is %XX. */
export function awsEncode(s: string, keepSlash: boolean): string {
  let out = encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  if (keepSlash) out = out.replace(/%2F/g, '/');
  return out;
}

export function decodeComponent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new S3Error('InvalidURI', 'Couldn’t parse the specified URI.');
  }
}

/** Query pairs decoded once. `+` stays `+` (AWS clients send spaces as %20). */
export function parseQuery(search: string): Array<[string, string]> {
  const raw = search.startsWith('?') ? search.slice(1) : search;
  const out: Array<[string, string]> = [];
  for (const part of raw.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const k = eq === -1 ? part : part.slice(0, eq);
    const v = eq === -1 ? '' : part.slice(eq + 1);
    out.push([decodeComponent(k), decodeComponent(v)]);
  }
  return out;
}

export function canonicalQuery(pairs: Array<[string, string]>): string {
  return pairs
    .filter(([k]) => k !== 'X-Amz-Signature')
    .map(([k, v]) => [awsEncode(k, false), awsEncode(v, false)] as const)
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/** S3 signs the path as the client sent it, decoded and re-encoded once ("/" kept). */
export function canonicalUri(pathname: string): string {
  return awsEncode(decodeComponent(pathname || '/'), true) || '/';
}

export interface ParsedAuth {
  kind: 'header' | 'query';
  accessKeyId: string;
  /** YYYYMMDD from the credential scope. */
  date: string;
  region: string;
  service: string;
  /** YYYYMMDDTHHMMSSZ */
  amzDate: string;
  signedHeaders: string[];
  signature: string;
  /** Hex SHA-256 of the body, UNSIGNED-PAYLOAD, or one of the STREAMING-* modes. */
  payloadHash: string;
  /** Presigned URLs only: lifetime in seconds. */
  expires?: number;
}

function parseCredential(value: string, kind: ParsedAuth['kind']) {
  const parts = value.split('/');
  const bad = () =>
    new S3Error(
      kind === 'header' ? 'AuthorizationHeaderMalformed' : 'AuthorizationQueryParametersError',
      'The credential is malformed; expected "<key>/<YYYYMMDD>/<region>/s3/aws4_request".',
    );
  if (parts.length !== 5) throw bad();
  const [accessKeyId, date, region, service, term] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (!accessKeyId || !/^\d{8}$/.test(date) || !region || term !== 'aws4_request') throw bad();
  if (service !== 's3') throw bad();
  return { accessKeyId, date, region, service };
}

function amzDateFromHttpDate(value: string | null): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return null;
  return new Date(t)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

export function parseAmzDate(s: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m.map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const t = Date.UTC(y, mo - 1, d, h, mi, se);
  return Number.isNaN(t) ? null : t;
}

/**
 * Reads how the request is signed. Null = no signature at all (an anonymous request); anything
 * else that isn't SigV4 is refused.
 */
export function parseAuth(headers: Headers, query: Array<[string, string]>): ParsedAuth | null {
  const authz = headers.get('authorization');
  if (authz) {
    if (!authz.startsWith(`${ALGORITHM} `)) {
      throw new S3Error(
        'InvalidRequest',
        'Only AWS Signature Version 4 (AWS4-HMAC-SHA256) is supported.',
      );
    }
    const fields = new Map<string, string>();
    for (const part of authz.slice(ALGORITHM.length + 1).split(',')) {
      const eq = part.indexOf('=');
      if (eq > 0) fields.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
    }
    const cred = fields.get('Credential');
    const signed = fields.get('SignedHeaders');
    const signature = fields.get('Signature');
    if (!cred || !signed || !signature || !/^[0-9a-f]{64}$/.test(signature)) {
      throw new S3Error('AuthorizationHeaderMalformed', 'The authorization header is malformed.');
    }
    const amzDate = headers.get('x-amz-date') ?? amzDateFromHttpDate(headers.get('date'));
    if (!amzDate)
      throw new S3Error(
        'AccessDenied',
        'AWS authentication requires a valid Date or x-amz-date header.',
      );
    const payloadHash = headers.get('x-amz-content-sha256');
    if (!payloadHash) {
      throw new S3Error(
        'InvalidRequest',
        'Missing required header for this request: x-amz-content-sha256.',
      );
    }
    return {
      kind: 'header',
      ...parseCredential(cred, 'header'),
      amzDate,
      signedHeaders: signed.split(';'),
      signature,
      payloadHash,
    };
  }
  const q = new Map(query);
  if (!q.has('X-Amz-Algorithm') && !q.has('X-Amz-Signature')) return null;
  const bad = (m: string) => new S3Error('AuthorizationQueryParametersError', m);
  if (q.get('X-Amz-Algorithm') !== ALGORITHM)
    throw bad('X-Amz-Algorithm must be AWS4-HMAC-SHA256.');
  const cred = q.get('X-Amz-Credential');
  const amzDate = q.get('X-Amz-Date');
  const expires = Number(q.get('X-Amz-Expires'));
  const signed = q.get('X-Amz-SignedHeaders');
  const signature = q.get('X-Amz-Signature');
  if (!cred || !amzDate || !signed || !signature || !/^[0-9a-f]{64}$/.test(signature))
    throw bad(
      'Query-string authentication requires X-Amz-Credential, X-Amz-Date, X-Amz-SignedHeaders and X-Amz-Signature.',
    );
  if (!Number.isInteger(expires) || expires < 1 || expires > MAX_PRESIGN_SECONDS)
    throw bad('X-Amz-Expires must be between 1 and 604800 seconds.');
  return {
    kind: 'query',
    ...parseCredential(cred, 'query'),
    amzDate,
    signedHeaders: signed.split(';'),
    signature,
    payloadHash: q.get('X-Amz-Content-Sha256') ?? UNSIGNED_PAYLOAD,
    expires,
  };
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}

const signingKeys = new Map<string, Promise<ArrayBuffer>>();

/** kSigning = HMAC chain over date, region, service (cached per secret and day). */
export function signingKey(secret: string, date: string, region: string): Promise<ArrayBuffer> {
  const id = `${date}\n${region}\n${secret}`;
  let key = signingKeys.get(id);
  if (!key) {
    key = (async () => {
      const kDate = await hmac(enc.encode(`AWS4${secret}`), date);
      const kRegion = await hmac(kDate, region);
      const kService = await hmac(kRegion, 's3');
      return hmac(kService, 'aws4_request');
    })();
    if (signingKeys.size > 1000) signingKeys.clear();
    signingKeys.set(id, key);
  }
  return key;
}

export async function sha256HexOf(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

export async function hmacHex(key: ArrayBuffer, data: string): Promise<string> {
  return toHex(new Uint8Array(await hmac(key, data)));
}

export function scopeOf(a: Pick<ParsedAuth, 'date' | 'region'>): string {
  return `${a.date}/${a.region}/s3/aws4_request`;
}

export function canonicalRequest(
  method: string,
  url: URL,
  query: Array<[string, string]>,
  headers: Headers,
  auth: ParsedAuth,
): string {
  const lines = auth.signedHeaders.map((name) => {
    const raw = name === 'host' ? (headers.get('host') ?? url.host) : (headers.get(name) ?? '');
    return `${name}:${raw.trim().replace(/\s+/g, ' ')}\n`;
  });
  return [
    method,
    canonicalUri(url.pathname),
    canonicalQuery(query),
    lines.join(''),
    auth.signedHeaders.join(';'),
    auth.payloadHash,
  ].join('\n');
}

export interface VerifiedSignature {
  signingKey: ArrayBuffer;
  scope: string;
  amzDate: string;
  /** The request's own signature: the seed of the chunk signature chain. */
  signature: string;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Checks the time window and the signature. Throws the S3 error a client expects. */
export async function verifySignature(
  method: string,
  url: URL,
  query: Array<[string, string]>,
  headers: Headers,
  auth: ParsedAuth,
  secret: string,
  now: number,
): Promise<VerifiedSignature> {
  const at = parseAmzDate(auth.amzDate);
  if (at === null)
    throw new S3Error('AccessDenied', 'X-Amz-Date is not a valid ISO 8601 basic date.');
  if (auth.amzDate.slice(0, 8) !== auth.date) {
    throw new S3Error('SignatureDoesNotMatch', 'The credential date does not match X-Amz-Date.');
  }
  if (auth.kind === 'header') {
    if (Math.abs(now - at) > MAX_SKEW_MS)
      throw new S3Error(
        'RequestTimeTooSkewed',
        'The difference between the request time and the server time is too large.',
      );
  } else {
    if (at - now > MAX_SKEW_MS) throw new S3Error('AccessDenied', 'Request is not valid yet.');
    if (now > at + (auth.expires ?? 0) * 1000)
      throw new S3Error('AccessDenied', 'Request has expired.');
  }
  if (!auth.signedHeaders.includes('host')) {
    throw new S3Error('AccessDenied', 'The host header must be signed.');
  }
  const creq = canonicalRequest(method, url, query, headers, auth);
  const scope = scopeOf(auth);
  const toSign = `${ALGORITHM}\n${auth.amzDate}\n${scope}\n${await sha256HexOf(creq)}`;
  const key = await signingKey(secret, auth.date, auth.region);
  const expected = await hmacHex(key, toSign);
  if (!constantTimeEqual(expected, auth.signature)) {
    throw new S3Error(
      'SignatureDoesNotMatch',
      'The request signature we calculated does not match the signature you provided. Check your key and signing method.',
    );
  }
  return { signingKey: key, scope, amzDate: auth.amzDate, signature: auth.signature };
}

/** Signature of one `aws-chunked` chunk, chained from the previous one. */
export function chunkSignature(
  v: Pick<VerifiedSignature, 'signingKey' | 'scope' | 'amzDate'>,
  previous: string,
  chunkSha256: string,
): Promise<string> {
  return hmacHex(
    v.signingKey,
    `AWS4-HMAC-SHA256-PAYLOAD\n${v.amzDate}\n${v.scope}\n${previous}\n${EMPTY_SHA256}\n${chunkSha256}`,
  );
}

/** 20261026T053000Z */
export function amzDateOf(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/**
 * A presigned URL (query-string SigV4, host signed, unsigned payload), the same thing the AWS SDK's
 * getSignedUrl makes: for the /s3 page's "copy link" and in-app downloads (ADR-055). `url` may
 * carry other query parameters (response-content-disposition…); they are signed too.
 */
export async function presignUrl(opts: {
  method: 'GET' | 'HEAD' | 'PUT';
  url: URL;
  accessKeyId: string;
  secret: string;
  region: string;
  now: number;
  expiresSeconds: number;
}): Promise<string> {
  const amzDate = amzDateOf(opts.now);
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${opts.region}/s3/aws4_request`;
  const params: Array<[string, string]> = [
    ...parseQuery(opts.url.search),
    ['X-Amz-Algorithm', ALGORITHM],
    ['X-Amz-Credential', `${opts.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(Math.max(1, Math.min(MAX_PRESIGN_SECONDS, opts.expiresSeconds)))],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  const creq = [
    opts.method,
    canonicalUri(opts.url.pathname),
    canonicalQuery(params),
    `host:${opts.url.host}\n`,
    'host',
    UNSIGNED_PAYLOAD,
  ].join('\n');
  const toSign = `${ALGORITHM}\n${amzDate}\n${scope}\n${await sha256HexOf(creq)}`;
  const signature = await hmacHex(await signingKey(opts.secret, date, opts.region), toSign);
  return `${opts.url.origin}${opts.url.pathname}?${canonicalQuery(params)}&X-Amz-Signature=${signature}`;
}
