import { Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../lib/errors';
import { validate } from '../lib/validate';
import { requireUser } from '../middleware/auth';
import { requireNode } from '../services/access';
import { listRecent, listStarred, parseType, search, setStar } from '../services/browse';
import { downloadUrl, previewUrl } from '../services/download';
import {
  breadcrumb,
  copyFile,
  createFolder,
  deleteForever,
  emptyTrash,
  getNodeDto,
  listChildren,
  listTrash,
  moveNodes,
  renameNode,
  restoreNodes,
  trashNodes,
} from '../services/nodes';
import type { AppBindings } from '../types';

const id = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const ids = z.object({ ids: z.array(id).min(1).max(100) });
const THUMB_MAX_BYTES = 128 * 1024;

const listQuery = z.object({
  sort: z.enum(['name', 'updated', 'size', 'type']).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

// Mounted at /api, so auth is applied per prefix (a '*' guard would turn unknown routes into 401).
export const nodes = new Hono<AppBindings>()
  .use('/nodes/*', requireUser)
  .use('/folders', requireUser)
  .use('/trash', requireUser)
  .use('/trash/*', requireUser)
  .use('/files/*', requireUser)
  .use('/search', requireUser)
  .use('/starred', requireUser)
  .use('/recent', requireUser)
  .get(
    '/search',
    validate(
      'query',
      z.object({
        q: z.string().max(200),
        type: z.string().max(20).optional(),
        modifiedAfter: z.coerce.number().int().nonnegative().optional(),
        space: z.enum(['personal', 'family']).optional(),
      }),
    ),
    async (c) => {
      const q = c.req.valid('query');
      const items = await search(c.get('ctx'), c.get('user')!.id, {
        ...q,
        type: parseType(q.type),
      });
      return c.json({ items });
    },
  )
  .get('/starred', async (c) =>
    c.json({ items: await listStarred(c.get('ctx'), c.get('user')!.id) }),
  )
  .get('/recent', async (c) => c.json({ items: await listRecent(c.get('ctx'), c.get('user')!.id) }))
  .put('/nodes/:id/star', async (c) => {
    await setStar(c.get('ctx'), c.get('user')!.id, c.req.param('id'), true);
    return c.body(null, 204);
  })
  .delete('/nodes/:id/star', async (c) => {
    await setStar(c.get('ctx'), c.get('user')!.id, c.req.param('id'), false);
    return c.body(null, 204);
  })
  .get('/files/:id/preview', async (c) =>
    c.json(await previewUrl(c.get('ctx'), c.get('user')!.id, c.req.param('id'))),
  )
  .get('/nodes/:id', async (c) => {
    const ctx = c.get('ctx');
    const userId = c.get('user')!.id;
    const { access } = await requireNode(ctx, userId, c.req.param('id'));
    const [node, path] = await Promise.all([
      getNodeDto(ctx, userId, c.req.param('id')),
      breadcrumb(ctx, c.req.param('id')),
    ]);
    return c.json({ node, path, access });
  })
  .get('/nodes/:id/children', validate('query', listQuery), async (c) => {
    const ctx = c.get('ctx');
    const userId = c.get('user')!.id;
    const q = c.req.valid('query');
    const res = await listChildren(ctx, userId, c.req.param('id'), q);
    const path = q.cursor ? undefined : await breadcrumb(ctx, c.req.param('id'));
    return c.json({ ...res, path });
  })
  .post(
    '/folders',
    validate(
      'json',
      z.object({
        parentId: id,
        name: z.string().min(1).max(1024),
        onConflict: z.enum(['error', 'rename', 'reuse']).optional(),
      }),
    ),
    async (c) => {
      const b = c.req.valid('json');
      const node = await createFolder(
        c.get('ctx'),
        c.get('user')!.id,
        b.parentId,
        b.name,
        b.onConflict,
      );
      return c.json({ node }, 201);
    },
  )
  .patch(
    '/nodes/:id',
    validate('json', z.object({ name: z.string().min(1).max(1024) })),
    async (c) => {
      const node = await renameNode(
        c.get('ctx'),
        c.get('user')!.id,
        c.req.param('id'),
        c.req.valid('json').name,
      );
      return c.json({ node });
    },
  )
  .post('/nodes/move', validate('json', ids.extend({ targetId: id })), async (c) => {
    const b = c.req.valid('json');
    return c.json({ nodes: await moveNodes(c.get('ctx'), c.get('user')!.id, b.ids, b.targetId) });
  })
  .post('/nodes/:id/copy', validate('json', z.object({ targetId: id.optional() })), async (c) => {
    const node = await copyFile(
      c.get('ctx'),
      c.get('user')!.id,
      c.req.param('id'),
      c.req.valid('json').targetId,
    );
    return c.json({ node }, 201);
  })
  .post('/nodes/trash', validate('json', ids), async (c) => {
    return c.json({
      count: await trashNodes(c.get('ctx'), c.get('user')!.id, c.req.valid('json').ids),
    });
  })
  .post('/nodes/restore', validate('json', ids), async (c) => {
    return c.json({
      nodes: await restoreNodes(c.get('ctx'), c.get('user')!.id, c.req.valid('json').ids),
    });
  })
  .post('/nodes/delete', validate('json', ids), async (c) => {
    return c.json({
      count: await deleteForever(c.get('ctx'), c.get('user')!.id, c.req.valid('json').ids),
    });
  })
  .get('/trash', async (c) => {
    const ctx = c.get('ctx');
    const cfg = await ctx.config();
    return c.json({
      items: await listTrash(ctx, c.get('user')!.id),
      retentionDays: cfg.trash_retention_days,
    });
  })
  .post('/trash/empty', async (c) =>
    c.json({ count: await emptyTrash(c.get('ctx'), c.get('user')!.id) }),
  )
  .get('/files/:id/download', async (c) =>
    c.json(await downloadUrl(c.get('ctx'), c.get('user')!.id, c.req.param('id'))),
  )
  .put('/files/:id/thumbnail', async (c) => {
    const ctx = c.get('ctx');
    const { node } = await requireNode(ctx, c.get('user')!.id, c.req.param('id'), 'edit');
    if (node.kind !== 'file' || !node.blob_id) throw new AppError('BAD_REQUEST', 'not a file');
    const len = Number(c.req.header('content-length') ?? 'NaN');
    if (!Number.isFinite(len) || len <= 0 || len > THUMB_MAX_BYTES) {
      throw new AppError('PAYLOAD_TOO_LARGE', 'thumbnail must be ≤ 128 KB');
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const ascii = (s: number, l: number) => String.fromCharCode(...bytes.subarray(s, s + l));
    if (bytes.length !== len || ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WEBP') {
      throw new AppError('VALIDATION', 'thumbnail must be WebP');
    }
    const blob = await ctx.env.DB.prepare('SELECT uploader_id FROM blobs WHERE id = ?1')
      .bind(node.blob_id)
      .first<{ uploader_id: string }>();
    const key = `u/${blob!.uploader_id}/t/${node.blob_id}.webp`;
    await ctx.env.BUCKET.put(key, bytes, { httpMetadata: { contentType: 'image/webp' } });
    await ctx.env.DB.prepare('UPDATE blobs SET thumb_key = ?2 WHERE id = ?1')
      .bind(node.blob_id, key)
      .run();
    return c.body(null, 204);
  })
  .get('/files/:id/thumbnail', async (c) => {
    const ctx = c.get('ctx');
    const { node } = await requireNode(ctx, c.get('user')!.id, c.req.param('id'), 'view');
    const blob = node.blob_id
      ? await ctx.env.DB.prepare('SELECT thumb_key FROM blobs WHERE id = ?1')
          .bind(node.blob_id)
          .first<{ thumb_key: string | null }>()
      : null;
    if (!blob?.thumb_key) throw new AppError('NOT_FOUND', 'no thumbnail');
    const obj = await ctx.env.BUCKET.get(blob.thumb_key);
    if (!obj) throw new AppError('NOT_FOUND', 'no thumbnail');
    return new Response(obj.body, {
      headers: {
        'Content-Type': 'image/webp',
        'Cache-Control': 'private, max-age=86400, immutable',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "sandbox; default-src 'none'",
      },
    });
  });
