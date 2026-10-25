// /api/s3: the signed-in person's own Zeiko S3 page (ADR-044): endpoint, storage, access keys and
// buckets. Turning Zeiko S3 on and setting its storage is the operator's (ops API, relay).
import { Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../lib/errors';
import { isS3Error, type S3Error } from '../lib/s3-errors';
import { validate } from '../lib/validate';
import { requireUser } from '../middleware/auth';
import {
  createBucket,
  createKey,
  getAccount,
  revokeKey,
  s3Configured,
  s3Overview,
  setBucketPublic,
} from '../services/s3';
import { deleteBucket } from '../services/s3-objects';
import type { Ctx } from '../context';
import type { AppBindings } from '../types';

function asAppError(e: S3Error): AppError {
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
      return new AppError('NOT_FOUND', e.message);
    case 'AccessDenied':
    case 'AccountProblem':
      return new AppError('FORBIDDEN', e.message, { reason: e.code });
    default:
      return new AppError('BAD_REQUEST', e.message, { reason: e.code });
  }
}

async function s3Call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw isS3Error(e) ? asAppError(e) : e;
  }
}

async function activeAccount(ctx: Ctx, userId: string) {
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

const bucketName = z.string().min(3).max(63);

export const s3 = new Hono<AppBindings>()
  .use('*', requireUser)
  .get('/', async (c) => c.json(await s3Overview(c.get('ctx'), c.get('user')!.id)))
  .post(
    '/keys',
    validate('json', z.object({ label: z.string().max(60).default('') })),
    async (c) => {
      const ctx = c.get('ctx');
      await activeAccount(ctx, c.get('user')!.id);
      return c.json(
        { key: await createKey(ctx, c.get('user')!.id, c.req.valid('json').label) },
        201,
      );
    },
  )
  .delete('/keys/:id', async (c) => {
    await revokeKey(c.get('ctx'), c.get('user')!.id, c.req.param('id'));
    return c.body(null, 204);
  })
  .post(
    '/buckets',
    validate('json', z.object({ name: bucketName, public: z.boolean().default(false) })),
    async (c) => {
      const ctx = c.get('ctx');
      const userId = c.get('user')!.id;
      await activeAccount(ctx, userId);
      const b = c.req.valid('json');
      const row = await s3Call(() => createBucket(ctx, userId, b.name, b.public));
      return c.json(
        {
          bucket: {
            name: row.name,
            public: Boolean(row.public),
            blocked: false,
            createdAt: row.created_at,
          },
        },
        201,
      );
    },
  )
  .patch('/buckets/:name', validate('json', z.object({ public: z.boolean() })), async (c) => {
    const ctx = c.get('ctx');
    const userId = c.get('user')!.id;
    await activeAccount(ctx, userId);
    await s3Call(() =>
      setBucketPublic(ctx, userId, c.req.param('name'), c.req.valid('json').public),
    );
    return c.body(null, 204);
  })
  .delete('/buckets/:name', async (c) => {
    const ctx = c.get('ctx');
    const acc = await activeAccount(ctx, c.get('user')!.id);
    await s3Call(() => deleteBucket(ctx, acc, c.req.param('name')));
    return c.body(null, 204);
  });
