// The Zeiko S3 API (ADR-044): Amazon S3's REST protocol on S3_ORIGIN's host, path-style
// (https://s3.zeiko.biz.id/{bucket}/{key}) or, if DNS allows, virtual-hosted ({bucket}.s3.…).
// Requests are signed with SigV4 using a Zeiko S3 access key (header or presigned URL); unsigned
// requests may only read objects from public buckets once they passed the security scan.
// The operations aws-cli, rclone, s3cmd and the AWS SDKs use day to day are here; the rest answer
// NotImplemented.
import type { Ctx } from '../context';
import type { Env } from '../env';
import { track } from '../lib/analytics';
import { awsChunkedDecoder, payloadHasher } from '../lib/aws-chunked';
import { base64UrlDecode, base64UrlEncode, toHex } from '../lib/crypto';
import { parseRange } from '../lib/http';
import { errorMessage, log } from '../lib/log';
import { isS3Error, S3Error, s3ErrorResponse } from '../lib/s3-errors';
import {
  decodeComponent,
  parseAuth,
  parseQuery,
  STREAMING_SIGNED,
  STREAMING_SIGNED_TRAILER,
  STREAMING_UNSIGNED_TRAILER,
  UNSIGNED_PAYLOAD,
  verifySignature,
  type ParsedAuth,
  type VerifiedSignature,
} from '../lib/s3-sigv4';
import {
  S3_NS,
  xmlDoc,
  xmlElements,
  xmlResponse,
  xmlText,
  esc,
  type XmlObject,
} from '../lib/s3-xml';
import { clientIp } from '../middleware/ratelimit';
import { meterS3Egress } from '../services/s3-billing';
import {
  bucketLogging,
  loggingXml,
  parseLoggingXml,
  recordS3Request,
  setBucketLogging,
} from '../services/s3-stats';
import { getFromAnyCopy } from '../services/s3-replicas';
import { s3UrlOwner } from '../services/s3-urls';
import {
  bucketCors,
  corsHeaders,
  corsXml,
  matchCors,
  parseCorsXml,
  requestedHeaders,
  setBucketCors,
} from '../services/s3-cors';
import {
  createBucket,
  getAccount,
  getBucket,
  isRestricted,
  listBuckets,
  lookupKey,
  ownBucket,
  S3_REGION,
  s3BlobKey,
  s3Configured,
  setBucketPublic,
  touchKey,
  type BucketRow,
  type KeyScope,
  type S3Account,
} from '../services/s3';
import {
  abortUpload,
  completeUpload,
  copyObject,
  copyPart,
  createUpload,
  deleteBucket,
  deleteObjects,
  getObjectRow,
  listObjects,
  listParts,
  listUploads,
  metaFromHeaders,
  parseMeta,
  putObject,
  uploadPart,
  validateKey,
  type ListCursor,
  type ObjectRow,
  type SourceConditions,
  type WriteCondition,
} from '../services/s3-objects';

/** Requests for Zeiko S3: its host, or a bucket subdomain of it. */
export function isS3Host(url: URL, env: Pick<Env, 'S3_ORIGIN'>): boolean {
  if (!env.S3_ORIGIN) return false;
  const host = new URL(env.S3_ORIGIN).host;
  return url.host === host || url.host.endsWith(`.${host}`);
}

/**
 * Whether a request is for Zeiko S3: the shared host (owner null), or an account's own address
 * (ADR-048), which answers for that account only. Null: the app's.
 */
export async function resolveS3Host(url: URL, env: Env): Promise<{ owner: string | null } | null> {
  if (!env.S3_ORIGIN) return null;
  if (isS3Host(url, env)) return { owner: null };
  const host = url.hostname.toLowerCase();
  if (host === new URL(env.APP_ORIGIN).hostname) return null;
  if (env.USERCONTENT_ORIGIN && host === new URL(env.USERCONTENT_ORIGIN).hostname) return null;
  const owner = await s3UrlOwner(env, host);
  return owner ? { owner } : null;
}

/** Query parameters that name a sub-resource we don't serve. */
const UNSUPPORTED_SUB = [
  'accelerate',
  'analytics',
  'attributes',
  'encryption',
  'intelligent-tiering',
  'inventory',
  'legal-hold',
  'lifecycle',
  'metrics',
  'notification',
  'object-lock',
  'ownershipControls',
  'policy',
  'policyStatus',
  'publicAccessBlock',
  'replication',
  'requestPayment',
  'restore',
  'retention',
  'select',
  'tagging',
  'torrent',
  'versions',
  'website',
];

const MAX_XML_BODY = 2 * 1024 * 1024;
const OWNER_DISPLAY = 'zeiko';

interface Auth {
  accessKeyId: string;
  userId: string;
  account: S3Account;
  parsed: ParsedAuth;
  verified: VerifiedSignature;
  /** What this key may touch (ADR-071). */
  scope: KeyScope;
}

interface Req {
  ctx: Ctx;
  raw: Request;
  url: URL;
  method: string;
  query: Map<string, string>;
  bucket: string | null;
  key: string | null;
  auth: Auth | null;
  requestId: string;
  /** Bytes in and out, for the per-account request log (Analytics Engine). */
  bytesIn: number;
  bytesOut: number;
  /** The account an own address belongs to (ADR-048); null on the shared host. */
  hostOwner: string | null;
  /** Whose period an object read's bytes count in (ADR-047): the bucket owner's. */
  egressTo: { userId: string; periodStart: number | null } | null;
  op: string;
  /** The bucket the request is counted for (ADR-060): set once it is known and may be addressed. */
  stats: BucketRow | null;
  /** The object's size, for the access log. */
  objectSize: number | null;
  errorCode: string | null;
}

function locate(
  url: URL,
  env: Env,
  ownHost: boolean,
): { bucket: string | null; key: string | null } {
  const s3Host = new URL(env.S3_ORIGIN!).host;
  const path = url.pathname;
  // Own addresses are path-style only.
  if (!ownHost && url.host !== s3Host) {
    const bucket = url.host.slice(0, -(s3Host.length + 1));
    const key = path.length > 1 ? decodeComponent(path.slice(1)) : null;
    return { bucket, key };
  }
  const rest = path.slice(1);
  if (!rest) return { bucket: null, key: null };
  const slash = rest.indexOf('/');
  if (slash === -1) return { bucket: decodeComponent(rest), key: null };
  const key = decodeComponent(rest.slice(slash + 1));
  return { bucket: decodeComponent(rest.slice(0, slash)), key: key || null };
}

async function authenticate(
  ctx: Ctx,
  req: Request,
  url: URL,
  pairs: Array<[string, string]>,
): Promise<Auth | null> {
  const parsed = parseAuth(req.headers, pairs);
  if (!parsed) return null;
  const key = await lookupKey(ctx, parsed.accessKeyId);
  if (!key || key.revoked || key.accountStatus === 'deleting')
    throw new S3Error(
      'InvalidAccessKeyId',
      'The AWS Access Key Id you provided does not exist in our records.',
    );
  if (key.scope.expiresAt !== null && Date.now() >= key.scope.expiresAt)
    throw new S3Error('InvalidAccessKeyId', 'The AWS Access Key Id you provided has expired.');
  const verified = await verifySignature(
    req.method,
    url,
    pairs,
    req.headers,
    parsed,
    key.secret,
    Date.now(),
  );
  const account = await getAccount(ctx, key.userId);
  if (!account || account.status === 'deleting')
    throw new S3Error(
      'InvalidAccessKeyId',
      'The AWS Access Key Id you provided does not exist in our records.',
    );
  if (account.status !== 'active' || key.userStatus !== 'active')
    throw new S3Error('AccountProblem', 'This Zeiko S3 account is suspended.');
  // Unpaid bills (ADR-047): read-only still reads, lists and deletes; locked does nothing.
  if (account.billingState === 'locked')
    throw new S3Error('AccountProblem', 'This Zeiko S3 account is locked until its bill is paid.');
  if (
    account.billingState === 'readonly' &&
    (req.method === 'PUT' || (req.method === 'POST' && !pairs.some(([k]) => k === 'delete')))
  )
    throw new S3Error('AccountProblem', 'Uploads are paused until the Zeiko S3 bill is paid.');
  await touchKey(ctx, parsed.accessKeyId, key);
  return {
    accessKeyId: parsed.accessKeyId,
    userId: key.userId,
    account,
    parsed,
    verified,
    scope: key.scope,
  };
}

function needAuth(r: Req): Auth {
  if (!r.auth) throw new S3Error('AccessDenied', 'Access Denied');
  return r.auth;
}

/**
 * What an operation needs from the key (ADR-071): `any` = only that the bucket is in its scope,
 * `manage` = a key with no limit at all (creating, deleting and configuring buckets).
 */
type Need = 'any' | 'read' | 'write' | 'manage';

function scopeAllows(scope: KeyScope, need: Need, bucket: string | null, key?: string): boolean {
  if (need === 'manage') return !isRestricted(scope);
  if (bucket !== null && scope.buckets && !scope.buckets.includes(bucket)) return false;
  if (need === 'read' && scope.access === 'w') return false;
  if (need === 'write' && scope.access === 'r') return false;
  if (key !== undefined && scope.prefix !== null && !key.startsWith(scope.prefix)) return false;
  return true;
}

/** Refuses a signed request its key's scope doesn't cover; `key` = an object key or a list prefix. */
function permit(r: Req, need: Need, bucket: string | null, key?: string): void {
  if (r.auth && !scopeAllows(r.auth.scope, need, bucket, key))
    throw new S3Error('AccessDenied', 'Access Denied');
}

const iso = (ms: number) => new Date(ms).toISOString();
const quoted = (etag: string) => `"${etag}"`;
const unquote = (s: string) => s.trim().replace(/^W\//, '').replace(/^"|"$/g, '');

/** encoding-type=url: what Amazon does (spaces as "+"), so botocore's unquote_plus reads it back. */
const urlEncodeS3 = (s: string) => encodeURIComponent(s).replace(/%20/g, '+');

interface Body {
  stream: ReadableStream<Uint8Array> | null;
  size: number;
  verify?: () => Promise<void>;
  failure: () => S3Error | null;
}

/**
 * The request body as the object's bytes: aws-chunked decoded, its SHA-256 checked if signed.
 * `needLength` = false lets a body without Content-Length through (size 0 = unknown).
 */
function objectBody(r: Req, needLength = true): Body {
  const auth = needAuth(r);
  const ph = auth.parsed.payloadHash;
  const h = r.raw.headers;
  if (
    ph === STREAMING_SIGNED ||
    ph === STREAMING_SIGNED_TRAILER ||
    ph === STREAMING_UNSIGNED_TRAILER
  ) {
    const decoded = h.get('x-amz-decoded-content-length');
    if (decoded === null || !/^\d+$/.test(decoded))
      throw new S3Error(
        'MissingContentLength',
        'You must provide x-amz-decoded-content-length with aws-chunked bodies.',
      );
    const decoder = awsChunkedDecoder(
      ph === STREAMING_UNSIGNED_TRAILER ? {} : { signed: auth.verified },
    );
    r.bytesIn = Number(decoded);
    return {
      stream: r.raw.body ? r.raw.body.pipeThrough(decoder.stream) : null,
      size: Number(decoded),
      failure: () => decoder.failure,
    };
  }
  const header = h.get('content-length');
  const length = header !== null && /^\d+$/.test(header) ? header : needLength ? null : '0';
  if (length === null)
    throw new S3Error('MissingContentLength', 'You must provide the Content-Length HTTP header.');
  r.bytesIn = Number(length);
  if (ph === UNSIGNED_PAYLOAD)
    return { stream: r.raw.body, size: Number(length), failure: () => null };
  if (!/^[0-9a-f]{64}$/.test(ph))
    throw new S3Error(
      'InvalidArgument',
      'x-amz-content-sha256 must be UNSIGNED-PAYLOAD, STREAMING-* or a SHA-256 hex digest.',
    );
  const hasher = payloadHasher();
  return {
    stream: r.raw.body ? r.raw.body.pipeThrough(hasher.stream) : null,
    size: Number(length),
    verify: async () => {
      if ((await hasher.digest()) !== ph)
        throw new S3Error(
          'XAmzContentSHA256Mismatch',
          'The provided x-amz-content-sha256 header does not match what was computed.',
        );
    },
    failure: () => null,
  };
}

/** Small request bodies (XML): read whole, bounded, with the signed hash checked. */
async function readSmallBody(r: Req): Promise<string> {
  if (!r.raw.body) return '';
  // Bodies without a Content-Length (chunked transfer) are fine here: they are read with a cap.
  const body = objectBody(r, false);
  if (body.size > MAX_XML_BODY)
    throw new S3Error('MaxMessageLengthExceeded', 'Your request was too big.');
  if (!body.stream) return '';
  const reader = body.stream.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > MAX_XML_BODY)
        throw new S3Error('MaxMessageLengthExceeded', 'Your request was too big.');
      chunks.push(value);
    }
  } catch (e) {
    throw body.failure() ?? e;
  }
  await body.verify?.();
  const all = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  return new TextDecoder().decode(all);
}

function contentMd5Hex(h: Headers): string | null {
  const v = h.get('content-md5');
  if (!v) return null;
  try {
    const bytes = Uint8Array.from(atob(v.trim()), (c) => c.charCodeAt(0));
    if (bytes.length !== 16) throw new Error('length');
    return toHex(bytes);
  } catch {
    throw new S3Error('InvalidDigest', 'The Content-MD5 you specified is not valid.');
  }
}

/**
 * If-Match / If-None-Match on PutObject, CopyObject and CompleteMultipartUpload (ADR-068). Amazon
 * takes "*" for If-None-Match and one ETag for If-Match there; anything else is refused, not ignored.
 */
function writeCondition(h: Headers): WriteCondition | null {
  for (const name of ['if-modified-since', 'if-unmodified-since'])
    if (h.has(name))
      throw new S3Error('NotImplemented', `The ${name} condition is not supported on writes.`);
  const match = h.get('if-match');
  const none = h.get('if-none-match');
  if (match !== null && none !== null)
    throw new S3Error(
      'NotImplemented',
      'Use either If-Match or If-None-Match on a write, not both.',
    );
  if (none !== null) {
    if (none.trim() !== '*')
      throw new S3Error('NotImplemented', 'If-None-Match on a write only takes "*".');
    return { ifNoneMatch: true };
  }
  if (match === null) return null;
  const tags = match.split(',');
  const tag = unquote(tags[0]!);
  if (tags.length !== 1 || !tag || tag === '*')
    throw new S3Error('NotImplemented', 'If-Match on a write takes exactly one ETag.');
  return { ifMatch: tag };
}

/** Conditional headers a write that takes none would otherwise ignore (ADR-068). */
const WRITE_CONDITIONS = [
  'if-match',
  'if-none-match',
  'if-modified-since',
  'if-unmodified-since',
  'x-amz-if-match-last-modified-time',
  'x-amz-if-match-size',
  'x-amz-if-match-initiated-time',
];

function noConditions(r: Req): void {
  const name = WRITE_CONDITIONS.find((n) => r.raw.headers.has(n));
  if (name)
    throw new S3Error('NotImplemented', `${r.op} with the ${name} condition is not supported.`);
}

function sourceConditions(h: Headers): SourceConditions {
  return {
    ifMatch: h.get('x-amz-copy-source-if-match'),
    ifNoneMatch: h.get('x-amz-copy-source-if-none-match'),
    ifModifiedSince: h.get('x-amz-copy-source-if-modified-since'),
    ifUnmodifiedSince: h.get('x-amz-copy-source-if-unmodified-since'),
  };
}

function aclPublic(value: string | null): boolean | null {
  if (value === null) return null;
  if (value === 'private') return false;
  if (value === 'public-read') return true;
  throw new S3Error(
    'InvalidArgument',
    'Only the private and public-read canned ACLs are supported.',
  );
}

function parseCopySource(v: string): { bucket: string; key: string } {
  let s = v.trim();
  const q = s.indexOf('?');
  if (q !== -1) {
    if (!/^\?versionId=null$/.test(s.slice(q)))
      throw new S3Error('InvalidArgument', 'Zeiko S3 has no object versions.');
    s = s.slice(0, q);
  }
  s = decodeComponent(s);
  if (s.startsWith('/')) s = s.slice(1);
  const slash = s.indexOf('/');
  if (slash <= 0 || slash === s.length - 1)
    throw new S3Error(
      'InvalidArgument',
      'Copy Source must mention the source bucket and key: sourcebucket/sourcekey.',
    );
  return { bucket: s.slice(0, slash), key: s.slice(slash + 1) };
}

function owner(userId: string): XmlObject {
  return { ID: userId, DisplayName: OWNER_DISPLAY };
}

// ───────────────────────────── service & bucket operations ─────────────────────────────

async function listAllBuckets(r: Req): Promise<Response> {
  const auth = needAuth(r);
  r.op = 'ListBuckets';
  const scope = auth.scope.buckets;
  const buckets = (await listBuckets(r.ctx, auth.userId)).filter(
    (b) => !scope || scope.includes(b.name),
  );
  return xmlResponse(
    xmlDoc('ListAllMyBucketsResult', {
      Owner: owner(auth.userId),
      Buckets: { Bucket: buckets.map((b) => ({ Name: b.name, CreationDate: iso(b.created_at) })) },
    }),
  );
}

function decodeToken(token: string): ListCursor {
  try {
    const v = JSON.parse(new TextDecoder().decode(base64UrlDecode(token))) as {
      a?: unknown;
      s?: unknown;
    };
    if (typeof v.a === 'string') return { after: v.a };
    if (typeof v.s === 'string') return { skip: v.s };
  } catch {
    // fall through
  }
  throw new S3Error('InvalidArgument', 'The continuation token provided is incorrect.');
}

function encodeToken(c: ListCursor): string {
  return base64UrlEncode(
    new TextEncoder().encode(JSON.stringify('after' in c ? { a: c.after } : { s: c.skip })),
  );
}

function maxParam(q: Map<string, string>, name: string, def: number, cap: number): number {
  const raw = q.get(name);
  if (raw === undefined) return def;
  if (!/^\d+$/.test(raw))
    throw new S3Error('InvalidArgument', `${name} must be a non-negative integer.`);
  return Math.min(Number(raw), cap);
}

async function listBucket(r: Req, bucket: BucketRow): Promise<Response> {
  const auth = needAuth(r);
  const q = r.query;
  const v2 = q.get('list-type') === '2';
  r.op = v2 ? 'ListObjectsV2' : 'ListObjects';
  const encoding = q.get('encoding-type');
  if (encoding !== undefined && encoding !== 'url')
    throw new S3Error('InvalidArgument', 'Invalid Encoding Method specified in Request');
  const enc = (s: string) => (encoding === 'url' ? urlEncodeS3(s) : s);
  const prefix = q.get('prefix') ?? '';
  permit(r, 'read', bucket.name, prefix);
  const delimiter = q.get('delimiter') ?? '';
  const maxKeys = maxParam(q, 'max-keys', 1000, 1000);
  const token = v2 ? q.get('continuation-token') : undefined;
  const marker = v2 ? q.get('start-after') : q.get('marker');
  const result = await listObjects(r.ctx, auth.account, bucket.name, {
    prefix,
    delimiter,
    maxKeys,
    ...(marker ? { marker } : {}),
    ...(token ? { cursor: decodeToken(token) } : {}),
  });
  const fetchOwner = q.get('fetch-owner') === 'true';
  const contents = result.contents.map((o) => ({
    Key: enc(o.key),
    LastModified: iso(o.modified_at),
    ETag: quoted(o.etag),
    Size: o.size,
    StorageClass: 'STANDARD',
    ...(v2 && !fetchOwner ? {} : { Owner: owner(auth.userId) }),
  }));
  const prefixes = result.prefixes.map((p) => ({ Prefix: enc(p) }));
  const nextKey = result.next
    ? 'after' in result.next
      ? result.next.after
      : result.next.skip
    : null;
  const body: XmlObject = v2
    ? {
        Name: bucket.name,
        Prefix: enc(prefix),
        ...(delimiter ? { Delimiter: enc(delimiter) } : {}),
        MaxKeys: maxKeys,
        KeyCount: contents.length + prefixes.length,
        IsTruncated: result.truncated,
        ...(token ? { ContinuationToken: token } : {}),
        ...(result.truncated && result.next
          ? { NextContinuationToken: encodeToken(result.next) }
          : {}),
        ...(marker ? { StartAfter: enc(marker) } : {}),
        ...(encoding ? { EncodingType: encoding } : {}),
        Contents: contents,
        CommonPrefixes: prefixes,
      }
    : {
        Name: bucket.name,
        Prefix: enc(prefix),
        Marker: enc(marker ?? ''),
        ...(result.truncated && nextKey !== null ? { NextMarker: enc(nextKey) } : {}),
        MaxKeys: maxKeys,
        ...(delimiter ? { Delimiter: enc(delimiter) } : {}),
        IsTruncated: result.truncated,
        ...(encoding ? { EncodingType: encoding } : {}),
        Contents: contents,
        CommonPrefixes: prefixes,
      };
  return xmlResponse(xmlDoc('ListBucketResult', body));
}

function bucketAcl(userId: string, isPublic: boolean): Response {
  const grant = (grantee: string, permission: string) =>
    `<Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ${grantee}</Grantee><Permission>${permission}</Permission></Grant>`;
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n<AccessControlPolicy xmlns="${S3_NS}">` +
    `<Owner><ID>${esc(userId)}</ID><DisplayName>${OWNER_DISPLAY}</DisplayName></Owner><AccessControlList>` +
    grant(
      `xsi:type="CanonicalUser"><ID>${esc(userId)}</ID><DisplayName>${OWNER_DISPLAY}</DisplayName>`,
      'FULL_CONTROL',
    ) +
    (isPublic
      ? grant(`xsi:type="Group"><URI>http://acs.amazonaws.com/groups/global/AllUsers</URI>`, 'READ')
      : '') +
    `</AccessControlList></AccessControlPolicy>`;
  return xmlResponse(xml);
}

async function bucketOp(r: Req): Promise<Response> {
  const name = r.bucket!;
  const q = r.query;
  const sub = UNSUPPORTED_SUB.find((s) => q.has(s));
  const auth = needAuth(r);
  if (r.method === 'PUT' && !q.has('acl') && !q.has('cors') && !q.has('logging')) {
    if (sub)
      throw new S3Error('NotImplemented', `The ${sub} configuration is not supported by Zeiko S3.`);
    r.op = 'CreateBucket';
    permit(r, 'manage', name);
    await readSmallBody(r); // CreateBucketConfiguration (a location) is accepted and ignored
    await createBucket(
      r.ctx,
      auth.userId,
      name,
      aclPublic(r.raw.headers.get('x-amz-acl')) ?? false,
    );
    return new Response(null, { status: 200, headers: { Location: `/${name}` } });
  }
  permit(r, 'any', name);
  const bucket = await ownBucket(r.ctx, auth.userId, name);
  r.stats = bucket;
  if (sub)
    throw new S3Error('NotImplemented', `The ${sub} sub-resource is not supported by Zeiko S3.`);
  if (q.has('cors')) return corsOp(r, bucket);
  if (q.has('logging')) return loggingOp(r, bucket);
  switch (r.method) {
    case 'HEAD':
      r.op = 'HeadBucket';
      return new Response(null, { status: 200, headers: { 'x-amz-bucket-region': S3_REGION } });
    case 'DELETE':
      r.op = 'DeleteBucket';
      permit(r, 'manage', name);
      await deleteBucket(r.ctx, auth.account, name);
      return new Response(null, { status: 204 });
    case 'PUT': {
      r.op = 'PutBucketAcl';
      permit(r, 'manage', name);
      const header = aclPublic(r.raw.headers.get('x-amz-acl'));
      const body = header === null ? await readSmallBody(r) : '';
      await setBucketPublic(r.ctx, auth.userId, name, header ?? body.includes('/global/AllUsers'));
      return new Response(null, { status: 200 });
    }
    case 'POST': {
      if (!q.has('delete'))
        throw new S3Error(
          'MethodNotAllowed',
          'The specified method is not allowed against this resource.',
        );
      r.op = 'DeleteObjects';
      permit(r, 'write', name);
      return deleteMany(r, bucket);
    }
    case 'GET':
      if (q.has('location')) {
        r.op = 'GetBucketLocation';
        return xmlResponse(
          `<?xml version="1.0" encoding="UTF-8"?>\n<LocationConstraint xmlns="${S3_NS}">${S3_REGION}</LocationConstraint>`,
        );
      }
      if (q.has('versioning')) {
        r.op = 'GetBucketVersioning';
        return xmlResponse(xmlDoc('VersioningConfiguration', {}));
      }
      if (q.has('acl')) {
        r.op = 'GetBucketAcl';
        permit(r, 'read', name);
        return bucketAcl(auth.userId, Boolean(bucket.public));
      }
      if (q.has('uploads')) {
        r.op = 'ListMultipartUploads';
        return listMultipart(r, bucket);
      }
      return listBucket(r, bucket);
    default:
      throw new S3Error(
        'MethodNotAllowed',
        'The specified method is not allowed against this resource.',
      );
  }
}

/** Get/Put/DeleteBucketCors (ADR-055). */
async function corsOp(r: Req, bucket: BucketRow): Promise<Response> {
  const auth = needAuth(r);
  switch (r.method) {
    case 'GET': {
      r.op = 'GetBucketCors';
      permit(r, 'read', bucket.name);
      const rules = bucketCors(bucket);
      if (!rules)
        throw new S3Error('NoSuchCORSConfiguration', 'The CORS configuration does not exist', {
          BucketName: bucket.name,
        });
      return xmlResponse(corsXml(rules));
    }
    case 'PUT':
      r.op = 'PutBucketCors';
      permit(r, 'manage', bucket.name);
      await setBucketCors(r.ctx, auth.userId, bucket.name, parseCorsXml(await readSmallBody(r)));
      return new Response(null, { status: 200 });
    case 'DELETE':
      r.op = 'DeleteBucketCors';
      permit(r, 'manage', bucket.name);
      await setBucketCors(r.ctx, auth.userId, bucket.name, null);
      return new Response(null, { status: 204 });
    default:
      throw new S3Error(
        'MethodNotAllowed',
        'The specified method is not allowed against this resource.',
      );
  }
}

/** Get/PutBucketLogging (ADR-060): logs go to another bucket of the same owner. */
async function loggingOp(r: Req, bucket: BucketRow): Promise<Response> {
  const auth = needAuth(r);
  switch (r.method) {
    case 'GET':
      r.op = 'GetBucketLogging';
      permit(r, 'read', bucket.name);
      return xmlResponse(loggingXml(bucketLogging(bucket)));
    case 'PUT':
      r.op = 'PutBucketLogging';
      permit(r, 'manage', bucket.name);
      await setBucketLogging(
        r.ctx,
        auth.userId,
        bucket.name,
        parseLoggingXml(await readSmallBody(r)),
      );
      return new Response(null, { status: 200 });
    default:
      throw new S3Error(
        'MethodNotAllowed',
        'The specified method is not allowed against this resource.',
      );
  }
}

/** A bucket as a browser on another site sees it: on an own address, only its owner's. */
async function corsBucket(r: Req): Promise<BucketRow | null> {
  if (!r.bucket) return null;
  const b = await getBucket(r.ctx, r.bucket);
  if (!b || (r.hostOwner !== null && b.user_id !== r.hostOwner)) return null;
  return b;
}

const CORS_DENIED =
  "This CORS request is not allowed. This is usually because the evalution of Origin, request method / Access-Control-Request-Method or Access-Control-Request-Headers are not whitelisted by the resource's CORS spec.";

/** The browser's preflight (OPTIONS): unsigned, answered from the bucket's rules alone. */
async function preflight(r: Req): Promise<Response> {
  r.op = 'PreflightRequest';
  const h = r.raw.headers;
  const origin = h.get('origin');
  const method = h.get('access-control-request-method');
  if (!origin || !method)
    throw new S3Error(
      'InvalidRequest',
      'Insufficient information. Origin and Access-Control-Request-Method are needed.',
    );
  const bucket = await corsBucket(r);
  const rules = bucket ? bucketCors(bucket) : null;
  if (!rules) throw new S3Error('CORSResponse', 'CORS is not enabled for this bucket.');
  const asked = requestedHeaders(h.get('access-control-request-headers'));
  const rule = matchCors(rules, origin, method, asked);
  if (!rule) throw new S3Error('CORSResponse', CORS_DENIED);
  return new Response(null, {
    status: 200,
    headers: corsHeaders(rule, origin, { method, headers: asked }),
  });
}

async function deleteMany(r: Req, bucket: BucketRow): Promise<Response> {
  const auth = needAuth(r);
  const xml = await readSmallBody(r);
  const objects = xmlElements(xml, 'Object');
  if (!xmlElements(xml, 'Delete').length || objects.length > 1000)
    throw new S3Error(
      'MalformedXML',
      'The XML you provided was not well-formed or did not validate against our published schema.',
    );
  const quiet = xmlText(xml, 'Quiet') === 'true';
  const ok: string[] = [];
  const errors: XmlObject[] = [];
  for (const o of objects) {
    const key = xmlText(o, 'Key') ?? '';
    try {
      validateKey(key);
      if (!scopeAllows(auth.scope, 'write', bucket.name, key))
        throw new S3Error('AccessDenied', 'Access Denied');
      // A per-object condition must not be skipped silently (ADR-068).
      const cond = ['ETag', 'LastModifiedTime', 'Size'].find((t) => xmlText(o, t) !== null);
      if (cond)
        throw new S3Error(
          'NotImplemented',
          `Deleting with the ${cond} condition is not supported.`,
        );
      ok.push(key);
    } catch (e) {
      const err = isS3Error(e) ? e : new S3Error('InternalError');
      errors.push({ Key: key, Code: err.code, Message: err.message });
    }
  }
  await deleteObjects(r.ctx, auth.account, bucket.name, ok);
  return xmlResponse(
    xmlDoc('DeleteResult', {
      Deleted: quiet ? [] : ok.map((k) => ({ Key: k })),
      Error: errors,
    }),
  );
}

async function listMultipart(r: Req, bucket: BucketRow): Promise<Response> {
  const auth = needAuth(r);
  const q = r.query;
  const prefix = q.get('prefix') ?? '';
  permit(r, 'write', bucket.name, prefix);
  const keyMarker = q.get('key-marker') ?? '';
  const max = maxParam(q, 'max-uploads', 1000, 1000);
  const { uploads, truncated } = await listUploads(
    r.ctx,
    auth.account,
    bucket.name,
    prefix,
    keyMarker,
    max,
  );
  const last = uploads[uploads.length - 1];
  return xmlResponse(
    xmlDoc('ListMultipartUploadsResult', {
      Bucket: bucket.name,
      KeyMarker: keyMarker,
      UploadIdMarker: q.get('upload-id-marker') ?? '',
      ...(truncated && last ? { NextKeyMarker: last.key, NextUploadIdMarker: last.id } : {}),
      Prefix: prefix,
      MaxUploads: max,
      IsTruncated: truncated,
      Upload: uploads.map((u) => ({
        Key: u.key,
        UploadId: u.id,
        Initiator: owner(auth.userId),
        Owner: owner(auth.userId),
        StorageClass: 'STANDARD',
        Initiated: iso(u.created_at),
      })),
    }),
  );
}

// ───────────────────────────── object operations ─────────────────────────────

function objectHeaders(row: ObjectRow, r: Req): Headers {
  const meta = parseMeta(row);
  const h = new Headers({
    'Content-Type': row.content_type ?? 'application/octet-stream',
    ETag: quoted(row.etag),
    'Last-Modified': new Date(row.modified_at).toUTCString(),
    'Accept-Ranges': 'bytes',
    // Objects are served on a zeiko.biz.id host: never let one run as a page there (ADR-044).
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
  });
  for (const [k, v] of Object.entries(meta.h ?? {})) h.set(k, v);
  for (const [k, v] of Object.entries(meta.m ?? {})) h.set(`x-amz-meta-${k}`, v);
  // response-* overrides are for signed requests only, like Amazon.
  if (r.auth) {
    for (const [param, header] of [
      ['response-content-type', 'Content-Type'],
      ['response-content-language', 'Content-Language'],
      ['response-expires', 'Expires'],
      ['response-cache-control', 'Cache-Control'],
      ['response-content-disposition', 'Content-Disposition'],
      ['response-content-encoding', 'Content-Encoding'],
    ] as const) {
      const v = r.query.get(param);
      if (v !== undefined) h.set(header, v);
    }
  }
  return h;
}

function tagMatches(header: string, etag: string): boolean {
  return header.split(',').some((t) => t.trim() === '*' || unquote(t) === etag);
}

async function readObject(
  r: Req,
  account: Pick<S3Account, 'userId' | 'indexBinding' | 'periodStart'>,
  bucket: BucketRow,
): Promise<Response> {
  const head = r.method === 'HEAD';
  r.op = head ? 'HeadObject' : 'GetObject';
  if (r.query.has('partNumber'))
    throw new S3Error('NotImplemented', 'GET by part number is not supported by Zeiko S3.');
  const row = await getObjectRow(r.ctx, account, bucket.name, r.key!);
  if (!row) throw new S3Error('NoSuchKey', 'The specified key does not exist.', { Key: r.key! });
  r.objectSize = row.size;
  // Strangers only get objects the security scan has passed (SPEC §14.2: pending = owner only).
  if (!r.auth && row.scan_status !== 'clean' && row.scan_status !== 'skipped')
    throw new S3Error('AccessDenied', 'This object is still being checked.');
  const h = r.raw.headers;
  const modified = Math.floor(row.modified_at / 1000) * 1000;
  const ifMatch = h.get('if-match');
  const ifNoneMatch = h.get('if-none-match');
  const since = (name: string) => {
    const v = h.get(name);
    const t = v ? Date.parse(v) : NaN;
    return Number.isNaN(t) ? null : t;
  };
  const fail412 = () =>
    new S3Error(
      'PreconditionFailed',
      'At least one of the pre-conditions you specified did not hold.',
    );
  if (ifMatch !== null) {
    if (!tagMatches(ifMatch, row.etag)) throw fail412();
  } else {
    const t = since('if-unmodified-since');
    if (t !== null && modified > t) throw fail412();
  }
  const headers = objectHeaders(row, r);
  const notModified =
    ifNoneMatch !== null
      ? tagMatches(ifNoneMatch, row.etag)
      : (() => {
          const t = since('if-modified-since');
          return t !== null && modified <= t;
        })();
  if (notModified) {
    headers.delete('Content-Type');
    return new Response(null, { status: 304, headers });
  }
  let range = parseRange(h.get('range'), row.size);
  if (range.kind === 'multi') range = { kind: 'none' };
  if (range.kind === 'unsatisfiable')
    throw new S3Error('InvalidRange', 'The requested range is not satisfiable.', {
      ActualObjectSize: String(row.size),
    });
  const r2Key = s3BlobKey(account.userId, row.blob_id);
  r.egressTo = { userId: account.userId, periodStart: account.periodStart };
  if (range.kind === 'single') {
    const length = range.end - range.start + 1;
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${row.size}`);
    headers.set('Content-Length', String(length));
    if (head) return new Response(null, { status: 206, headers });
    const obj = await getFromAnyCopy(r.ctx.env, r2Key, { range: { offset: range.start, length } });
    if (!obj || !('body' in obj))
      throw new S3Error('NoSuchKey', 'The specified key does not exist.');
    r.bytesOut = length;
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set('Content-Length', String(row.size));
  if (head || row.size === 0) return new Response(head ? null : '', { status: 200, headers });
  const obj = await getFromAnyCopy(r.ctx.env, r2Key);
  if (!obj) throw new S3Error('NoSuchKey', 'The specified key does not exist.');
  r.bytesOut = row.size;
  return new Response(obj.body, { status: 200, headers });
}

async function writeObject(r: Req, bucket: BucketRow): Promise<Response> {
  const auth = needAuth(r);
  const h = r.raw.headers;
  const q = r.query;
  const key = r.key!;
  const copySource = h.get('x-amz-copy-source');
  const uploadId = q.get('uploadId');
  if (uploadId !== undefined) {
    const partNumber = Number(q.get('partNumber'));
    if (copySource) {
      r.op = 'UploadPartCopy';
      noConditions(r);
      const from = parseCopySource(copySource);
      permit(r, 'read', from.bucket, from.key);
      const res = await copyPart(
        r.ctx,
        auth.account,
        bucket.name,
        key,
        uploadId,
        partNumber,
        from,
        h.get('x-amz-copy-source-range'),
        sourceConditions(h),
      );
      return xmlResponse(
        xmlDoc('CopyPartResult', { LastModified: iso(res.modifiedAt), ETag: quoted(res.etag) }),
      );
    }
    r.op = 'UploadPart';
    noConditions(r);
    const body = objectBody(r);
    try {
      const etag = await uploadPart(
        r.ctx,
        auth.account,
        bucket.name,
        key,
        uploadId,
        partNumber,
        body.stream,
        body.size,
        body.verify,
      );
      return new Response(null, { status: 200, headers: { ETag: quoted(etag) } });
    } catch (e) {
      throw body.failure() ?? e;
    }
  }
  if (copySource) {
    r.op = 'CopyObject';
    const from = parseCopySource(copySource);
    permit(r, 'read', from.bucket, from.key);
    const directive = (h.get('x-amz-metadata-directive') ?? 'COPY').toUpperCase();
    if (directive !== 'COPY' && directive !== 'REPLACE')
      throw new S3Error('InvalidArgument', 'Unknown metadata directive.');
    const row = await copyObject(r.ctx, auth.account, {
      from,
      to: { bucket: bucket.name, key },
      replace: directive === 'REPLACE',
      contentType: h.get('content-type'),
      meta: metaFromHeaders(h),
      source: sourceConditions(h),
      condition: writeCondition(h),
    });
    return xmlResponse(
      xmlDoc('CopyObjectResult', { LastModified: iso(row.modified_at), ETag: quoted(row.etag) }),
    );
  }
  r.op = 'PutObject';
  const condition = writeCondition(h);
  const md5Hex = contentMd5Hex(h);
  const meta = metaFromHeaders(h);
  const body = objectBody(r);
  try {
    const row = await putObject(r.ctx, auth.account, {
      bucket: bucket.name,
      key,
      body: body.stream,
      size: body.size,
      contentType: h.get('content-type'),
      meta,
      md5Hex,
      condition,
      ...(body.verify ? { verify: body.verify } : {}),
    });
    return new Response(null, { status: 200, headers: { ETag: quoted(row.etag) } });
  } catch (e) {
    throw body.failure() ?? e;
  }
}

async function objectOp(r: Req): Promise<Response> {
  const q = r.query;
  const sub = UNSUPPORTED_SUB.find((s) => q.has(s));
  if (sub)
    throw new S3Error('NotImplemented', `The ${sub} sub-resource is not supported by Zeiko S3.`);
  const bucket = await getBucket(r.ctx, r.bucket!);
  if (!bucket)
    throw new S3Error('NoSuchBucket', 'The specified bucket does not exist.', {
      BucketName: r.bucket!,
    });

  if (!r.auth) {
    r.stats = bucket;
    // Anonymous: read-only, public buckets, nothing else (ToS §4).
    if ((r.method !== 'GET' && r.method !== 'HEAD') || q.has('acl') || q.has('uploadId'))
      throw new S3Error('AccessDenied', 'Access Denied');
    if (!bucket.public || bucket.blocked_at !== null)
      throw new S3Error('AccessDenied', 'Access Denied');
    const account = await getAccount(r.ctx, bucket.user_id);
    if (!account || account.status !== 'active' || account.billingState !== 'ok')
      throw new S3Error('AccessDenied', 'Access Denied');
    const user = await r.ctx.env.DB.prepare(`SELECT status FROM users WHERE id = ?1`)
      .bind(bucket.user_id)
      .first<{ status: string }>();
    if (user?.status !== 'active') throw new S3Error('AccessDenied', 'Access Denied');
    const { success } = await r.ctx.env.RL_DOWNLOAD.limit({ key: `s3:${clientIp(r.raw)}` });
    if (!success) throw new S3Error('SlowDown', 'Please reduce your request rate.');
    return readObject(r, account, bucket);
  }

  const auth = r.auth;
  if (bucket.user_id !== auth.userId) throw new S3Error('AccessDenied', 'Access Denied');
  r.stats = bucket;
  const key = r.key!;
  // Reading is GET/HEAD of the object (or its ACL); everything else, ListParts included, is writing.
  const reading = (r.method === 'GET' || r.method === 'HEAD') && !q.has('uploadId');
  permit(r, reading ? 'read' : 'write', bucket.name, key);
  switch (r.method) {
    case 'GET':
      if (q.has('acl')) {
        r.op = 'GetObjectAcl';
        return bucketAcl(auth.userId, false);
      }
      if (q.has('uploadId')) {
        r.op = 'ListParts';
        const marker = maxParam(q, 'part-number-marker', 0, 10_000);
        const max = maxParam(q, 'max-parts', 1000, 1000);
        const { upload, parts, truncated } = await listParts(
          r.ctx,
          auth.account,
          bucket.name,
          key,
          q.get('uploadId')!,
          marker,
          max,
        );
        const last = parts[parts.length - 1];
        return xmlResponse(
          xmlDoc('ListPartsResult', {
            Bucket: bucket.name,
            Key: key,
            UploadId: upload.id,
            Initiator: owner(auth.userId),
            Owner: owner(auth.userId),
            StorageClass: 'STANDARD',
            PartNumberMarker: marker,
            ...(truncated && last ? { NextPartNumberMarker: last.part_number } : {}),
            MaxParts: max,
            IsTruncated: truncated,
            Part: parts.map((p) => ({
              PartNumber: p.part_number,
              LastModified: iso(p.created_at),
              ETag: quoted(p.etag),
              Size: p.size,
            })),
          }),
        );
      }
      return readObject(r, auth.account, bucket);
    case 'HEAD':
      return readObject(r, auth.account, bucket);
    case 'PUT':
      if (q.has('acl'))
        throw new S3Error(
          'NotImplemented',
          'Object ACLs are not supported; make the bucket public instead.',
        );
      return writeObject(r, bucket);
    case 'DELETE':
      if (q.has('uploadId')) {
        r.op = 'AbortMultipartUpload';
        noConditions(r);
        await abortUpload(r.ctx, auth.account, bucket.name, key, q.get('uploadId')!);
        return new Response(null, { status: 204 });
      }
      r.op = 'DeleteObject';
      noConditions(r);
      validateKey(key);
      await deleteObjects(r.ctx, auth.account, bucket.name, [key]);
      return new Response(null, { status: 204 });
    case 'POST':
      if (q.has('uploads')) {
        r.op = 'CreateMultipartUpload';
        noConditions(r);
        const up = await createUpload(
          r.ctx,
          auth.account,
          bucket.name,
          key,
          r.raw.headers.get('content-type'),
          metaFromHeaders(r.raw.headers),
        );
        return xmlResponse(
          xmlDoc('InitiateMultipartUploadResult', {
            Bucket: bucket.name,
            Key: key,
            UploadId: up.id,
          }),
        );
      }
      if (q.has('uploadId')) {
        r.op = 'CompleteMultipartUpload';
        const condition = writeCondition(r.raw.headers);
        const xml = await readSmallBody(r);
        const parts = xmlElements(xml, 'Part').map((p) => ({
          partNumber: Number(xmlText(p, 'PartNumber')),
          etag: xmlText(p, 'ETag') ?? '',
        }));
        if (
          !xmlElements(xml, 'CompleteMultipartUpload').length ||
          parts.some((p) => !Number.isInteger(p.partNumber))
        )
          throw new S3Error(
            'MalformedXML',
            'The XML you provided was not well-formed or did not validate against our published schema.',
          );
        const row = await completeUpload(
          r.ctx,
          auth.account,
          bucket.name,
          key,
          q.get('uploadId')!,
          parts,
          condition,
        );
        const origin = r.ctx.env.S3_ORIGIN!;
        return xmlResponse(
          xmlDoc('CompleteMultipartUploadResult', {
            Location: `${origin}/${encodeURIComponent(bucket.name)}/${key.split('/').map(encodeURIComponent).join('/')}`,
            Bucket: bucket.name,
            Key: key,
            ETag: quoted(row.etag),
          }),
        );
      }
      throw new S3Error('NotImplemented', 'This POST request is not supported by Zeiko S3.');
    default:
      throw new S3Error(
        'MethodNotAllowed',
        'The specified method is not allowed against this resource.',
      );
  }
}

/** On an own address: only its owner's key, and only its owner's buckets (else they don't exist). */
async function ownerOnly(r: Req): Promise<void> {
  if (r.hostOwner === null) return;
  if (r.auth && r.auth.userId !== r.hostOwner) throw new S3Error('AccessDenied', 'Access Denied');
  if (!r.bucket) return;
  const b = await getBucket(r.ctx, r.bucket);
  const creating = r.method === 'PUT' && r.key === null && !b;
  if (!creating && b?.user_id !== r.hostOwner)
    throw new S3Error('NoSuchBucket', 'The specified bucket does not exist.', {
      BucketName: r.bucket,
    });
}

async function dispatch(r: Req): Promise<Response> {
  await ownerOnly(r);
  if (!r.bucket) {
    if (r.method !== 'GET')
      throw new S3Error(
        'MethodNotAllowed',
        'The specified method is not allowed against this resource.',
      );
    return listAllBuckets(r);
  }
  return r.key === null ? bucketOp(r) : objectOp(r);
}

/**
 * Entry point for every request on the S3 host. `waitUntil` lets the egress count finish after the
 * response has gone (it is awaited without one).
 */
export async function handleS3(
  raw: Request,
  ctx: Ctx,
  waitUntil?: (p: Promise<unknown>) => void,
  hostOwner: string | null = null,
): Promise<Response> {
  const requestId =
    raw.headers.get('cf-ray') ?? crypto.randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase();
  const url = new URL(raw.url);
  const r: Req = {
    ctx,
    raw,
    url,
    method: raw.method,
    query: new Map(),
    bucket: null,
    key: null,
    auth: null,
    requestId,
    bytesIn: 0,
    bytesOut: 0,
    egressTo: null,
    hostOwner,
    op: 'Unknown',
    stats: null,
    objectSize: null,
    errorCode: null,
  };
  const started = Date.now();
  const arrived = ctx.now();
  let res: Response;
  try {
    if (!s3Configured(ctx.env))
      throw new S3Error('ServiceUnavailable', 'Zeiko S3 is not available here yet.');
    const pairs = parseQuery(url.search);
    r.query = new Map(pairs);
    Object.assign(r, locate(url, ctx.env, hostOwner !== null));
    if (raw.method === 'OPTIONS') res = await preflight(r);
    else {
      r.auth = await authenticate(ctx, raw, url, pairs);
      res = await dispatch(r);
    }
  } catch (e) {
    let err: S3Error;
    if (isS3Error(e)) err = e;
    else {
      log.error('s3_error', { requestId, op: r.op, message: errorMessage(e) });
      err = new S3Error('InternalError', 'We encountered an internal error. Please try again.');
    }
    // Draining an unread body keeps the connection usable for the client's next request.
    if (raw.body && !raw.bodyUsed) void raw.body.cancel().catch(() => undefined);
    r.errorCode = err.code;
    res = s3ErrorResponse(err, url.pathname, requestId, raw.method === 'HEAD');
  }
  const out = new Response(res.body, res);
  out.headers.set('x-amz-request-id', requestId);
  out.headers.set('Server', 'ZeikoS3');
  // A browser on another site (ADR-055): the bucket's first matching rule, errors included.
  const origin = raw.headers.get('origin');
  if (origin && raw.method !== 'OPTIONS' && r.bucket) {
    const bucket = await corsBucket(r).catch(() => null);
    const rule = bucket ? matchCors(bucketCors(bucket), origin, raw.method) : null;
    if (rule) for (const [k, v] of corsHeaders(rule, origin, null)) out.headers.set(k, v);
  }
  track(ctx.env.ANALYTICS, 's3_request', {
    index: r.auth?.userId ?? 'anonymous',
    blobs: [r.op, String(out.status), r.bucket ?? ''],
    doubles: [r.bytesIn, r.bytesOut],
  });
  if (r.egressTo && r.bytesOut > 0 && out.status < 300) {
    const { userId, periodStart } = r.egressTo;
    const metered = meterS3Egress(ctx, userId, periodStart, r.bytesOut).catch((e: unknown) =>
      log.error('s3_egress_meter_failed', { requestId, message: errorMessage(e) }),
    );
    if (waitUntil) waitUntil(metered);
    else await metered;
  }
  // A deleted bucket keeps no counters (they went with it).
  if (r.stats && !(r.op === 'DeleteBucket' && out.status < 300)) {
    const counted = recordS3Request(ctx, {
      bucket: r.stats,
      account: r.auth?.account ?? null,
      at: arrived,
      ms: Date.now() - started,
      method: raw.method,
      url,
      key: r.key,
      status: out.status,
      errorCode: r.errorCode,
      bytesIn: r.bytesIn,
      bytesOut: r.bytesOut,
      objectSize: r.objectSize,
      ip: clientIp(raw),
      requester: r.auth?.userId ?? null,
      requestId,
      referer: raw.headers.get('referer'),
      userAgent: raw.headers.get('user-agent'),
      host: url.host,
      auth: r.auth ? (r.auth.parsed.kind === 'query' ? 'QueryString' : 'AuthHeader') : null,
    }).catch((e: unknown) => log.error('s3_stats_failed', { requestId, message: errorMessage(e) }));
    if (waitUntil) waitUntil(counted);
    else await counted;
  }
  return out;
}
