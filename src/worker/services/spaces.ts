// W1 (ADR-095): Zeiko Spaces' teams and their Spaces. Who belongs where is a set of rows in the
// access database (migrations-access/0006), like person shares (ADR-085): it is "who may open what".
// A team's plan numbers (seats, Spaces, guests per Space, status) are copied onto the team: the
// config's defaults when it is made, the relay's once team plans are sold. Names and emails come
// from `users` in the main D1, by id, never joined.
//
// Roles. In a team: owner (one), admin, member, each on a seat. In a Space: the team's owner and
// admins are admins of every Space of their team without a row; a team member added to a Space is a
// member; anyone else added is a guest, on no seat, who never sees who else is there.
import type { Ctx } from '../context';
import { idSlices } from '../lib/access-db';
import { AppError } from '../lib/errors';
import { ulid } from '../lib/ids';
import { forgetInRooms, forgetSeen, purgeRooms, tellRoomQuietly } from './space-room';

export type TeamRole = 'owner' | 'admin' | 'member';
export type SpaceRole = 'admin' | 'member' | 'guest';
export type TeamStatus = 'active' | 'readonly' | 'frozen';

interface TeamRow {
  id: string;
  name: string;
  owner_id: string;
  seats: number;
  max_spaces: number;
  max_guests: number;
  status: TeamStatus;
  created_at: number;
  updated_at: number;
}

interface TeamMemberRow {
  team_id: string;
  user_id: string;
  role: TeamRole;
  added_by: string;
  joined_at: number;
}

interface SpaceRow {
  id: string;
  team_id: string;
  name: string;
  created_by: string;
  created_at: number;
  updated_at: number;
}

interface SpaceMemberRow {
  space_id: string;
  user_id: string;
  role: 'member' | 'guest';
  added_by: string;
  added_at: number;
}

export interface TeamDto {
  id: string;
  name: string;
  role: TeamRole;
  status: TeamStatus;
  seats: { used: number; total: number };
  maxSpaces: number;
  maxGuests: number;
  createdAt: number;
}

export interface SpaceDto {
  id: string;
  name: string;
  team: { id: string; name: string };
  role: SpaceRole;
  status: TeamStatus;
  createdAt: number;
}

export interface MemberDto {
  userId: string;
  name: string | null;
  email: string | null;
  role: TeamRole | SpaceRole;
  since: number;
}

const MAX_NAME = 60;

/** Spaces exist only with the access database; without it (not made yet) there are none. */
export function spacesDb(env: { ACCESS_DB?: D1Database }): D1Database | null {
  return env.ACCESS_DB ?? null;
}

function db(ctx: Ctx): D1Database {
  const A = spacesDb(ctx.env);
  if (!A) throw new AppError('BAD_REQUEST', 'Spaces are not available yet');
  return A;
}

function cleanName(v: string): string {
  const name = v.trim().replace(/\s+/g, ' ');
  if (!name || name.length > MAX_NAME)
    throw new AppError('VALIDATION', `a name is 1 to ${MAX_NAME} characters`);
  return name;
}

/* ------------------------------------------------------------- lookups -- */

async function teamRow(ctx: Ctx, teamId: string): Promise<TeamRow | null> {
  return db(ctx).prepare('SELECT * FROM teams WHERE id = ?1').bind(teamId).first<TeamRow>();
}

async function teamRole(ctx: Ctx, teamId: string, userId: string): Promise<TeamRole | null> {
  const r = await db(ctx)
    .prepare('SELECT role FROM team_members WHERE team_id = ?1 AND user_id = ?2')
    .bind(teamId, userId)
    .first<{ role: TeamRole }>();
  return r?.role ?? null;
}

/** The team, if the person is on it; anyone else is told it does not exist. */
async function requireTeam(
  ctx: Ctx,
  userId: string,
  teamId: string,
): Promise<{ team: TeamRow; role: TeamRole }> {
  const [team, role] = await Promise.all([teamRow(ctx, teamId), teamRole(ctx, teamId, userId)]);
  if (!team || !role) throw new AppError('NOT_FOUND', 'not found');
  return { team, role };
}

async function requireTeamAdmin(ctx: Ctx, userId: string, teamId: string) {
  const t = await requireTeam(ctx, userId, teamId);
  if (t.role === 'member') throw new AppError('FORBIDDEN', 'only the team owner and admins can');
  return t;
}

function assertActive(team: TeamRow): void {
  if (team.status !== 'active') throw new AppError('READ_ONLY', 'this team is read-only');
}

/** A person's role in a Space, null when they are not in it. */
export async function spaceRole(
  ctx: Ctx,
  userId: string,
  spaceId: string,
): Promise<{ space: SpaceRow; team: TeamRow; role: SpaceRole } | null> {
  const A = spacesDb(ctx.env);
  if (!A) return null;
  const space = await A.prepare('SELECT * FROM spaces WHERE id = ?1')
    .bind(spaceId)
    .first<SpaceRow>();
  if (!space) return null;
  const [team, inTeam, row] = await Promise.all([
    teamRow(ctx, space.team_id),
    teamRole(ctx, space.team_id, userId),
    A.prepare('SELECT role FROM space_members WHERE space_id = ?1 AND user_id = ?2')
      .bind(spaceId, userId)
      .first<{ role: 'member' | 'guest' }>(),
  ]);
  if (!team) return null;
  if (inTeam === 'owner' || inTeam === 'admin') return { space, team, role: 'admin' };
  if (!row) return null;
  return { space, team, role: row.role };
}

async function requireSpace(ctx: Ctx, userId: string, spaceId: string) {
  db(ctx);
  const s = await spaceRole(ctx, userId, spaceId);
  if (!s) throw new AppError('NOT_FOUND', 'not found');
  return s;
}

async function requireSpaceAdmin(ctx: Ctx, userId: string, spaceId: string) {
  const s = await requireSpace(ctx, userId, spaceId);
  if (s.role !== 'admin') throw new AppError('FORBIDDEN', 'only the team owner and admins can');
  return s;
}

async function teamSpaceIds(ctx: Ctx, teamId: string): Promise<string[]> {
  const { results } = await db(ctx)
    .prepare('SELECT id FROM spaces WHERE team_id = ?1')
    .bind(teamId)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

/**
 * The person's live connections in these Spaces follow their role now, or close when they are out
 * (ADR-096). After the response; the Worker checks the role again on every new connection anyway.
 */
function syncRooms(ctx: Ctx, userId: string, spaceIds: readonly string[]): void {
  if (!ctx.env.SPACE_ROOM || !spaceIds.length) return;
  ctx.defer(
    (async () => {
      for (const id of spaceIds) {
        const r = await spaceRole(ctx, userId, id);
        await tellRoomQuietly(ctx.env, id, 'member', { user: userId, role: r?.role ?? null });
      }
    })(),
  );
}

/** A Drive account by email: people are added by the address they sign in with. */
async function personByEmail(ctx: Ctx, email: string): Promise<{ id: string }> {
  const e = email.trim().toLowerCase();
  const person = await ctx.env.DB.prepare(
    `SELECT id FROM users WHERE lower(email) = ?1 AND status != 'deleted'`,
  )
    .bind(e)
    .first<{ id: string }>();
  if (!person)
    throw new AppError('NOT_FOUND', 'nobody uses Zeiko Drive with that email yet', {
      reason: 'no_account',
    });
  return person;
}

async function names(
  ctx: Ctx,
  ids: string[],
): Promise<Map<string, { name: string; email: string }>> {
  const out = new Map<string, { name: string; email: string }>();
  for (const slice of idSlices([...new Set(ids)])) {
    const { results } = await ctx.env.DB.prepare(
      `SELECT id, name, email FROM users WHERE id IN (SELECT value FROM json_each(?1)) AND status != 'deleted'`,
    )
      .bind(slice)
      .all<{ id: string; name: string; email: string }>();
    for (const r of results) out.set(r.id, { name: r.name, email: r.email });
  }
  return out;
}

async function seatsUsed(ctx: Ctx, teamIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const slice of idSlices(teamIds)) {
    const { results } = await db(ctx)
      .prepare(
        `SELECT team_id, COUNT(*) AS n FROM team_members
         WHERE team_id IN (SELECT value FROM json_each(?1)) GROUP BY team_id`,
      )
      .bind(slice)
      .all<{ team_id: string; n: number }>();
    for (const r of results) out.set(r.team_id, r.n);
  }
  return out;
}

const teamDto = (t: TeamRow, role: TeamRole, used: number): TeamDto => ({
  id: t.id,
  name: t.name,
  role,
  status: t.status,
  seats: { used, total: t.seats },
  maxSpaces: t.max_spaces,
  maxGuests: t.max_guests,
  createdAt: t.created_at,
});

const spaceDto = (s: SpaceRow, team: TeamRow, role: SpaceRole): SpaceDto => ({
  id: s.id,
  name: s.name,
  team: { id: team.id, name: team.name },
  role,
  status: team.status,
  createdAt: s.created_at,
});

/* -------------------------------------------------------------- reading -- */

/** The person's teams, and every Space they can open (as admin, member or guest). */
export async function listMine(
  ctx: Ctx,
  userId: string,
): Promise<{ teams: TeamDto[]; spaces: SpaceDto[] }> {
  const A = spacesDb(ctx.env);
  if (!A) return { teams: [], spaces: [] };
  const [{ results: mine }, { results: rows }] = await Promise.all([
    A.prepare('SELECT * FROM team_members WHERE user_id = ?1').bind(userId).all<TeamMemberRow>(),
    A.prepare('SELECT * FROM space_members WHERE user_id = ?1').bind(userId).all<SpaceMemberRow>(),
  ]);
  const role = new Map(mine.map((m) => [m.team_id, m.role]));
  const led = [...role.keys()].filter((id) => role.get(id) !== 'member');

  const spaces = new Map<string, SpaceRow>();
  for (const slice of idSlices(led)) {
    const { results } = await A.prepare(
      'SELECT * FROM spaces WHERE team_id IN (SELECT value FROM json_each(?1))',
    )
      .bind(slice)
      .all<SpaceRow>();
    for (const s of results) spaces.set(s.id, s);
  }
  const rowOf = new Map(rows.map((r) => [r.space_id, r.role]));
  for (const slice of idSlices(rows.map((r) => r.space_id).filter((id) => !spaces.has(id)))) {
    const { results } = await A.prepare(
      'SELECT * FROM spaces WHERE id IN (SELECT value FROM json_each(?1))',
    )
      .bind(slice)
      .all<SpaceRow>();
    for (const s of results) spaces.set(s.id, s);
  }

  // Teams of the person's own, and the teams of Spaces they are a guest in (for the name).
  const teamIds = [...new Set([...role.keys(), ...[...spaces.values()].map((s) => s.team_id)])];
  const teams = new Map<string, TeamRow>();
  for (const slice of idSlices(teamIds)) {
    const { results } = await A.prepare(
      'SELECT * FROM teams WHERE id IN (SELECT value FROM json_each(?1))',
    )
      .bind(slice)
      .all<TeamRow>();
    for (const t of results) teams.set(t.id, t);
  }
  const used = await seatsUsed(ctx, [...role.keys()]);

  const teamList = [...role.entries()]
    .flatMap(([id, r]) => {
      const t = teams.get(id);
      return t ? [teamDto(t, r, used.get(id) ?? 0)] : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const spaceList = [...spaces.values()]
    .flatMap((s) => {
      const t = teams.get(s.team_id);
      if (!t) return [];
      const r = role.get(s.team_id);
      const as: SpaceRole | undefined = r === 'owner' || r === 'admin' ? 'admin' : rowOf.get(s.id);
      return as ? [spaceDto(s, t, as)] : [];
    })
    .sort((a, b) => a.team.name.localeCompare(b.team.name) || a.name.localeCompare(b.name));
  return { teams: teamList, spaces: spaceList };
}

/** A team, its people and the Spaces this person can open in it. */
export async function getTeam(ctx: Ctx, userId: string, teamId: string) {
  const { team, role } = await requireTeam(ctx, userId, teamId);
  const { results } = await db(ctx)
    .prepare('SELECT * FROM team_members WHERE team_id = ?1 ORDER BY joined_at')
    .bind(teamId)
    .all<TeamMemberRow>();
  const who = await names(
    ctx,
    results.map((m) => m.user_id),
  );
  const spaces = (await listMine(ctx, userId)).spaces.filter((s) => s.team.id === teamId);
  return {
    team: teamDto(team, role, results.length),
    members: results.map((m): MemberDto => ({
      userId: m.user_id,
      name: who.get(m.user_id)?.name ?? null,
      email: who.get(m.user_id)?.email ?? null,
      role: m.role,
      since: m.joined_at,
    })),
    spaces,
  };
}

/** A Space and who is in it. A guest sees only themself. */
export async function getSpace(ctx: Ctx, userId: string, spaceId: string) {
  const { space, team, role } = await requireSpace(ctx, userId, spaceId);
  if (role === 'guest') return { space: spaceDto(space, team, role), members: [] as MemberDto[] };
  const A = db(ctx);
  const [{ results: admins }, { results: rows }] = await Promise.all([
    A.prepare(
      `SELECT * FROM team_members WHERE team_id = ?1 AND role IN ('owner', 'admin') ORDER BY joined_at`,
    )
      .bind(team.id)
      .all<TeamMemberRow>(),
    A.prepare('SELECT * FROM space_members WHERE space_id = ?1 ORDER BY added_at')
      .bind(spaceId)
      .all<SpaceMemberRow>(),
  ]);
  const who = await names(ctx, [...admins.map((m) => m.user_id), ...rows.map((r) => r.user_id)]);
  const person = (id: string, r: SpaceRole, since: number): MemberDto => ({
    userId: id,
    name: who.get(id)?.name ?? null,
    email: who.get(id)?.email ?? null,
    role: r,
    since,
  });
  return {
    space: spaceDto(space, team, role),
    members: [
      ...admins.map((m) => person(m.user_id, 'admin', m.joined_at)),
      ...rows.map((r) => person(r.user_id, r.role, r.added_at)),
    ],
  };
}

/* -------------------------------------------------------------- teams -- */

export async function createTeam(
  ctx: Ctx,
  userId: string,
  input: { name: string },
): Promise<TeamDto> {
  const A = db(ctx);
  const cfg = await ctx.config();
  if (!cfg.spaces_open) throw new AppError('FORBIDDEN', 'Spaces are not open yet');
  const name = cleanName(input.name);
  const owned = await A.prepare('SELECT COUNT(*) AS n FROM teams WHERE owner_id = ?1')
    .bind(userId)
    .first<{ n: number }>();
  if ((owned?.n ?? 0) >= cfg.team_max_owned)
    throw new AppError('CONFLICT', `at most ${cfg.team_max_owned} teams per person`, {
      reason: 'teams_full',
      max: cfg.team_max_owned,
    });
  const now = ctx.now();
  const team: TeamRow = {
    id: ulid(now),
    name,
    owner_id: userId,
    seats: cfg.team_default_seats,
    max_spaces: cfg.team_default_max_spaces,
    max_guests: cfg.team_default_max_guests,
    status: 'active',
    created_at: now,
    updated_at: now,
  };
  await A.batch([
    A.prepare(
      `INSERT INTO teams (id, name, owner_id, seats, max_spaces, max_guests, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?7)`,
    ).bind(team.id, name, userId, team.seats, team.max_spaces, team.max_guests, now),
    A.prepare(
      `INSERT INTO team_members (team_id, user_id, role, added_by, joined_at) VALUES (?1, ?2, 'owner', ?2, ?3)`,
    ).bind(team.id, userId, now),
  ]);
  return teamDto(team, 'owner', 1);
}

export async function renameTeam(ctx: Ctx, userId: string, teamId: string, name: string) {
  const { team } = await requireTeamAdmin(ctx, userId, teamId);
  assertActive(team);
  await db(ctx)
    .prepare('UPDATE teams SET name = ?2, updated_at = ?3 WHERE id = ?1')
    .bind(teamId, cleanName(name), ctx.now())
    .run();
}

/** Only the owner deletes a team, and every Space of it goes with it. */
export async function deleteTeam(ctx: Ctx, userId: string, teamId: string): Promise<void> {
  const { role } = await requireTeam(ctx, userId, teamId);
  if (role !== 'owner') throw new AppError('FORBIDDEN', 'only the team owner can delete it');
  await dropTeams(ctx, [teamId]);
}

async function dropTeams(ctx: Ctx, teamIds: string[]): Promise<void> {
  const A = db(ctx);
  const spaceIds: string[] = [];
  for (const slice of idSlices(teamIds)) {
    const { results } = await A.prepare(
      'SELECT id FROM spaces WHERE team_id IN (SELECT value FROM json_each(?1))',
    )
      .bind(slice)
      .all<{ id: string }>();
    spaceIds.push(...results.map((r) => r.id));
  }
  for (const slice of idSlices(teamIds))
    await A.batch([
      A.prepare(
        `DELETE FROM space_members WHERE space_id IN
           (SELECT id FROM spaces WHERE team_id IN (SELECT value FROM json_each(?1)))`,
      ).bind(slice),
      A.prepare('DELETE FROM spaces WHERE team_id IN (SELECT value FROM json_each(?1))').bind(
        slice,
      ),
      A.prepare('DELETE FROM team_members WHERE team_id IN (SELECT value FROM json_each(?1))').bind(
        slice,
      ),
      A.prepare('DELETE FROM teams WHERE id IN (SELECT value FROM json_each(?1))').bind(slice),
    ]);
  // Their live rooms go too: chat, topics, read marks (ADR-096).
  await purgeRooms(ctx, spaceIds);
  await forgetSeen(ctx.env, spaceIds);
}

/**
 * Puts someone with a Drive account on the team. Admins add members; only the owner adds admins. A
 * guest in the team's Spaces becomes a member of them, since team members are never guests.
 */
export async function addTeamMember(
  ctx: Ctx,
  userId: string,
  teamId: string,
  input: { email: string; role: 'admin' | 'member' },
) {
  const { team, role } = await requireTeamAdmin(ctx, userId, teamId);
  assertActive(team);
  if (input.role === 'admin' && role !== 'owner')
    throw new AppError('FORBIDDEN', 'only the team owner can add admins');
  const person = await personByEmail(ctx, input.email);
  const A = db(ctx);
  if (await teamRole(ctx, teamId, person.id))
    throw new AppError('CONFLICT', 'already on the team', { reason: 'already_member' });
  const used = (await seatsUsed(ctx, [teamId])).get(teamId) ?? 0;
  if (used >= team.seats)
    throw new AppError('CONFLICT', 'every seat is taken', {
      reason: 'seats_full',
      seats: team.seats,
    });
  const now = ctx.now();
  await A.batch([
    A.prepare(
      `INSERT INTO team_members (team_id, user_id, role, added_by, joined_at) VALUES (?1, ?2, ?3, ?4, ?5)`,
    ).bind(teamId, person.id, input.role, userId, now),
    A.prepare(
      `UPDATE space_members SET role = 'member' WHERE user_id = ?2 AND role = 'guest'
         AND space_id IN (SELECT id FROM spaces WHERE team_id = ?1)`,
    ).bind(teamId, person.id),
  ]);
  syncRooms(ctx, person.id, await teamSpaceIds(ctx, teamId));
  return getTeam(ctx, userId, teamId);
}

/** Only the owner makes or unmakes admins; the owner's own role moves by handing the team over. */
export async function setTeamRole(
  ctx: Ctx,
  userId: string,
  teamId: string,
  memberId: string,
  role: 'admin' | 'member',
) {
  const { team, role: mine } = await requireTeam(ctx, userId, teamId);
  if (mine !== 'owner') throw new AppError('FORBIDDEN', 'only the team owner can change roles');
  assertActive(team);
  const theirs = await teamRole(ctx, teamId, memberId);
  if (!theirs) throw new AppError('NOT_FOUND', 'not found');
  if (theirs === 'owner') throw new AppError('CONFLICT', 'hand the team over instead');
  await db(ctx)
    .prepare('UPDATE team_members SET role = ?3 WHERE team_id = ?1 AND user_id = ?2')
    .bind(teamId, memberId, role)
    .run();
  syncRooms(ctx, memberId, await teamSpaceIds(ctx, teamId));
  return getTeam(ctx, userId, teamId);
}

/**
 * Takes someone off the team, and out of its Spaces. Anyone but the owner may leave; admins remove
 * members, the owner removes anyone. The owner leaves only by handing the team over first.
 */
export async function removeTeamMember(
  ctx: Ctx,
  userId: string,
  teamId: string,
  memberId: string,
): Promise<void> {
  const { role: mine } = await requireTeam(ctx, userId, teamId);
  const theirs = await teamRole(ctx, teamId, memberId);
  if (!theirs) throw new AppError('NOT_FOUND', 'not found');
  if (theirs === 'owner') throw new AppError('CONFLICT', 'the owner hands the team over first');
  if (memberId !== userId) {
    if (mine === 'member') throw new AppError('FORBIDDEN', 'only the team owner and admins can');
    if (mine === 'admin' && theirs === 'admin')
      throw new AppError('FORBIDDEN', 'only the team owner can remove an admin');
  }
  const A = db(ctx);
  await A.batch([
    A.prepare('DELETE FROM team_members WHERE team_id = ?1 AND user_id = ?2').bind(
      teamId,
      memberId,
    ),
    A.prepare(
      `DELETE FROM space_members WHERE user_id = ?2
         AND space_id IN (SELECT id FROM spaces WHERE team_id = ?1)`,
    ).bind(teamId, memberId),
  ]);
  syncRooms(ctx, memberId, await teamSpaceIds(ctx, teamId));
}

/** The owner hands the team to someone on it, and stays on as an admin. */
export async function transferTeam(ctx: Ctx, userId: string, teamId: string, memberId: string) {
  const { role } = await requireTeam(ctx, userId, teamId);
  if (role !== 'owner') throw new AppError('FORBIDDEN', 'only the team owner can hand it over');
  if (memberId === userId) throw new AppError('VALIDATION', 'already the owner');
  if (!(await teamRole(ctx, teamId, memberId))) throw new AppError('NOT_FOUND', 'not found');
  const A = db(ctx);
  const cfg = await ctx.config();
  const owned = await A.prepare('SELECT COUNT(*) AS n FROM teams WHERE owner_id = ?1')
    .bind(memberId)
    .first<{ n: number }>();
  if ((owned?.n ?? 0) >= cfg.team_max_owned)
    throw new AppError('CONFLICT', 'they already own as many teams as one person may', {
      reason: 'teams_full',
      max: cfg.team_max_owned,
    });
  const now = ctx.now();
  await A.batch([
    A.prepare('UPDATE teams SET owner_id = ?2, updated_at = ?3 WHERE id = ?1').bind(
      teamId,
      memberId,
      now,
    ),
    A.prepare(`UPDATE team_members SET role = 'owner' WHERE team_id = ?1 AND user_id = ?2`).bind(
      teamId,
      memberId,
    ),
    A.prepare(`UPDATE team_members SET role = 'admin' WHERE team_id = ?1 AND user_id = ?2`).bind(
      teamId,
      userId,
    ),
    // A Space row of the new owner is not needed any more: owners are in every Space.
    A.prepare(
      `DELETE FROM space_members WHERE user_id = ?2
         AND space_id IN (SELECT id FROM spaces WHERE team_id = ?1)`,
    ).bind(teamId, memberId),
  ]);
  syncRooms(ctx, memberId, await teamSpaceIds(ctx, teamId));
  return getTeam(ctx, userId, teamId);
}

/* ------------------------------------------------------------- spaces -- */

export async function createSpace(
  ctx: Ctx,
  userId: string,
  teamId: string,
  input: { name: string },
): Promise<SpaceDto> {
  const { team } = await requireTeamAdmin(ctx, userId, teamId);
  assertActive(team);
  const A = db(ctx);
  const n = await A.prepare('SELECT COUNT(*) AS n FROM spaces WHERE team_id = ?1')
    .bind(teamId)
    .first<{ n: number }>();
  if ((n?.n ?? 0) >= team.max_spaces)
    throw new AppError('CONFLICT', `at most ${team.max_spaces} Spaces in this team`, {
      reason: 'spaces_full',
      max: team.max_spaces,
    });
  const now = ctx.now();
  const space: SpaceRow = {
    id: ulid(now),
    team_id: teamId,
    name: cleanName(input.name),
    created_by: userId,
    created_at: now,
    updated_at: now,
  };
  await A.prepare(
    `INSERT INTO spaces (id, team_id, name, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
  )
    .bind(space.id, teamId, space.name, userId, now)
    .run();
  return spaceDto(space, team, 'admin');
}

export async function renameSpace(ctx: Ctx, userId: string, spaceId: string, name: string) {
  const { team } = await requireSpaceAdmin(ctx, userId, spaceId);
  assertActive(team);
  await db(ctx)
    .prepare('UPDATE spaces SET name = ?2, updated_at = ?3 WHERE id = ?1')
    .bind(spaceId, cleanName(name), ctx.now())
    .run();
}

export async function deleteSpace(ctx: Ctx, userId: string, spaceId: string): Promise<void> {
  await requireSpaceAdmin(ctx, userId, spaceId);
  const A = db(ctx);
  await A.batch([
    A.prepare('DELETE FROM space_members WHERE space_id = ?1').bind(spaceId),
    A.prepare('DELETE FROM spaces WHERE id = ?1').bind(spaceId),
  ]);
  await purgeRooms(ctx, [spaceId]);
  await forgetSeen(ctx.env, [spaceId]);
}

/**
 * Adds someone to a Space, or changes how they are in it. A team member is a member; anyone else is a
 * guest, up to the team's guests per Space. The team's owner and admins are in every Space already.
 */
export async function addSpaceMember(
  ctx: Ctx,
  userId: string,
  spaceId: string,
  input: { email: string; role: 'member' | 'guest' },
) {
  const { team } = await requireSpaceAdmin(ctx, userId, spaceId);
  assertActive(team);
  const person = await personByEmail(ctx, input.email);
  await putSpaceMember(ctx, userId, spaceId, team, person.id, input.role);
  return getSpace(ctx, userId, spaceId);
}

export async function setSpaceRole(
  ctx: Ctx,
  userId: string,
  spaceId: string,
  memberId: string,
  role: 'member' | 'guest',
) {
  const { team } = await requireSpaceAdmin(ctx, userId, spaceId);
  assertActive(team);
  const row = await db(ctx)
    .prepare('SELECT role FROM space_members WHERE space_id = ?1 AND user_id = ?2')
    .bind(spaceId, memberId)
    .first<{ role: string }>();
  if (!row) throw new AppError('NOT_FOUND', 'not found');
  await putSpaceMember(ctx, userId, spaceId, team, memberId, role);
  return getSpace(ctx, userId, spaceId);
}

async function putSpaceMember(
  ctx: Ctx,
  actorId: string,
  spaceId: string,
  team: TeamRow,
  personId: string,
  role: 'member' | 'guest',
): Promise<void> {
  const A = db(ctx);
  const inTeam = await teamRole(ctx, team.id, personId);
  if (inTeam === 'owner' || inTeam === 'admin')
    throw new AppError('CONFLICT', 'team owners and admins are in every Space already', {
      reason: 'team_admin',
    });
  if (role === 'member' && !inTeam)
    throw new AppError('VALIDATION', 'add them to the team first, or as a guest', {
      reason: 'not_on_team',
    });
  if (role === 'guest' && inTeam)
    throw new AppError('VALIDATION', 'team members join a Space as members', {
      reason: 'on_team',
    });
  const before = await A.prepare(
    'SELECT role FROM space_members WHERE space_id = ?1 AND user_id = ?2',
  )
    .bind(spaceId, personId)
    .first<{ role: string }>();
  if (before?.role === role)
    throw new AppError('CONFLICT', 'already in this Space', { reason: 'already_member' });
  if (role === 'guest') {
    const g = await A.prepare(
      `SELECT COUNT(*) AS n FROM space_members WHERE space_id = ?1 AND role = 'guest'`,
    )
      .bind(spaceId)
      .first<{ n: number }>();
    if ((g?.n ?? 0) >= team.max_guests)
      throw new AppError('CONFLICT', `at most ${team.max_guests} guests in a Space`, {
        reason: 'guests_full',
        max: team.max_guests,
      });
  }
  if (before)
    await A.prepare('UPDATE space_members SET role = ?3 WHERE space_id = ?1 AND user_id = ?2')
      .bind(spaceId, personId, role)
      .run();
  else
    await A.prepare(
      `INSERT INTO space_members (space_id, user_id, role, added_by, added_at) VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
      .bind(spaceId, personId, role, actorId, ctx.now())
      .run();
  syncRooms(ctx, personId, [spaceId]);
}

/** Admins take someone out of a Space; anyone may leave one they were added to. */
export async function removeSpaceMember(
  ctx: Ctx,
  userId: string,
  spaceId: string,
  memberId: string,
): Promise<void> {
  const s = await requireSpace(ctx, userId, spaceId);
  if (memberId !== userId && s.role !== 'admin')
    throw new AppError('FORBIDDEN', 'only the team owner and admins can');
  const res = await db(ctx)
    .prepare('DELETE FROM space_members WHERE space_id = ?1 AND user_id = ?2')
    .bind(spaceId, memberId)
    .run();
  if (!res.meta.changes) throw new AppError('NOT_FOUND', 'not found');
  syncRooms(ctx, memberId, [spaceId]);
}

/* ----------------------------------------------------- account lifecycle -- */

/**
 * A deleted account: the teams it owned go, with their Spaces (the spec's rule, ADR-095: the owner
 * hands a team over first to keep it), and it leaves every other team and Space.
 */
export async function deleteTeamsOfUser(ctx: Ctx, userId: string): Promise<void> {
  const A = spacesDb(ctx.env);
  if (!A) return;
  const { results } = await A.prepare('SELECT id FROM teams WHERE owner_id = ?1')
    .bind(userId)
    .all<{ id: string }>();
  if (results.length)
    await dropTeams(
      ctx,
      results.map((t) => t.id),
    );
  // T15: their messages leave every room they were ever in, Spaces they left before included.
  await forgetInRooms(ctx, userId);
  await A.batch([
    A.prepare('DELETE FROM team_members WHERE user_id = ?1').bind(userId),
    A.prepare('DELETE FROM space_members WHERE user_id = ?1').bind(userId),
    A.prepare('DELETE FROM space_seen WHERE user_id = ?1').bind(userId),
  ]);
}

/** Data export: the teams and Spaces the person is in, and how. */
export async function exportTeams(ctx: Ctx, userId: string) {
  const { teams, spaces } = await listMine(ctx, userId);
  return {
    teams: teams.map((t) => ({ id: t.id, name: t.name, role: t.role, createdAt: t.createdAt })),
    spaces: spaces.map((s) => ({ id: s.id, name: s.name, teamId: s.team.id, role: s.role })),
  };
}
