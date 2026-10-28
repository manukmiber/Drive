// S3 error codes and their XML bodies (Zeiko S3, ADR-044). Clients key off `Code`, so the names and
// HTTP statuses follow Amazon S3's error list.
import { esc } from './s3-xml';

const STATUS = {
  AccessDenied: 403,
  AccountProblem: 403,
  AuthorizationHeaderMalformed: 400,
  AuthorizationQueryParametersError: 400,
  BadDigest: 400,
  BucketAlreadyExists: 409,
  BucketAlreadyOwnedByYou: 409,
  BucketNotEmpty: 409,
  /** A browser's CORS preflight that no rule allows (or no CORS on the bucket). */
  CORSResponse: 403,
  /** A conditional write lost to another write after its bytes were stored (ADR-068). */
  ConditionalRequestConflict: 409,
  EntityTooLarge: 400,
  EntityTooSmall: 400,
  IncompleteBody: 400,
  InternalError: 500,
  InvalidAccessKeyId: 403,
  InvalidArgument: 400,
  InvalidBucketName: 400,
  InvalidDigest: 400,
  InvalidPart: 400,
  InvalidPartOrder: 400,
  InvalidRange: 416,
  InvalidRequest: 400,
  InvalidTargetBucketForLogging: 400,
  InvalidURI: 400,
  KeyTooLongError: 400,
  MalformedXML: 400,
  MaxMessageLengthExceeded: 400,
  MetadataTooLarge: 400,
  MethodNotAllowed: 405,
  MissingContentLength: 411,
  MissingSecurityHeader: 400,
  NoSuchBucket: 404,
  NoSuchCORSConfiguration: 404,
  NoSuchKey: 404,
  NoSuchUpload: 404,
  NotImplemented: 501,
  NotModified: 304,
  PreconditionFailed: 412,
  /** Not an Amazon code: the storage an operator gave this account is full. */
  QuotaExceeded: 403,
  RequestTimeTooSkewed: 403,
  ServiceUnavailable: 503,
  SignatureDoesNotMatch: 403,
  SlowDown: 503,
  TooManyBuckets: 400,
  XAmzContentSHA256Mismatch: 400,
} as const;

export type S3ErrorCode = keyof typeof STATUS;

export class S3Error extends Error {
  readonly status: number;
  constructor(
    readonly code: S3ErrorCode,
    message?: string,
    /** Extra elements in the error body (e.g. BucketName). */
    readonly extra: Record<string, string> = {},
  ) {
    super(message ?? code);
    this.name = 'S3Error';
    this.status = STATUS[code];
  }
}

export const isS3Error = (e: unknown): e is S3Error => e instanceof S3Error;

export function s3ErrorResponse(
  e: S3Error,
  resource: string,
  requestId: string,
  head: boolean,
): Response {
  const headers = new Headers({ 'x-amz-request-id': requestId, 'Cache-Control': 'no-store' });
  // HEAD responses have no body; 304 never has one.
  if (head || e.status === 304) return new Response(null, { status: e.status, headers });
  const extra = Object.entries(e.extra)
    .map(([k, v]) => `<${k}>${esc(v)}</${k}>`)
    .join('');
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${e.code}</Code>` +
    `<Message>${esc(e.message)}</Message>${extra}<Resource>${esc(resource)}</Resource>` +
    `<RequestId>${esc(requestId)}</RequestId></Error>`;
  headers.set('Content-Type', 'application/xml');
  return new Response(body, { status: e.status, headers });
}
