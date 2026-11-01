// D2 (ADR-085): sharing a file or folder with particular Zeiko accounts, and "Shared with me". The
// grants are rows of the access database (`node_grants`, migrations-access/0003); what they let a
// person do is worked out in services/access.ts (grant-lookup.ts). Only the item's own side shares:
// its owner in a personal space, a member in the family's.
import { DAY_MS } from '../../shared/constants';
import { matchesQuery, matchesType, queryWords, searchOrder } from '../../shared/drive-tree';
import type { Ctx } from '../context';
import { idSlices } from '../lib/access-db';
import { AppError } from '../lib/errors';
import { ulid } from '../lib/ids';
import { strings, type Lang } from '../lib/lang';
import { appUrl } from '../lib/paths';
import { requireNode, type NodeRecord } from './access';
import { recordActivity } from './activity';
import { noticeEmail } from './email-templates';
import { claimGrants, grantsDb, grantsOf, type GrantRole, type GrantRow } from './grant-lookup';
import { SELECT_DTO, toDto, type NodeDto } from './nodes';
import { notify } from './notify';
import { consumeUsage } from './share-send';
import type { SearchOptions } from './browse';

export { claimGrants } from './grant-lookup';

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i;
const MAX_PEOPLE = 50;

export interface PersonDto {
  id: string;
  userId: string | null;
  email: string | null;
  name: string | null;
  role: GrantRole;
  /** Shared to an address that hasn't signed in to Drive yet. */
  pending: boolean;
  expiresAt: number | null;
  createdAt: number;
}

export interface SharedWithMeItem {
  grantId: string;
  role: GrantRole;
  sharedBy: { id: string; name: string | null };
  sharedAt: number;
  expiresAt: number | null;
  node: NodeDto;
}

function db(ctx: Ctx): D1Database {
  const A = grantsDb(ctx.env);
  if (!A) throw new AppError('BAD_REQUEST', 'sharing with people is not available yet');
  return A;
}

const parseRole = (v: unknown): GrantRole => {
  if (v !== 'view' && v !== 'edit') throw new AppError('VALIDATION', 'role is view or edit');
  return v;
};

/** The item, if this person may share it with others: not through someone else's share. */
async function requireSharable(ctx: Ctx, userId: string, nodeId: string): Promise<NodeRecord> {
  const { node, access } = await requireNode(ctx, userId, nodeId, 'view');
  if (access.shared) throw new AppError('FORBIDDEN', 'only the owner can share this item');
  if (node.parent_id === null) throw new AppError('FORBIDDEN', 'cannot share a root folder');
  if (node.trashed_at !== null) throw new AppError('CONFLICT', 'item is in the trash');
  return node;
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

/** Who the item is shared with. */
export async function listPeople(ctx: Ctx, userId: string, nodeId: string): Promise<PersonDto[]> {
  await requireSharable(ctx, userId, nodeId);
  const { results } = await db(ctx)
    .prepare('SELECT * FROM node_grants WHERE node_id = ?1 ORDER BY created_at LIMIT 200')
    .bind(nodeId)
    .all<GrantRow>();
  const who = await names(
    ctx,
    results.flatMap((g) => (g.user_id ? [g.user_id] : [])),
  );
  return results.map((g) => ({
    id: g.id,
    userId: g.user_id,
    email: g.user_id ? (who.get(g.user_id)?.email ?? null) : g.email,
    name: g.user_id ? (who.get(g.user_id)?.name ?? null) : null,
    role: g.role,
    pending: g.user_id === null,
    expiresAt: g.expires_at,
    createdAt: g.created_at,
  }));
}

export interface AddPeopleInput {
  emails: string[];
  role: GrantRole;
  expiresAt?: number | null | undefined;
}

/** Shares the item with these addresses; the people are told by email and the bell. */
export async function addPeople(
  ctx: Ctx,
  userId: string,
  nodeId: string,
  input: AddPeopleInput,
): Promise<PersonDto[]> {
  const node = await requireSharable(ctx, userId, nodeId);
  const A = db(ctx);
  const role = parseRole(input.role);
  const emails = [...new Set(input.emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (!emails.length || emails.length > 20)
    throw new AppError('VALIDATION', 'between 1 and 20 addresses');
  for (const e of emails)
    if (!EMAIL.test(e) || e.length > 254) throw new AppError('VALIDATION', 'invalid email');
  const now = ctx.now();
  const expiresAt = input.expiresAt ?? null;
  if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= now))
    throw new AppError('VALIDATION', 'expiry must be in the future');
  const count = await A.prepare('SELECT COUNT(*) AS n FROM node_grants WHERE node_id = ?1')
    .bind(nodeId)
    .first<{ n: number }>();
  if ((count?.n ?? 0) + emails.length > MAX_PEOPLE)
    throw new AppError('VALIDATION', `at most ${MAX_PEOPLE} people per item`);
  const cfg = await ctx.config();
  if (
    !(await consumeUsage(
      ctx,
      `person_share:${userId}:${new Date(now).toISOString().slice(0, 10)}`,
      emails.length,
      cfg.person_share_daily_limit,
      DAY_MS,
    ))
  )
    throw new AppError('RATE_LIMITED', 'daily sharing limit reached');

  const sharer = await ctx.env.DB.prepare('SELECT name, email, locale FROM users WHERE id = ?1')
    .bind(userId)
    .first<{ name: string; email: string; locale: Lang }>();
  for (const email of emails) {
    if (email === sharer?.email.toLowerCase())
      throw new AppError('VALIDATION', 'cannot share with yourself');
    const person = await ctx.env.DB.prepare(
      `SELECT id FROM users WHERE lower(email) = ?1 AND status != 'deleted'`,
    )
      .bind(email)
      .first<{ id: string }>();
    if (person?.id === node.owner_id) continue;
    const before = person
      ? await A.prepare('SELECT id FROM node_grants WHERE node_id = ?1 AND user_id = ?2')
          .bind(nodeId, person.id)
          .first<{ id: string }>()
      : await A.prepare(
          'SELECT id FROM node_grants WHERE node_id = ?1 AND user_id IS NULL AND email = ?2',
        )
          .bind(nodeId, email)
          .first<{ id: string }>();
    if (before) {
      await A.prepare('UPDATE node_grants SET role = ?2, expires_at = ?3 WHERE id = ?1')
        .bind(before.id, role, expiresAt)
        .run();
      continue;
    }
    await A.prepare(
      `INSERT INTO node_grants (id, node_id, owner_id, user_id, email, role, granted_by, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
      .bind(
        ulid(now),
        nodeId,
        node.owner_id,
        person?.id ?? null,
        person ? null : email,
        role,
        userId,
        now,
        expiresAt,
      )
      .run();
    const payload = {
      by: sharer?.name || sharer?.email || '',
      name: node.name,
      folder: node.kind === 'folder',
      role,
    };
    if (person) await notify(ctx, person.id, 'node_shared', payload);
    else await emailNewcomer(ctx, email, sharer, payload);
  }
  recordActivity(ctx, userId, { action: 'share', node });
  return listPeople(ctx, userId, nodeId);
}

/** Someone without Drive yet: one email in the sharer's language, to sign in with that address. */
async function emailNewcomer(
  ctx: Ctx,
  to: string,
  sharer: { name: string; email: string; locale: Lang } | null,
  p: { by: string; name: string; folder: boolean; role: GrantRole },
): Promise<void> {
  const lang = sharer?.locale ?? 'id';
  const m = strings(lang).mail;
  await ctx.adapters.email.send({
    to: [to],
    tag: 'node_shared',
    ...(sharer?.email ? { replyTo: sharer.email } : {}),
    ...noticeEmail(lang, {
      title: m.sharedTitle(p.by, p.name),
      paragraphs: [m.sharedBody(p.folder, p.role === 'edit'), m.sharedSignIn(to)],
      cta: { label: m.ctaShared, url: appUrl(ctx.env, '/untuk-saya') },
    }),
  });
}

async function grantOf(ctx: Ctx, nodeId: string, grantId: string): Promise<GrantRow | null> {
  return db(ctx)
    .prepare('SELECT * FROM node_grants WHERE id = ?1 AND node_id = ?2')
    .bind(grantId, nodeId)
    .first<GrantRow>();
}

export async function setPersonRole(
  ctx: Ctx,
  userId: string,
  nodeId: string,
  grantId: string,
  role: unknown,
): Promise<PersonDto[]> {
  await requireSharable(ctx, userId, nodeId);
  const r = parseRole(role);
  if (!(await grantOf(ctx, nodeId, grantId))) throw new AppError('NOT_FOUND', 'not found');
  await db(ctx).prepare('UPDATE node_grants SET role = ?2 WHERE id = ?1').bind(grantId, r).run();
  return listPeople(ctx, userId, nodeId);
}

/** The sharer's side takes the grant back; the person it was shared with may also leave it. */
export async function removePerson(
  ctx: Ctx,
  userId: string,
  nodeId: string,
  grantId: string,
): Promise<void> {
  const g = await grantOf(ctx, nodeId, grantId);
  if (!g) throw new AppError('NOT_FOUND', 'not found');
  if (g.user_id !== userId) await requireSharable(ctx, userId, nodeId);
  await db(ctx).prepare('DELETE FROM node_grants WHERE id = ?1').bind(grantId).run();
  const node = await ctx.env.DB.prepare('SELECT * FROM nodes WHERE id = ?1')
    .bind(nodeId)
    .first<NodeRecord>();
  if (node && g.user_id !== userId) recordActivity(ctx, userId, { action: 'unshare', node });
}

/** Items others shared with the person, the newest first (claiming those sent to their email). */
export async function sharedWithMe(ctx: Ctx, userId: string): Promise<SharedWithMeItem[]> {
  if (!grantsDb(ctx.env)) return [];
  await claimGrants(ctx, userId);
  const grants = [...(await grantsOf(ctx, userId)).values()];
  if (!grants.length) return [];
  const rows = new Map<string, Parameters<typeof toDto>[0]>();
  for (const slice of idSlices(grants.map((g) => g.node_id))) {
    const { results } = await ctx.env.DB.prepare(
      `${SELECT_DTO} WHERE n.id IN (SELECT value FROM json_each(?2))
         AND n.trashed_at IS NULL AND n.kind != 'version'`,
    )
      .bind(userId, slice)
      .all<Parameters<typeof toDto>[0]>();
    for (const r of results) rows.set(r.id, r);
  }
  const who = await names(
    ctx,
    grants.map((g) => g.granted_by),
  );
  return grants
    .filter((g) => rows.has(g.node_id))
    .map((g) => ({
      grantId: g.id,
      role: g.role,
      sharedBy: { id: g.granted_by, name: who.get(g.granted_by)?.name ?? null },
      sharedAt: g.created_at,
      expiresAt: g.expires_at,
      node: toDto(rows.get(g.node_id)!),
    }))
    .sort((a, b) => b.sharedAt - a.sharedAt);
}

/** Everything inside what was shared with the person, as D1 rows (search and Terbaru). */
export const SHARED_SUBTREE = `WITH RECURSIVE g(id, depth) AS (
    SELECT value, 0 FROM json_each(?2)
    UNION ALL SELECT n.id, g.depth + 1 FROM nodes n JOIN g ON n.parent_id = g.id
    WHERE g.depth < 64 AND n.kind != 'version')`;

/** The ids of the items shared with the person, as `?2` of SHARED_SUBTREE; null when none. */
export async function sharedRoots(ctx: Ctx, userId: string): Promise<string | null> {
  if (!grantsDb(ctx.env)) return null;
  const grants = await grantsOf(ctx, userId);
  return grants.size ? JSON.stringify([...grants.keys()]) : null;
}

/** Name search inside what others shared with the person. */
export async function searchShared(ctx: Ctx, userId: string, o: SearchOptions): Promise<NodeDto[]> {
  const query = queryWords(o.q);
  const roots = query.length ? await sharedRoots(ctx, userId) : null;
  if (!roots) return [];
  const { results } = await ctx.env.DB.prepare(
    `${SHARED_SUBTREE} ${SELECT_DTO}
     WHERE n.id IN (SELECT id FROM g) AND n.trashed_at IS NULL AND n.status != 'uploading'
     LIMIT 5000`,
  )
    .bind(userId, roots)
    .all<Parameters<typeof toDto>[0]>();
  return results
    .map(toDto)
    .filter((n) => matchesQuery(n.name, query))
    .filter((n) => !o.type || matchesType(n, o.type))
    .filter((n) => !o.modifiedAfter || n.updatedAt >= o.modifiedAfter)
    .sort(searchOrder)
    .slice(0, Math.min(o.limit ?? 50, 100));
}

/** When items go for good, their grants go with them. */
export async function forgetGrants(ctx: Ctx, nodeIds: readonly string[]): Promise<void> {
  const A = grantsDb(ctx.env);
  if (!A) return;
  for (const ids of idSlices(nodeIds))
    await A.prepare('DELETE FROM node_grants WHERE node_id IN (SELECT value FROM json_each(?1))')
      .bind(ids)
      .run();
}

/** A deleted account: what it shared and what was shared with it. */
export async function deleteGrantsOfUser(ctx: Ctx, userId: string): Promise<void> {
  const A = grantsDb(ctx.env);
  if (!A) return;
  await A.prepare('DELETE FROM node_grants WHERE owner_id = ?1 OR user_id = ?1 OR granted_by = ?1')
    .bind(userId)
    .run();
}

/** Data export: what the person shared with others and what others shared with them. */
export async function exportGrants(ctx: Ctx, userId: string) {
  const A = grantsDb(ctx.env);
  if (!A) return { given: [], received: [] };
  const [given, received] = await Promise.all([
    A.prepare(
      `SELECT node_id, user_id, email, role, created_at, expires_at FROM node_grants
       WHERE granted_by = ?1 ORDER BY created_at LIMIT 10000`,
    )
      .bind(userId)
      .all(),
    A.prepare(
      `SELECT node_id, granted_by, role, created_at, expires_at FROM node_grants
       WHERE user_id = ?1 ORDER BY created_at LIMIT 10000`,
    )
      .bind(userId)
      .all(),
  ]);
  return { given: given.results, received: received.results };
}
