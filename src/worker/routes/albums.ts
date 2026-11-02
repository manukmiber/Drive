// D10 (ADR-093): albums in the Gallery, under /api/albums.
import { Hono } from 'hono';
import { z } from 'zod';
import { validate } from '../lib/validate';
import { requireUser } from '../middleware/auth';
import { createAlbum, deleteAlbum, getAlbum, listAlbums, updateAlbum } from '../services/albums';
import type { AppBindings } from '../types';

const id = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const ids = z.array(id).max(1000);
const name = z.string().trim().min(1).max(120);

export const albums = new Hono<AppBindings>()
  .use('*', requireUser)
  .get('/', async (c) => c.json({ items: await listAlbums(c.get('ctx'), c.get('user')!.id) }))
  .post(
    '/',
    validate(
      'json',
      z.object({
        name,
        space: z.enum(['personal', 'family']).default('personal'),
        nodeIds: ids.optional(),
      }),
    ),
    async (c) =>
      c.json(
        { album: await createAlbum(c.get('ctx'), c.get('user')!.id, c.req.valid('json')) },
        201,
      ),
  )
  .get(
    '/:id',
    validate('param', z.object({ id })),
    validate(
      'query',
      z.object({
        offset: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(500).default(500),
      }),
    ),
    async (c) => {
      const q = c.req.valid('query');
      return c.json(
        await getAlbum(c.get('ctx'), c.get('user')!.id, c.req.valid('param').id, q.offset, q.limit),
      );
    },
  )
  .patch(
    '/:id',
    validate('param', z.object({ id })),
    validate(
      'json',
      z
        .object({
          name: name.optional(),
          coverId: id.nullable().optional(),
          sort: z.enum(['added', 'newest', 'oldest']).optional(),
          add: ids.optional(),
          remove: ids.optional(),
          order: ids.optional(),
        })
        .refine((b) => Object.keys(b).length > 0),
    ),
    async (c) => {
      const b = c.req.valid('json');
      const album = await updateAlbum(c.get('ctx'), c.get('user')!.id, c.req.valid('param').id, {
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.coverId !== undefined ? { coverId: b.coverId } : {}),
        ...(b.sort !== undefined ? { sort: b.sort } : {}),
        ...(b.add ? { add: b.add } : {}),
        ...(b.remove ? { remove: b.remove } : {}),
        ...(b.order ? { order: b.order } : {}),
      });
      return c.json({ album });
    },
  )
  .delete('/:id', validate('param', z.object({ id })), async (c) => {
    await deleteAlbum(c.get('ctx'), c.get('user')!.id, c.req.valid('param').id);
    return c.body(null, 204);
  });
