// W1 (ADR-095): Zeiko Spaces, under /api/teams and /api/spaces. The rules are in services/spaces.ts.
import { Hono } from 'hono';
import { z } from 'zod';
import { validate } from '../lib/validate';
import { requireUser } from '../middleware/auth';
import { rateLimit } from '../middleware/ratelimit';
import {
  addSpaceMember,
  addTeamMember,
  createSpace,
  createTeam,
  deleteSpace,
  deleteTeam,
  getSpace,
  getTeam,
  listMine,
  removeSpaceMember,
  removeTeamMember,
  renameSpace,
  renameTeam,
  revokeSpaceInvite,
  revokeTeamInvite,
  setSpaceRole,
  setTeamRole,
  transferTeam,
} from '../services/spaces';
import type { AppBindings } from '../types';

const id = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const name = z.object({ name: z.string().min(1).max(200) });
const email = z.string().min(3).max(254);

export const teams = new Hono<AppBindings>()
  .use('*', requireUser)
  .get('/', async (c) => c.json(await listMine(c.get('ctx'), c.get('user')!.id)))
  .post('/', rateLimit('RL_SHARE_CREATE', 'team'), validate('json', name), async (c) =>
    c.json({ team: await createTeam(c.get('ctx'), c.get('user')!.id, c.req.valid('json')) }, 201),
  )
  .get('/:id', validate('param', z.object({ id })), async (c) =>
    c.json(await getTeam(c.get('ctx'), c.get('user')!.id, c.req.valid('param').id)),
  )
  .patch('/:id', validate('param', z.object({ id })), validate('json', name), async (c) => {
    await renameTeam(
      c.get('ctx'),
      c.get('user')!.id,
      c.req.valid('param').id,
      c.req.valid('json').name,
    );
    return c.body(null, 204);
  })
  .delete('/:id', validate('param', z.object({ id })), async (c) => {
    await deleteTeam(c.get('ctx'), c.get('user')!.id, c.req.valid('param').id);
    return c.body(null, 204);
  })
  .post(
    '/:id/members',
    rateLimit('RL_SHARE_SEND', 'team-member'),
    validate('param', z.object({ id })),
    validate('json', z.object({ email, role: z.enum(['admin', 'member']).default('member') })),
    async (c) =>
      c.json(
        await addTeamMember(
          c.get('ctx'),
          c.get('user')!.id,
          c.req.valid('param').id,
          c.req.valid('json'),
        ),
      ),
  )
  .patch(
    '/:id/members/:userId',
    validate('param', z.object({ id, userId: z.string().min(1).max(64) })),
    validate('json', z.object({ role: z.enum(['admin', 'member']) })),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(
        await setTeamRole(
          c.get('ctx'),
          c.get('user')!.id,
          p.id,
          p.userId,
          c.req.valid('json').role,
        ),
      );
    },
  )
  .delete(
    '/:id/members/:userId',
    validate('param', z.object({ id, userId: z.string().min(1).max(64) })),
    async (c) => {
      const p = c.req.valid('param');
      await removeTeamMember(c.get('ctx'), c.get('user')!.id, p.id, p.userId);
      return c.body(null, 204);
    },
  )
  .delete(
    '/:id/invites/:inviteId',
    validate('param', z.object({ id, inviteId: id })),
    async (c) => {
      const p = c.req.valid('param');
      await revokeTeamInvite(c.get('ctx'), c.get('user')!.id, p.id, p.inviteId);
      return c.body(null, 204);
    },
  )
  .post(
    '/:id/owner',
    validate('param', z.object({ id })),
    validate('json', z.object({ userId: z.string().min(1).max(64) })),
    async (c) =>
      c.json(
        await transferTeam(
          c.get('ctx'),
          c.get('user')!.id,
          c.req.valid('param').id,
          c.req.valid('json').userId,
        ),
      ),
  )
  .post(
    '/:id/spaces',
    rateLimit('RL_SHARE_CREATE', 'space'),
    validate('param', z.object({ id })),
    validate('json', name),
    async (c) =>
      c.json(
        {
          space: await createSpace(
            c.get('ctx'),
            c.get('user')!.id,
            c.req.valid('param').id,
            c.req.valid('json'),
          ),
        },
        201,
      ),
  );

export const spaces = new Hono<AppBindings>()
  .use('*', requireUser)
  .delete(
    '/:id/invites/:inviteId',
    validate('param', z.object({ id, inviteId: id })),
    async (c) => {
      const p = c.req.valid('param');
      await revokeSpaceInvite(c.get('ctx'), c.get('user')!.id, p.id, p.inviteId);
      return c.body(null, 204);
    },
  )
  .get('/:id', validate('param', z.object({ id })), async (c) =>
    c.json(await getSpace(c.get('ctx'), c.get('user')!.id, c.req.valid('param').id)),
  )
  .patch('/:id', validate('param', z.object({ id })), validate('json', name), async (c) => {
    await renameSpace(
      c.get('ctx'),
      c.get('user')!.id,
      c.req.valid('param').id,
      c.req.valid('json').name,
    );
    return c.body(null, 204);
  })
  .delete('/:id', validate('param', z.object({ id })), async (c) => {
    await deleteSpace(c.get('ctx'), c.get('user')!.id, c.req.valid('param').id);
    return c.body(null, 204);
  })
  .post(
    '/:id/members',
    rateLimit('RL_SHARE_SEND', 'space-member'),
    validate('param', z.object({ id })),
    validate('json', z.object({ email, role: z.enum(['member', 'guest']) })),
    async (c) =>
      c.json(
        await addSpaceMember(
          c.get('ctx'),
          c.get('user')!.id,
          c.req.valid('param').id,
          c.req.valid('json'),
        ),
      ),
  )
  .patch(
    '/:id/members/:userId',
    validate('param', z.object({ id, userId: z.string().min(1).max(64) })),
    validate('json', z.object({ role: z.enum(['member', 'guest']) })),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(
        await setSpaceRole(
          c.get('ctx'),
          c.get('user')!.id,
          p.id,
          p.userId,
          c.req.valid('json').role,
        ),
      );
    },
  )
  .delete(
    '/:id/members/:userId',
    validate('param', z.object({ id, userId: z.string().min(1).max(64) })),
    async (c) => {
      const p = c.req.valid('param');
      await removeSpaceMember(c.get('ctx'), c.get('user')!.id, p.id, p.userId);
      return c.body(null, 204);
    },
  );
