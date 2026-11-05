// W4 (ADR-096): what a room's frames leave for the Worker's side to do, shared by the Durable Object
// and the dev rooms: mentions of people who are not in the room become notices (bell, and email
// unless they switched it off), for those still in the Space and allowed in that topic.
import type { Ctx } from '../context';
import { log } from '../lib/log';
import { notify } from '../services/notify';
import { spaceRole } from '../services/spaces';
import type { Effect } from './space-room-core';

/** Mentions of people who are not in the room become notices, for those still in the Space. */
export async function mentionNotices(ctx: Ctx, space: string, effects: Effect[]): Promise<void> {
  for (const e of effects)
    for (const user of e.users) {
      try {
        const r = await spaceRole(ctx, user, space);
        if (!r || (r.role === 'guest' && !e.topic.guests)) continue;
        await notify(ctx, user, 'space_mention', {
          space,
          spaceName: r.space.name,
          topic: e.topic.id,
          topicName: e.topic.name,
          message: e.message.id,
          by: e.by.name,
          excerpt: e.message.excerpt,
        });
      } catch (err) {
        log.warn('space_mention_notice', { error: String(err) });
      }
    }
}
