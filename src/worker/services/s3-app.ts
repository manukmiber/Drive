// Zeiko S3 for the app's own API and /api/v1 (ADR-055, ADR-062): S3 errors as app errors, and the
// account a page or token may manage.
import type { Ctx } from '../context';
import { AppError } from '../lib/errors';
import { isS3Error, type S3Error } from '../lib/s3-errors';
import { getAccount, s3Configured } from './s3';

export function asAppError(e: S3Error): AppError {
  switch (e.code) {
    case 'BucketAlreadyExists':
    case 'BucketAlreadyOwnedByYou':
      return new AppError('NAME_CONFLICT', e.message, { reason: e.code });
    case 'BucketNotEmpty':
    case 'TooManyBuckets':
      return new AppError('CONFLICT', e.message, { reason: e.code });
    case 'InvalidBucketName':
      return new AppError('VALIDATION', e.message, { field: 'name', reason: e.code });
    case 'NoSuchBucket':
    case 'NoSuchKey':
      return new AppError('NOT_FOUND', e.message, { reason: e.code });
    case 'MalformedXML':
    case 'InvalidTargetBucketForLogging':
    case 'InvalidRequest':
    case 'KeyTooLongError':
    case 'InvalidArgument':
      return new AppError('VALIDATION', e.message, { reason: e.code });
    case 'QuotaExceeded':
      return new AppError('QUOTA_FULL', e.message, { reason: e.code });
    case 'EntityTooLarge':
      return new AppError('PAYLOAD_TOO_LARGE', e.message, { reason: e.code });
    case 'AccessDenied':
    case 'AccountProblem':
      return new AppError('FORBIDDEN', e.message, { reason: e.code });
    default:
      return new AppError('BAD_REQUEST', e.message, { reason: e.code });
  }
}

export async function s3Call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw isS3Error(e) ? asAppError(e) : e;
  }
}

export async function activeAccount(ctx: Ctx, userId: string) {
  if (!s3Configured(ctx.env))
    throw new AppError('FORBIDDEN', 'Zeiko S3 is not available', { reason: 's3_unconfigured' });
  const acc = await getAccount(ctx, userId);
  if (!acc || acc.status === 'deleting')
    throw new AppError('FORBIDDEN', 'Zeiko S3 is not enabled for this account', {
      reason: 's3_disabled',
    });
  if (acc.status !== 'active')
    throw new AppError('ACCOUNT_SUSPENDED', 'this Zeiko S3 account is suspended');
  return acc;
}

