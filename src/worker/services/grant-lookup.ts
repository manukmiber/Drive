// D2 (ADR-085): what a file or folder shared with a person lets them do. A grant on a folder covers
// everything inside it, so a node's grant is the best one on the node or a folder above it. The
// grants live in the access database, the tree in the main D1: the ancestors come from one, the
// grants from the other, never joined. Memoised per request, since one request asks about the same
// person and the same few nodes.
import type { Ctx } from '../context';

export type GrantRole = 'view' | 'edit';

export interface GrantRow {
  id: string;
  node_id: string;
  owner_id: string;
  user_id: string | null;
  email: string | null;
  role: GrantRole;
  granted_by: string;
  created_at: number;
  expires_at: number | null;
}

/** The node a person reached through a grant: which grant, and the folder it was given on. */
export interface Granted {
  role: GrantRole;
  rootId: string;
  ownerId: string;
}

/** Grants exist only with the access database; without it (not made yet) nobody has any. */
export function grantsDb(env: { ACCESS_DB?: D1Database }): D1Database | null {
  return env.ACCESS_DB ?? null;
}

interface Memo {
  grants: Map<string, Promise<Map<string, GrantRow>>>;
  ancestors: Map<string, Promise<string[]>>;
  /** Owners whose trees a grantee touched in this request: their indexes are written too. */
  touched: Set<string>;
}
const memo = new WeakMap<Ctx, Memo>();
function memoOf(ctx: Ctx): Memo {
  let m = memo.get(ctx);
  if (!m) memo.set(ctx, (m = { grants: new Map(), ancestors: new Map(), touched: new Set() }));
  return m;
}

/**
 * Grants waiting on the person's email become theirs (shared before they first came to Drive). Done
 * when they open "Shared with me", where the email sends them, not on every access check.
 */
export async function claimGrants(ctx: Ctx, userId: string): Promise<void> {
  const A = grantsDb(ctx.env);
  if (!A) return;
  const u = await ctx.env.DB.prepare('SELECT email FROM users WHERE id = ?1')
    .bind(userId)
    .first<{ email: string }>();
  if (!u?.email) return;
  await A.prepare(
    `UPDATE OR IGNORE node_grants SET user_id = ?1, email = NULL WHERE user_id IS NULL AND email = ?2`,
  )
    .bind(userId, u.email.toLowerCase())
    .run();
  // A second grant of the same node to the same person (by id and by email) is the one left over.
  await A.prepare(`DELETE FROM node_grants WHERE user_id IS NULL AND email = ?1`)
    .bind(u.email.toLowerCase())
    .run();
}

/** The person's live grants by node id. */
export function grantsOf(ctx: Ctx, userId: string): Promise<Map<string, GrantRow>> {
  const m = memoOf(ctx);
  let p = m.grants.get(userId);
  if (!p) {
    p = (async () => {
      const A = grantsDb(ctx.env);
      if (!A) return new Map<string, GrantRow>();
      const { results } = await A.prepare(
        `SELECT * FROM node_grants WHERE user_id = ?1 AND (expires_at IS NULL OR expires_at > ?2)`,
      )
        .bind(userId, ctx.now())
        .all<GrantRow>();
      return new Map(results.map((g) => [g.node_id, g]));
    })();
    m.grants.set(userId, p);
  }
  return p;
}

/** The node and the folders above it, nearest first. */
function ancestors(ctx: Ctx, nodeId: string): Promise<string[]> {
  const m = memoOf(ctx);
  let p = m.ancestors.get(nodeId);
  if (!p) {
    p = ctx.env.DB.prepare(
      `WITH RECURSIVE up(id, parent_id, depth) AS (
         SELECT id, parent_id, 0 FROM nodes WHERE id = ?1
         UNION ALL SELECT n.id, n.parent_id, up.depth + 1 FROM nodes n JOIN up ON n.id = up.parent_id
         WHERE up.depth < 200)
       SELECT id FROM up ORDER BY depth`,
    )
      .bind(nodeId)
      .all<{ id: string }>()
      .then((r) => r.results.map((x) => x.id));
    m.ancestors.set(nodeId, p);
  }
  return p;
}

/** The best grant the person has on the node or a folder above it; edit beats view. */
export async function grantFor(
  ctx: Ctx,
  userId: string,
  node: { id: string; parent_id: string | null },
): Promise<Granted | null> {
  const grants = await grantsOf(ctx, userId);
  if (!grants.size) return null;
  let best: GrantRow | null = null;
  const chain = node.parent_id === null ? [node.id] : await ancestors(ctx, node.id);
  for (const id of chain) {
    const g = grants.get(id);
    if (g && (!best || (best.role === 'view' && g.role === 'edit'))) best = g;
  }
  if (!best) return null;
  memoOf(ctx).touched.add(best.owner_id);
  return { role: best.role, rootId: best.node_id, ownerId: best.owner_id };
}

/** Owners of trees reached through grants in this request (their indexes need writing too). */
export function grantedOwners(ctx: Ctx): string[] {
  return [...(memo.get(ctx)?.touched ?? [])];
}
