// /api/s3: the signed-in person's own Zeiko S3 page (ADR-044): endpoint, storage, plan, own address,
// access keys and buckets. Plans and addresses are bought through /api/billing/checkout (ADR-047/048).
import { Hono } from 'hono';
import { z } from 'zod';
import { validate } from '../lib/validate';
import { requireUser } from '../middleware/auth';
import { createBucket, createKey, revokeKey, s3Overview, setBucketPublic } from '../services/s3';
import { deleteBucket } from '../services/s3-objects';
import {
  browseObjects,
  cancelWebUpload,
  deleteKeys,
  finishWebUpload,
  objectLink,
  sendWebPart,
  startWebUpload,
  uploadObject,
  webUploadParts,
} from '../services/s3-browse';
import { CORS_METHODS, getBucketCors, MAX_CORS_RULES, setBucketCors } from '../services/s3-cors';
import { setBucketLifecycle } from '../services/s3-lifecycle';
import { contentLength } from '../lib/http';
import { rateLimit } from '../middleware/ratelimit';
import { checkS3Url, releaseS3Url } from '../services/s3-urls';
import { activeAccount, s3Call } from '../services/s3-app';
import { bucketStats, MAX_LOG_PREFIX, setBucketLogging } from '../services/s3-stats';
import type { AppBindings } from '../types';
import { S3KeyCreate } from './v1-schemas';

const bucketName = z.string().min(3).max(63);
const objectKey = z.string().min(1).max(1024);
const days = z.number().int().min(1).max(36_500);
const lifecycleRule = z.object({
  id: z.string().max(255).default(''),
  enabled: z.boolean().default(true),
  prefix: z.string().max(1024).default(''),
  sizeGreaterThan: z.number().int().min(0).optional(),
  sizeLessThan: z.number().int().min(1).optional(),
  tags: z
    .array(z.object({ key: z.string().min(1).max(128), value: z.string().max(256) }))
    .max(10)
    .optional(),
  expirationDays: days.optional(),
  expirationDate: z.number().int().optional(),
  abortDays: days.optional(),
});
const corsRule = z.object({
  id: z.string().max(255).optional(),
  allowedOrigins: z.array(z.string().max(1024)).min(1).max(100),
  allowedMethods: z.array(z.enum(CORS_METHODS)).min(1),
  allowedHeaders: z.array(z.string().max(1024)).max(100).default([]),
  exposeHeaders: z.array(z.string().max(1024)).max(100).default([]),
  maxAgeSeconds: z.number().int().min(0).max(31_536_000).optional(),
});

export const s3 = new Hono<AppBindings>()
  .use('*', requireUser)
  .get('/', async (c) => c.json(await s3Overview(c.get('ctx'), c.get('user')!.id)))
  .post('/keys', validate('json', S3KeyCreate), async (c) => {
    const ctx = c.get('ctx');
    await activeAccount(ctx, c.get('user')!.id);
    const { label, ...scope } = c.req.valid('json');
    return c.json({ key: await createKey(ctx, c.get('user')!.id, label, scope) }, 201);
  })
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
  // The account's own address (ADR-048): bought through /api/billing/checkout.
  .post('/url/check', async (c) =>
    c.json({ url: await checkS3Url(c.get('ctx'), c.get('user')!.id) }),
  )
  .delete('/url', async (c) => {
    await releaseS3Url(c.get('ctx'), c.get('user')!.id, 'removed');
    return c.body(null, 204);
  })
  // The bucket's objects on the page (ADR-055).
  .get(
    '/buckets/:name/objects',
    validate(
      'query',
      z.object({
        prefix: z.string().max(1024).default(''),
        cursor: z.string().max(4096).optional(),
      }),
    ),
    async (c) => {
      const ctx = c.get('ctx');
      const acc = await activeAccount(ctx, c.get('user')!.id);
      const q = c.req.valid('query');
      return c.json(
        await s3Call(() =>
          browseObjects(ctx, acc, c.req.param('name'), q.prefix, q.cursor ?? null),
        ),
      );
    },
  )
  .post(
    '/buckets/:name/objects/link',
    validate(
      'json',
      z.object({
        key: objectKey,
        expiresInSeconds: z
          .number()
          .int()
          .min(60)
          .max(7 * 24 * 3600)
          .default(3600),
        download: z.boolean().default(true),
      }),
    ),
    async (c) => {
      const ctx = c.get('ctx');
      const acc = await activeAccount(ctx, c.get('user')!.id);
      const b = c.req.valid('json');
      return c.json(
        await s3Call(() =>
          objectLink(ctx, acc, c.req.param('name'), b.key, b.expiresInSeconds, b.download),
        ),
      );
    },
  )
  .post(
    '/buckets/:name/objects/delete',
    validate('json', z.object({ keys: z.array(objectKey).min(1).max(1000) })),
    async (c) => {
      const ctx = c.get('ctx');
      const acc = await activeAccount(ctx, c.get('user')!.id);
      const n = await s3Call(() =>
        deleteKeys(ctx, acc, c.req.param('name'), c.req.valid('json').keys),
      );
      return c.json({ deleted: n });
    },
  )
  .put(
    '/buckets/:name/objects',
    rateLimit('RL_UPLOAD', 's3-web-upload'),
    validate('query', z.object({ key: objectKey })),
    async (c) => {
      const ctx = c.get('ctx');
      const acc = await activeAccount(ctx, c.get('user')!.id);
      const object = await s3Call(() =>
        uploadObject(
          ctx,
          acc,
          c.req.param('name'),
          c.req.valid('query').key,
          contentLength(c.req.header('content-length')),
          c.req.header('x-object-content-type') ?? null,
          c.req.raw.body,
        ),
      );
      return c.json({ object }, 201);
    },
  )
  // Bigger files in parts (S4, ADR-075): start, send parts (any order, again after a failure), see
  // what is stored, finish, or cancel.
  .post(
    '/buckets/:name/uploads',
    rateLimit('RL_UPLOAD', 's3-web-upload'),
    validate(
      'json',
      z.object({
        key: objectKey,
        size: z.number().int().min(0),
        contentType: z.string().max(255).nullable().default(null),
      }),
    ),
    async (c) => {
      const ctx = c.get('ctx');
      const acc = await activeAccount(ctx, c.get('user')!.id);
      const b = c.req.valid('json');
      return c.json(
        await s3Call(() =>
          startWebUpload(ctx, acc, c.req.param('name'), b.key, b.size, b.contentType),
        ),
        201,
      );
    },
  )
  .put(
    '/buckets/:name/uploads/:id/parts/:n{[0-9]+}',
    validate('query', z.object({ key: objectKey })),
    async (c) => {
      const ctx = c.get('ctx');
      const acc = await activeAccount(ctx, c.get('user')!.id);
      return c.json(
        await s3Call(() =>
          sendWebPart(
            ctx,
            acc,
            c.req.param('name'),
            c.req.valid('query').key,
            c.req.param('id'),
            Number(c.req.param('n')),
            contentLength(c.req.header('content-length')),
            c.req.raw.body,
          ),
        ),
      );
    },
  )
  .get('/buckets/:name/uploads/:id', validate('query', z.object({ key: objectKey })), async (c) => {
    const ctx = c.get('ctx');
    const acc = await activeAccount(ctx, c.get('user')!.id);
    const parts = await s3Call(() =>
      webUploadParts(ctx, acc, c.req.param('name'), c.req.valid('query').key, c.req.param('id')),
    );
    return c.json({ parts });
  })
  .post(
    '/buckets/:name/uploads/:id/complete',
    validate(
      'json',
      z.object({
        key: objectKey,
        parts: z
          .array(
            z.object({
              partNumber: z.number().int().min(1).max(10_000),
              etag: z.string().max(200),
            }),
          )
          .min(1)
          .max(10_000),
      }),
    ),
    async (c) => {
      const ctx = c.get('ctx');
      const acc = await activeAccount(ctx, c.get('user')!.id);
      const b = c.req.valid('json');
      const object = await s3Call(() =>
        finishWebUpload(ctx, acc, c.req.param('name'), b.key, c.req.param('id'), b.parts),
      );
      return c.json({ object }, 201);
    },
  )
  .delete(
    '/buckets/:name/uploads/:id',
    validate('query', z.object({ key: objectKey })),
    async (c) => {
      const ctx = c.get('ctx');
      const acc = await activeAccount(ctx, c.get('user')!.id);
      await s3Call(() =>
        cancelWebUpload(ctx, acc, c.req.param('name'), c.req.valid('query').key, c.req.param('id')),
      );
      return c.body(null, 204);
    },
  )
  .get('/buckets/:name/cors', async (c) => {
    const ctx = c.get('ctx');
    await activeAccount(ctx, c.get('user')!.id);
    return c.json({
      rules: await s3Call(() => getBucketCors(ctx, c.get('user')!.id, c.req.param('name'))),
    });
  })
  .put(
    '/buckets/:name/cors',
    validate('json', z.object({ rules: z.array(corsRule).min(1).max(MAX_CORS_RULES) })),
    async (c) => {
      const ctx = c.get('ctx');
      await activeAccount(ctx, c.get('user')!.id);
      const rules = await s3Call(() =>
        setBucketCors(ctx, c.get('user')!.id, c.req.param('name'), c.req.valid('json').rules),
      );
      return c.json({ rules });
    },
  )
  .delete('/buckets/:name/cors', async (c) => {
    const ctx = c.get('ctx');
    await activeAccount(ctx, c.get('user')!.id);
    await s3Call(() => setBucketCors(ctx, c.get('user')!.id, c.req.param('name'), null));
    return c.body(null, 204);
  })
  // Lifecycle rules (ADR-072): the editor sends the whole list; validated like the S3 API's XML.
  .put(
    '/buckets/:name/lifecycle',
    validate('json', z.object({ rules: z.array(lifecycleRule).min(1).max(1000) })),
    async (c) => {
      const ctx = c.get('ctx');
      await activeAccount(ctx, c.get('user')!.id);
      const rules = await s3Call(() =>
        setBucketLifecycle(ctx, c.get('user')!.id, c.req.param('name'), c.req.valid('json').rules),
      );
      return c.json({ rules });
    },
  )
  .delete('/buckets/:name/lifecycle', async (c) => {
    const ctx = c.get('ctx');
    await activeAccount(ctx, c.get('user')!.id);
    await s3Call(() => setBucketLifecycle(ctx, c.get('user')!.id, c.req.param('name'), null));
    return c.body(null, 204);
  })
  // Statistics and access logging per bucket (ADR-060).
  .get('/buckets/:name/stats', async (c) => {
    const ctx = c.get('ctx');
    const acc = await activeAccount(ctx, c.get('user')!.id);
    return c.json(await s3Call(() => bucketStats(ctx, acc, c.req.param('name'))));
  })
  .put(
    '/buckets/:name/logging',
    validate(
      'json',
      z.object({ target: bucketName, prefix: z.string().max(MAX_LOG_PREFIX).default('') }),
    ),
    async (c) => {
      const ctx = c.get('ctx');
      await activeAccount(ctx, c.get('user')!.id);
      const logging = await s3Call(() =>
        setBucketLogging(ctx, c.get('user')!.id, c.req.param('name'), c.req.valid('json')),
      );
      return c.json({ logging });
    },
  )
  .delete('/buckets/:name/logging', async (c) => {
    const ctx = c.get('ctx');
    await activeAccount(ctx, c.get('user')!.id);
    await s3Call(() => setBucketLogging(ctx, c.get('user')!.id, c.req.param('name'), null));
    return c.body(null, 204);
  })
  .delete('/buckets/:name', async (c) => {
    const ctx = c.get('ctx');
    const acc = await activeAccount(ctx, c.get('user')!.id);
    await s3Call(() => deleteBucket(ctx, acc, c.req.param('name')));
    return c.body(null, 204);
  });
