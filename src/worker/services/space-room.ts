// W3 (ADR-096): what the Worker tells a Space's live room (rooms/space-room.ts). Membership is already
// changed in the access database when these run; the room only follows. Without the SPACE_ROOM
// binding there are no rooms and nothing to tell.
import type { Ctx } from '../context';
import type { Env } from '../env';
import { idSlices } from '../lib/access-db';
import { log } from '../lib/log';

export type RoomCall = 'member' | 'readonly' | 'forget' | 'files' | 'export' | 'purge';

export function roomStub(env: Env, spaceId: string): DurableObjectStub | null {
  const ns = env.SPACE_ROOM;
  return ns ? ns.get(ns.idFromName(spaceId)) : null;
}

/** One call to a room, awaited. Throws when the room answers with an error. */
export async function tellRoom(
  env: Env,
  spaceId: string,
  call: RoomCall,
  body: Record<string, unknown> = {},
): Promise<unknown> {
  const stub = roomStub(env, spaceId);
  if (!stub) return null;
  const res = await stub.fetch(`https://room/internal/${call}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`room ${call} answered ${res.status}`);
  return res.json();
}

/** As tellRoom, but a room that cannot be reached is logged, not an error. */
export async function tellRoomQuietly(
  env: Env,
  spaceId: string,
  call: RoomCall,
  body: Record<string, unknown> = {},
): Promise<void> {
  await tellRoom(env, spaceId, call, body).catch((e: unknown) =>
    log.warn('space_room_call', { spaceId, call, error: String(e) }),
  );
}

/** Spaces whose rooms go for good; through the cleanup queue, which retries. */
export async function purgeRooms(ctx: Ctx, spaceIds: readonly string[]): Promise<void> {
  if (!ctx.env.SPACE_ROOM || !spaceIds.length) return;
  for (let i = 0; i < spaceIds.length; i += 100)
    await ctx.env.CLEANUP_QUEUE.sendBatch(
      spaceIds.slice(i, i + 100).map((spaceId) => ({
        body: { type: 'space_room' as const, spaceId, call: 'purge' as const },
      })),
    );
}

/** Spaces whose rooms this person has been in (space_seen), whatever they are in now. */
export async function seenSpaces(ctx: Ctx, userId: string): Promise<string[]> {
  const A = ctx.env.ACCESS_DB;
  if (!A) return [];
  const { results } = await A.prepare(
    'SELECT space_id FROM space_seen WHERE user_id = ?1 ORDER BY first_at',
  )
    .bind(userId)
    .all<{ space_id: string }>();
  return results.map((r) => r.space_id);
}

/** T15: a deleted account's messages leave every room it was in. */
export async function forgetInRooms(ctx: Ctx, userId: string): Promise<void> {
  if (!ctx.env.SPACE_ROOM) return;
  const ids = await seenSpaces(ctx, userId);
  for (let i = 0; i < ids.length; i += 100)
    await ctx.env.CLEANUP_QUEUE.sendBatch(
      ids.slice(i, i + 100).map((spaceId) => ({
        body: { type: 'space_room' as const, spaceId, call: 'forget' as const, userId },
      })),
    );
}

/** The room's first sight of someone, so their messages can be found again (T15, export). */
export async function noteSeen(env: Env, spaceId: string, userId: string, now: number) {
  const A = env.ACCESS_DB;
  if (!A) return;
  await A.prepare(
    'INSERT OR IGNORE INTO space_seen (space_id, user_id, first_at) VALUES (?1, ?2, ?3)',
  )
    .bind(spaceId, userId, now)
    .run();
}

/** Rows about Spaces that are gone. */
export async function forgetSeen(env: Env, spaceIds: readonly string[]): Promise<void> {
  const A = env.ACCESS_DB;
  if (!A) return;
  for (const slice of idSlices(spaceIds))
    await A.prepare('DELETE FROM space_seen WHERE space_id IN (SELECT value FROM json_each(?1))')
      .bind(slice)
      .run();
}

/** Data export: what the person wrote in each room, at most `max` rooms per export. */
export async function exportRooms(ctx: Ctx, userId: string, max = 30) {
  if (!ctx.env.SPACE_ROOM) return { rooms: [], more: false };
  const ids = await seenSpaces(ctx, userId);
  const rooms: Array<{ spaceId: string; messages: unknown }> = [];
  for (const spaceId of ids.slice(0, max)) {
    try {
      const r = (await tellRoom(ctx.env, spaceId, 'export', { user: userId })) as {
        messages: unknown;
      };
      rooms.push({ spaceId, messages: r.messages });
    } catch (e) {
      rooms.push({ spaceId, messages: { unavailable: String(e) } });
    }
  }
  return { rooms, more: ids.length > max };
}
