// W1c (ADR-097): invitations for an address that has no Zeiko Drive account yet. An invitation holds
// what it offers (a team seat, or a guest's place in a Space) until that address first signs in to
// Drive — then services/spaces.ts turns it into a membership (`claimInvites`) — or until it runs out
// (`space_invite_days`). One email goes with it, in the inviter's language. The rules about who may
// invite whom are in services/spaces.ts; this file only keeps the rows and sends the email.
import { DAY_MS } from '../../shared/constants';
import type { Ctx } from '../context';
import { idSlices } from '../lib/access-db';
import { ulid } from '../lib/ids';
import { strings, type Lang } from '../lib/lang';
import { appUrl } from '../lib/paths';
import { noticeEmail } from './email-templates';

export interface InviteRow {
  id: string;
  team_id: string;
  space_id: string | null;
  email: string;
  role: string;
  invited_by: string;
  created_at: number;
  expires_at: number;
}

export interface InviteDto {
  id: string;
  email: string;
  role: string;
  invitedBy: string;
  createdAt: number;
  expiresAt: number;
}

export const inviteDto = (r: InviteRow): InviteDto => ({
  id: r.id,
  email: r.email,
  role: r.role,
  invitedBy: r.invited_by,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
});

/** The invitations still open for a team itself (spaceId null) or for one of its Spaces. */
export async function openInvites(
  A: D1Database,
  teamId: string,
  spaceId: string | null,
  now: number,
): Promise<InviteRow[]> {
  const { results } = await A.prepare(
    `SELECT * FROM space_invites WHERE team_id = ?1 AND COALESCE(space_id, '') = ?2 AND expires_at > ?3
     ORDER BY created_at`,
  )
    .bind(teamId, spaceId ?? '', now)
    .all<InviteRow>();
  return results;
}

/** Seats held by open team invitations, per team. */
export async function invitedSeats(
  A: D1Database,
  teamIds: readonly string[],
  now: number,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const slice of idSlices(teamIds)) {
    const { results } = await A.prepare(
      `SELECT team_id, COUNT(*) AS n FROM space_invites
       WHERE team_id IN (SELECT value FROM json_each(?1)) AND space_id IS NULL AND expires_at > ?2
       GROUP BY team_id`,
    )
      .bind(slice, now)
      .all<{ team_id: string; n: number }>();
    for (const r of results) out.set(r.team_id, r.n);
  }
  return out;
}

/** A guest's places held by open invitations to one Space. */
export async function invitedGuests(A: D1Database, spaceId: string, now: number): Promise<number> {
  const r = await A.prepare(
    'SELECT COUNT(*) AS n FROM space_invites WHERE space_id = ?1 AND expires_at > ?2',
  )
    .bind(spaceId, now)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

/** The invitation for this address, made or renewed (a second invite refreshes the first). */
export async function putInvite(
  ctx: Ctx,
  A: D1Database,
  p: { teamId: string; spaceId: string | null; email: string; role: string; by: string },
): Promise<InviteRow> {
  const cfg = await ctx.config();
  const now = ctx.now();
  const row: InviteRow = {
    id: ulid(now),
    team_id: p.teamId,
    space_id: p.spaceId,
    email: p.email,
    role: p.role,
    invited_by: p.by,
    created_at: now,
    expires_at: now + cfg.space_invite_days * DAY_MS,
  };
  await A.prepare(
    `INSERT INTO space_invites (id, team_id, space_id, email, role, invited_by, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT (team_id, COALESCE(space_id, ''), email) DO UPDATE SET
       role = excluded.role, invited_by = excluded.invited_by, created_at = excluded.created_at,
       expires_at = excluded.expires_at`,
  )
    .bind(
      row.id,
      row.team_id,
      row.space_id,
      row.email,
      row.role,
      row.invited_by,
      now,
      row.expires_at,
    )
    .run();
  return row;
}

/** Takes an invitation back; true when there was one for that team (and Space). */
export async function dropInvite(
  A: D1Database,
  inviteId: string,
  teamId: string,
  spaceId: string | null,
): Promise<boolean> {
  const res = await A.prepare(
    `DELETE FROM space_invites WHERE id = ?1 AND team_id = ?2 AND COALESCE(space_id, '') = ?3`,
  )
    .bind(inviteId, teamId, spaceId ?? '')
    .run();
  return res.meta.changes > 0;
}

/** Every invitation waiting for this address (and the ones that ran out, which go). */
export async function invitesFor(A: D1Database, email: string, now: number): Promise<InviteRow[]> {
  await A.prepare('DELETE FROM space_invites WHERE email = ?1 AND expires_at <= ?2')
    .bind(email, now)
    .run();
  const { results } = await A.prepare(
    'SELECT * FROM space_invites WHERE email = ?1 ORDER BY created_at',
  )
    .bind(email)
    .all<InviteRow>();
  return results;
}

/** The one email an invitation sends, in the inviter's language, to sign in with that address. */
export async function emailInvite(
  ctx: Ctx,
  to: string,
  inviterId: string,
  p: { name: string; space: boolean; role: string },
): Promise<void> {
  const inviter = await ctx.env.DB.prepare('SELECT name, email, locale FROM users WHERE id = ?1')
    .bind(inviterId)
    .first<{ name: string; email: string; locale: Lang }>();
  const lang = inviter?.locale ?? 'id';
  const m = strings(lang).mail;
  const by = inviter?.name || inviter?.email || '';
  await ctx.adapters.email.send({
    to: [to],
    tag: 'space_invite',
    ...(inviter?.email ? { replyTo: inviter.email } : {}),
    ...noticeEmail(lang, {
      title: m.spaceInviteTitle(by, p.name),
      paragraphs: [m.spaceInviteBody(p.space, p.role), m.spaceInviteSignIn(to)],
      cta: { label: m.ctaSpaces, url: appUrl(ctx.env, '/spaces') },
    }),
  });
}
