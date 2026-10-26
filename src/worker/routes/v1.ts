// The public API, version 1 (ADR-061, ADR-062): Bearer access tokens only (no cookies, no CSRF),
// a scope per operation, the same services as the app. Every operation is an entry in ENDPOINTS;
// the router and /api/v1/openapi.json are both built from that list. Breaking changes go to
// /api/v2; new response fields may be added here.
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z, type ZodObject, type ZodType } from 'zod';
import { DAY_MS, JSON_BODY_MAX_BYTES } from '../../shared/constants';
import { sha256Hex } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { contentLength } from '../lib/http';
import { honoPath, openApiDocument, type Endpoint } from '../lib/openapi';
import { apiHeaders } from '../middleware/base';
import { errorBody } from '../middleware/errors';
import { enforceRateLimit } from '../middleware/ratelimit';
import { API_RATE_PER_MINUTE, scope, tokenAuth } from '../middleware/token';
import { requireNode } from '../services/access';
import { ensurePersonalSpace } from '../services/accounts';
import { parseType, search } from '../services/browse';
import { downloadUrl } from '../services/download';
import {
  breadcrumb,
  copyFile,
  createFolder,
  getNodeDto,
  listChildren,
  listTrash,
  moveNodes,
  renameNode,
  restoreNodes,
  trashNodes,
} from '../services/nodes';
import { createBucket, createKey, revokeKey, s3Overview, setBucketPublic } from '../services/s3';
import { activeAccount, s3Call } from '../services/s3-app';
import { MAX_CORS_RULES, setBucketCors } from '../services/s3-cors';
import { deleteBucket } from '../services/s3-objects';
import { createShare, listMyShares, revokeShare } from '../services/shares';
import { getActiveSubscription, getPoolUsage } from '../services/storage';
import {
  abortUpload,
  completeUpload,
  initUpload,
  uploadPart,
  uploadStatus,
} from '../services/uploads';
import type { AppBindings } from '../types';
import * as S from './v1-schemas';

type C = Context<AppBindings>;
type Out<T> = T extends ZodType ? z.output<T> : undefined;
interface Input<P, Q, B> {
  params: Out<P>;
  query: Out<Q>;
  body: Out<B>;
}
interface Op {
  def: Endpoint;
  handle: (
    c: C,
    input: { params: unknown; query: unknown; body: unknown },
  ) => Response | Promise<Response>;
}

function op<
  P extends ZodObject | undefined = undefined,
  Q extends ZodObject | undefined = undefined,
  B extends ZodType | undefined = undefined,
>(
  def: Omit<Endpoint, 'params' | 'query' | 'body'> & { params?: P; query?: Q; body?: B },
  handle: (c: C, input: Input<P, Q, B>) => Response | Promise<Response>,
): Op {
  return { def: def as Endpoint, handle: handle as Op['handle'] };
}

const userId = (c: C) => c.get('user')!.id;
const nodeParam = z.object({ id: S.ulidId });
const idParam = z.object({ id: z.string().min(1).max(64) });
const bucketParam = z.object({ name: z.string().min(3).max(63) });
const ids = z.object({ ids: z.array(S.ulidId).min(1).max(100) });
const NODE = z.object({ node: S.Node });
const NODES = z.object({ items: z.array(S.Node) });
const COUNT = z.object({ count: z.number().int() });

export const ENDPOINTS: readonly Op[] = [
  // ── account ──
  op(
    {
      method: 'get',
      path: '/me',
      scope: null,
      tag: 'Account',
      summary: 'Who the token belongs to and what it may do',
      responses: { 200: S.Me },
    },
    (c) => {
      const auth = c.get('token')!;
      return c.json({
        user: { id: auth.user.id, email: auth.user.email, name: auth.user.name },
        token: {
          id: auth.token.id,
          name: auth.token.name,
          scopes: auth.scopes,
          expiresAt: auth.token.expires_at,
        },
      });
    },
  ),
  op(
    {
      method: 'get',
      path: '/account',
      scope: null,
      tag: 'Account',
      summary: 'Profile, storage use and plan',
      responses: { 200: S.Account },
    },
    async (c) => {
      const ctx = c.get('ctx');
      const user = c.get('user')!;
      const space = await ensurePersonalSpace(ctx, user.id);
      const [storage, plan, row] = await Promise.all([
        getPoolUsage(ctx, space.poolId),
        getActiveSubscription(ctx, space.poolId),
        ctx.env.DB.prepare('SELECT locale FROM users WHERE id = ?1')
          .bind(user.id)
          .first<{ locale: string | null }>(),
      ]);
      return c.json({
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          locale: row?.locale === 'en' ? 'en' : 'id',
        },
        space: { personalRootId: space.personalRootId, familyRootId: space.familyRootId },
        storage: {
          limitBytes: storage.limitBytes,
          usedBytes: storage.usedBytes,
          reservedBytes: storage.reservedBytes,
        },
        plan: plan
          ? {
              code: plan.planCode,
              name: plan.planName,
              status: plan.status,
              periodEnd: plan.periodEnd,
              maxFileBytes: plan.maxFileBytes,
            }
          : null,
      });
    },
  ),

  // ── files and folders ──
  op(
    {
      method: 'get',
      path: '/nodes/{id}',
      scope: 'drive.read',
      tag: 'Drive',
      summary: 'A file or folder, with the folders above it',
      params: nodeParam,
      responses: { 200: z.object({ node: S.Node, path: z.array(S.Crumb) }) },
    },
    async (c, { params }) => {
      const ctx = c.get('ctx');
      // getNodeDto reads whatever it is given: access is checked here, as the app's route does.
      await requireNode(ctx, userId(c), params.id);
      const node = await getNodeDto(ctx, userId(c), params.id);
      return c.json({ node, path: await breadcrumb(ctx, params.id) });
    },
  ),
  op(
    {
      method: 'get',
      path: '/nodes/{id}/children',
      scope: 'drive.read',
      tag: 'Drive',
      summary: 'What is in a folder, a page at a time (pass nextCursor back as cursor)',
      params: nodeParam,
      query: z.object({
        sort: z.enum(['name', 'updated', 'size', 'type']).optional(),
        dir: z.enum(['asc', 'desc']).optional(),
        cursor: z.string().max(512).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      }),
      responses: { 200: NODES.extend({ nextCursor: z.string().nullable() }) },
    },
    async (c, { params, query }) => {
      const res = await listChildren(c.get('ctx'), userId(c), params.id, query);
      return c.json({ items: res.items, nextCursor: res.nextCursor });
    },
  ),
  op(
    {
      method: 'get',
      path: '/search',
      scope: 'drive.read',
      tag: 'Drive',
      summary: 'Find files and folders by name',
      query: z.object({
        q: z.string().max(200),
        type: z.string().max(20).optional(),
        modifiedAfter: z.coerce.number().int().nonnegative().optional(),
        space: z.enum(['personal', 'family']).optional(),
      }),
      responses: { 200: NODES },
    },
    async (c, { query }) =>
      c.json({
        items: await search(c.get('ctx'), userId(c), { ...query, type: parseType(query.type) }),
      }),
  ),
  op(
    {
      method: 'get',
      path: '/files/{id}/download',
      scope: 'drive.read',
      tag: 'Drive',
      summary: 'A short-lived signed URL that downloads the file (no token needed to fetch it)',
      params: nodeParam,
      responses: { 200: z.object({ url: z.string(), expiresAt: z.number().int() }) },
    },
    async (c, { params }) => {
      const r = await downloadUrl(c.get('ctx'), userId(c), params.id);
      return c.json({ url: new URL(r.url, c.env.APP_ORIGIN).toString(), expiresAt: r.expiresAt });
    },
  ),
  op(
    {
      method: 'get',
      path: '/trash',
      scope: 'drive.read',
      tag: 'Drive',
      summary: 'What is in the Trash',
      responses: { 200: NODES },
    },
    async (c) => c.json({ items: await listTrash(c.get('ctx'), userId(c)) }),
  ),
  op(
    {
      method: 'post',
      path: '/folders',
      scope: 'drive.write',
      tag: 'Drive',
      summary: 'Make a folder',
      idempotent: true,
      body: z.object({
        parentId: S.ulidId,
        name: z.string().min(1).max(1024),
        onConflict: z.enum(['error', 'rename', 'reuse']).optional(),
      }),
      responses: { 201: NODE },
    },
    async (c, { body }) =>
      c.json(
        {
          node: await createFolder(
            c.get('ctx'),
            userId(c),
            body.parentId,
            body.name,
            body.onConflict,
          ),
        },
        201,
      ),
  ),
  op(
    {
      method: 'patch',
      path: '/nodes/{id}',
      scope: 'drive.write',
      tag: 'Drive',
      summary: 'Rename',
      params: nodeParam,
      body: z.object({ name: z.string().min(1).max(1024) }),
      responses: { 200: NODE },
    },
    async (c, { params, body }) =>
      c.json({ node: await renameNode(c.get('ctx'), userId(c), params.id, body.name) }),
  ),
  op(
    {
      method: 'post',
      path: '/nodes/move',
      scope: 'drive.write',
      tag: 'Drive',
      summary: 'Move files and folders into a folder',
      body: ids.extend({ targetId: S.ulidId, confirmSpaceChange: z.boolean().optional() }),
      responses: { 200: z.object({ nodes: z.array(S.Node) }) },
    },
    async (c, { body }) =>
      c.json({
        nodes: await moveNodes(c.get('ctx'), userId(c), body.ids, body.targetId, {
          confirmSpaceChange: body.confirmSpaceChange ?? false,
        }),
      }),
  ),
  op(
    {
      method: 'post',
      path: '/nodes/{id}/copy',
      scope: 'drive.write',
      tag: 'Drive',
      summary: 'Copy a file (into its own folder unless targetId is given)',
      idempotent: true,
      params: nodeParam,
      body: z.object({ targetId: S.ulidId.optional() }),
      responses: { 201: NODE },
    },
    async (c, { params, body }) =>
      c.json({ node: await copyFile(c.get('ctx'), userId(c), params.id, body.targetId) }, 201),
  ),
  op(
    {
      method: 'post',
      path: '/nodes/trash',
      scope: 'drive.write',
      tag: 'Drive',
      summary: 'Move to the Trash',
      body: ids,
      responses: { 200: COUNT },
    },
    async (c, { body }) => c.json({ count: await trashNodes(c.get('ctx'), userId(c), body.ids) }),
  ),
  op(
    {
      method: 'post',
      path: '/nodes/restore',
      scope: 'drive.write',
      tag: 'Drive',
      summary: 'Bring back from the Trash',
      body: ids,
      responses: { 200: z.object({ nodes: z.array(S.Node) }) },
    },
    async (c, { body }) => c.json({ nodes: await restoreNodes(c.get('ctx'), userId(c), body.ids) }),
  ),

  // ── uploads (multipart, the app's own protocol) ──
  op(
    {
      method: 'post',
      path: '/uploads',
      scope: 'drive.write',
      tag: 'Uploads',
      summary:
        'Start an upload: reserves the space and says how to cut the file (partSize, totalParts)',
      idempotent: true,
      body: z.object({
        parentId: S.ulidId,
        name: z.string().min(1).max(1024),
        size: z.number().int().nonnegative(),
        mime: z.string().max(255).nullish(),
        lastModified: z.number().int().nonnegative().nullish(),
        onConflict: z.enum(['error', 'rename', 'replace']).optional(),
      }),
      responses: { 201: S.UploadInit },
    },
    async (c, { body }) => {
      await enforceRateLimit(c.env, 'RL_UPLOAD', `upload-init:${userId(c)}`);
      return c.json(await initUpload(c.get('ctx'), userId(c), body), 201);
    },
  ),
  op(
    {
      method: 'put',
      path: '/uploads/{id}/parts/{n}',
      scope: 'drive.write',
      tag: 'Uploads',
      summary: 'Send one part (1-based), exactly partSize bytes except the last',
      params: z.object({ id: S.ulidId, n: z.coerce.number().int().min(1).max(10_000) }),
      binary: true,
      responses: { 200: z.object({ partNumber: z.number().int(), size: z.number().int() }) },
    },
    async (c, { params }) =>
      c.json(
        await uploadPart(
          c.get('ctx'),
          userId(c),
          params.id,
          params.n,
          contentLength(c.req.header('content-length')),
          c.req.raw.body,
        ),
      ),
  ),
  op(
    {
      method: 'get',
      path: '/uploads/{id}',
      scope: 'drive.write',
      tag: 'Uploads',
      summary: 'Which parts arrived (to resume)',
      params: z.object({ id: S.ulidId }),
      responses: { 200: S.UploadStatus },
    },
    async (c, { params }) => c.json(await uploadStatus(c.get('ctx'), userId(c), params.id)),
  ),
  op(
    {
      method: 'post',
      path: '/uploads/{id}/complete',
      scope: 'drive.write',
      tag: 'Uploads',
      summary: 'Finish: the file appears once the security scan has passed',
      params: z.object({ id: S.ulidId }),
      responses: { 200: NODE },
    },
    async (c, { params }) =>
      c.json({ node: await completeUpload(c.get('ctx'), userId(c), params.id) }),
  ),
  op(
    {
      method: 'delete',
      path: '/uploads/{id}',
      scope: 'drive.write',
      tag: 'Uploads',
      summary: 'Give up an upload and free its space',
      params: z.object({ id: S.ulidId }),
      responses: { 204: null },
    },
    async (c, { params }) => {
      await abortUpload(c.get('ctx'), userId(c), params.id);
      return c.body(null, 204);
    },
  ),

  // ── share links ──
  op(
    {
      method: 'get',
      path: '/shares',
      scope: 'share',
      tag: 'Shares',
      summary: 'Your share links (optionally those of one item)',
      query: z.object({ nodeId: S.ulidId.optional() }),
      responses: { 200: z.object({ items: z.array(S.Share) }) },
    },
    async (c, { query }) =>
      c.json({ items: await listMyShares(c.get('ctx'), userId(c), query.nodeId) }),
  ),
  op(
    {
      method: 'post',
      path: '/shares',
      scope: 'share',
      tag: 'Shares',
      summary: 'Make a share link for files or a folder',
      idempotent: true,
      body: z.object({
        nodeIds: z.array(S.ulidId).min(1).max(100),
        title: z.string().max(200).optional(),
        expiresInHours: z
          .number()
          .int()
          .min(0)
          .max(24 * 365 * 5)
          .nullable()
          .optional(),
        maxDownloads: z.number().int().min(1).max(1_000_000).nullable().optional(),
        password: z.string().min(4).max(128).nullable().optional(),
        showListing: z.boolean().optional(),
      }),
      responses: { 201: z.object({ share: S.Share }) },
    },
    async (c, { body }) => {
      await enforceRateLimit(c.env, 'RL_SHARE_CREATE', `share-create:${userId(c)}`);
      return c.json({ share: await createShare(c.get('ctx'), userId(c), body) }, 201);
    },
  ),
  op(
    {
      method: 'delete',
      path: '/shares/{id}',
      scope: 'share',
      tag: 'Shares',
      summary: 'Turn a share link off',
      params: idParam,
      responses: { 204: null },
    },
    async (c, { params }) => {
      await revokeShare(c.get('ctx'), userId(c), params.id);
      return c.body(null, 204);
    },
  ),

  // ── Zeiko S3 management ──
  op(
    {
      method: 'get',
      path: '/s3',
      scope: 's3.manage',
      tag: 'Zeiko S3',
      summary: 'The Zeiko S3 account: endpoint, storage, keys and buckets',
      responses: { 200: S.S3Overview },
    },
    async (c) => {
      const ctx = c.get('ctx');
      await activeAccount(ctx, userId(c));
      const o = await s3Overview(ctx, userId(c));
      const a = o.account!;
      return c.json({
        endpoint: o.endpoint,
        region: o.region,
        account: {
          status: a.status,
          billingState: a.billingState,
          limitBytes: a.limitBytes,
          usedBytes: a.usedBytes,
        },
        keys: o.keys,
        buckets: o.buckets.map((b) => ({
          name: b.name,
          public: b.public,
          blocked: b.blocked,
          createdAt: b.createdAt,
        })),
      });
    },
  ),
  op(
    {
      method: 'post',
      path: '/s3/keys',
      scope: 's3.manage',
      tag: 'Zeiko S3',
      summary: 'Make an access key pair; the secret is in this answer only',
      idempotent: true,
      body: z.object({ label: z.string().max(60).default('') }),
      responses: { 201: z.object({ key: S.S3Key.extend({ secret: z.string() }) }) },
    },
    async (c, { body }) => {
      const ctx = c.get('ctx');
      await activeAccount(ctx, userId(c));
      return c.json({ key: await createKey(ctx, userId(c), body.label) }, 201);
    },
  ),
  op(
    {
      method: 'delete',
      path: '/s3/keys/{id}',
      scope: 's3.manage',
      tag: 'Zeiko S3',
      summary: 'Revoke an access key',
      params: idParam,
      responses: { 204: null },
    },
    async (c, { params }) => {
      await revokeKey(c.get('ctx'), userId(c), params.id);
      return c.body(null, 204);
    },
  ),
  op(
    {
      method: 'post',
      path: '/s3/buckets',
      scope: 's3.manage',
      tag: 'Zeiko S3',
      summary: 'Make a bucket',
      idempotent: true,
      body: z.object({ name: z.string().min(3).max(63), public: z.boolean().default(false) }),
      responses: { 201: z.object({ bucket: S.S3Bucket }) },
    },
    async (c, { body }) => {
      const ctx = c.get('ctx');
      await activeAccount(ctx, userId(c));
      const row = await s3Call(() => createBucket(ctx, userId(c), body.name, body.public));
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
  ),
  op(
    {
      method: 'patch',
      path: '/s3/buckets/{name}',
      scope: 's3.manage',
      tag: 'Zeiko S3',
      summary: 'Make a bucket public (objects readable without a key) or private',
      params: bucketParam,
      body: z.object({ public: z.boolean() }),
      responses: { 204: null },
    },
    async (c, { params, body }) => {
      const ctx = c.get('ctx');
      await activeAccount(ctx, userId(c));
      await s3Call(() => setBucketPublic(ctx, userId(c), params.name, body.public));
      return c.body(null, 204);
    },
  ),
  op(
    {
      method: 'put',
      path: '/s3/buckets/{name}/cors',
      scope: 's3.manage',
      tag: 'Zeiko S3',
      summary: 'Set the bucket’s CORS rules',
      params: bucketParam,
      body: z.object({ rules: z.array(S.CorsRule).min(1).max(MAX_CORS_RULES) }),
      responses: { 200: z.object({ rules: z.array(S.CorsRule) }) },
    },
    async (c, { params, body }) => {
      const ctx = c.get('ctx');
      await activeAccount(ctx, userId(c));
      return c.json({
        rules: await s3Call(() => setBucketCors(ctx, userId(c), params.name, body.rules)),
      });
    },
  ),
  op(
    {
      method: 'delete',
      path: '/s3/buckets/{name}/cors',
      scope: 's3.manage',
      tag: 'Zeiko S3',
      summary: 'Remove the bucket’s CORS rules',
      params: bucketParam,
      responses: { 204: null },
    },
    async (c, { params }) => {
      const ctx = c.get('ctx');
      await activeAccount(ctx, userId(c));
      await s3Call(() => setBucketCors(ctx, userId(c), params.name, null));
      return c.body(null, 204);
    },
  ),
  op(
    {
      method: 'delete',
      path: '/s3/buckets/{name}',
      scope: 's3.manage',
      tag: 'Zeiko S3',
      summary: 'Delete an empty bucket',
      params: bucketParam,
      responses: { 204: null },
    },
    async (c, { params }) => {
      const ctx = c.get('ctx');
      const acc = await activeAccount(ctx, userId(c));
      await s3Call(() => deleteBucket(ctx, acc, params.name));
      return c.body(null, 204);
    },
  ),
];

const OPENAPI: Endpoint = {
  method: 'get',
  path: '/openapi.json',
  scope: null,
  tag: 'Meta',
  summary: 'This document',
  public: true,
  responses: { 200: z.object({ openapi: z.string() }).loose() },
};

function parsed<T extends ZodType>(schema: T, value: unknown, where: string): z.output<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw new AppError('VALIDATION', `invalid ${where}`, { issues: r.error.issues });
  return r.data;
}

/**
 * Idempotency-Key (ADR-062): the first answer to a key is kept for a day and given back for the
 * same request; the same key with a different request is a conflict. Only successes are kept, so
 * a failed attempt can be retried with its key.
 */
const idempotency: MiddlewareHandler<AppBindings> = async (c, next) => {
  const key = c.req.header('idempotency-key');
  if (key === undefined) return next();
  if (!key || key.length > 255)
    throw new AppError('VALIDATION', 'Idempotency-Key must be 1–255 characters');
  const tokenId = c.get('token')!.token.id;
  const DB = c.env.DB;
  const now = c.get('ctx').now();
  const hash = await sha256Hex(`${c.req.method} ${c.req.path}\n${await c.req.raw.clone().text()}`);
  const prev = await DB.prepare(
    `SELECT request_hash, status, body FROM api_idempotency WHERE token_id = ?1 AND key = ?2 AND created_at > ?3`,
  )
    .bind(tokenId, key, now - DAY_MS)
    .first<{ request_hash: string; status: number; body: string | null }>();
  if (prev) {
    if (prev.request_hash !== hash)
      throw new AppError('CONFLICT', 'this Idempotency-Key was used for another request', {
        reason: 'idempotency_key_reused',
      });
    if (prev.status === 0)
      throw new AppError('CONFLICT', 'the first request with this key is still running', {
        reason: 'idempotency_in_progress',
      });
    return new Response(prev.body, {
      status: prev.status,
      headers: { 'content-type': 'application/json', 'idempotent-replayed': 'true' },
    });
  }
  const claim = await DB.prepare(
    `INSERT INTO api_idempotency (token_id, key, request_hash, status, body, created_at) VALUES (?1, ?2, ?3, 0, NULL, ?4)
     ON CONFLICT (token_id, key) DO UPDATE SET request_hash = excluded.request_hash, status = 0, body = NULL,
       created_at = excluded.created_at WHERE api_idempotency.created_at <= ?5`,
  )
    .bind(tokenId, key, hash, now, now - DAY_MS)
    .run();
  if (!claim.meta.changes)
    throw new AppError('CONFLICT', 'the first request with this key is still running', {
      reason: 'idempotency_in_progress',
    });
  const forget = () =>
    DB.prepare(`DELETE FROM api_idempotency WHERE token_id = ?1 AND key = ?2`)
      .bind(tokenId, key)
      .run();
  try {
    await next();
  } catch (e) {
    await forget();
    throw e;
  }
  if (c.res.status >= 300 || c.error) {
    await forget();
    return;
  }
  await DB.prepare(
    `UPDATE api_idempotency SET status = ?3, body = ?4 WHERE token_id = ?1 AND key = ?2`,
  )
    .bind(tokenId, key, c.res.status, await c.res.clone().text())
    .run();
};

const jsonLimit = bodyLimit({
  maxSize: JSON_BODY_MAX_BYTES,
  onError: () => {
    throw new AppError('PAYLOAD_TOO_LARGE', 'request body too large');
  },
});

function build() {
  const app = new Hono<AppBindings>();
  app.use('*', apiHeaders);
  app.get(honoPath(OPENAPI.path), (c) =>
    c.json(
      openApiDocument(
        ENDPOINTS.map((e) => e.def),
        new URL('/api/v1', c.env.APP_ORIGIN).toString(),
      ),
    ),
  );
  app.use('*', async (c, next) =>
    (c.req.header('content-type') ?? '').includes('application/json') ? jsonLimit(c, next) : next(),
  );
  app.use('*', tokenAuth);
  app.use('*', async (c, next) => {
    await next();
    c.header('X-RateLimit-Limit', String(API_RATE_PER_MINUTE));
    c.header('RateLimit-Policy', `${API_RATE_PER_MINUTE};w=60`);
  });
  for (const { def, handle } of ENDPOINTS) {
    const guards: MiddlewareHandler<AppBindings>[] = [];
    if (def.scope) guards.push(scope(def.scope));
    if (def.idempotent) guards.push(idempotency);
    const run: MiddlewareHandler<AppBindings> = async (c) => {
      let body: unknown;
      if (def.body) {
        const raw: unknown = await c.req.json().catch(() => {
          throw new AppError('VALIDATION', 'the body must be JSON');
        });
        body = parsed(def.body, raw, 'body');
      }
      return handle(c, {
        params: def.params ? parsed(def.params, c.req.param(), 'path') : undefined,
        query: def.query ? parsed(def.query, c.req.query(), 'query') : undefined,
        body,
      });
    };
    app.on([def.method.toUpperCase()], [honoPath(def.path)], ...guards, run);
  }
  app.all('*', (c) => c.json(errorBody('NOT_FOUND', 'no such endpoint'), 404));
  return app;
}

export const v1 = build();
export const OPENAPI_ENDPOINT = OPENAPI;
