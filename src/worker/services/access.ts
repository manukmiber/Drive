// Node access rules (SPEC §9.2, §14.1). Every node read/write goes through here; callers turn
// "no view access" into 404 so IDs of other users' files never leak (IDOR tests, SPEC §8.6).
import type { Ctx } from '../context';
import { AppError } from '../lib/errors';

export interface NodeRecord {
  rid: number;
  id: string;
  pool_id: string;
  space: 'personal' | 'family';
  family_id: string | null;
  owner_id: string;
  created_by: string;
  parent_id: string | null;
  kind: 'file' | 'folder';
  name: string;
  name_key: string;
  blob_id: string | null;
  size: number;
  mime: string | null;
  family_can_edit: number;
  status: 'uploading' | 'scanning' | 'ready' | 'rejected';
  trashed_at: number | null;
  trashed_by: string | null;
  trash_root_id: string | null;
  purge_at: number | null;
  client_modified_at: number | null;
  created_at: number;
  updated_at: number;
  version: number;
}

export interface Access {
  view: boolean;
  /** Rename, move, replace content. */
  edit: boolean;
  /** Trash / delete. */
  remove: boolean;
  isOwner: boolean;
}

const NONE: Access = { view: false, edit: false, remove: false, isOwner: false };

/** Cached per request: family membership of the acting user. */
async function familyRole(
  ctx: Ctx,
  userId: string,
  familyId: string,
): Promise<'owner' | 'member' | null> {
  const row = await ctx.env.DB.prepare(
    'SELECT role FROM family_members WHERE family_id = ?1 AND user_id = ?2',
  )
    .bind(familyId, userId)
    .first<{ role: 'owner' | 'member' }>();
  return row?.role ?? null;
}

export async function nodeAccess(ctx: Ctx, userId: string, node: NodeRecord): Promise<Access> {
  // In-flight uploads are private to the uploader.
  if (node.status === 'uploading' && node.created_by !== userId) return NONE;

  if (node.space === 'personal') {
    if (node.owner_id !== userId) return NONE;
    return { view: true, edit: true, remove: true, isOwner: true };
  }
  if (!node.family_id) return NONE;
  const role = await familyRole(ctx, userId, node.family_id);
  if (!role) return NONE;
  const privileged = role === 'owner' || node.created_by === userId;
  return {
    view: true,
    edit: privileged || node.family_can_edit === 1,
    remove: privileged,
    isOwner: node.owner_id === userId,
  };
}

export async function loadNode(ctx: Ctx, id: string): Promise<NodeRecord | null> {
  return ctx.env.DB.prepare('SELECT * FROM nodes WHERE id = ?1').bind(id).first<NodeRecord>();
}

/** Loads a node the user may see, else NOT_FOUND. */
export async function requireNode(
  ctx: Ctx,
  userId: string,
  id: string,
  need: keyof Omit<Access, 'isOwner'> = 'view',
): Promise<{ node: NodeRecord; access: Access }> {
  const node = await loadNode(ctx, id);
  if (!node) throw new AppError('NOT_FOUND', 'node not found');
  const access = await nodeAccess(ctx, userId, node);
  if (!access.view) throw new AppError('NOT_FOUND', 'node not found');
  if (await poolLocked(ctx, node.pool_id))
    throw new AppError('ACCOUNT_SUSPENDED', 'file access is locked until payment');
  if (!access[need]) throw new AppError('FORBIDDEN', 'not allowed');
  return { node, access };
}

const lockCache = new WeakMap<Ctx, Map<string, Promise<boolean>>>();

/** Suspended pools (H+30 unpaid) lock all file access (SPEC §12.5). Memoised per request. */
export function poolLocked(ctx: Ctx, poolId: string): Promise<boolean> {
  let m = lockCache.get(ctx);
  if (!m) lockCache.set(ctx, (m = new Map()));
  let p = m.get(poolId);
  if (!p) {
    p = ctx.env.DB.prepare(
      'SELECT status FROM subscriptions WHERE pool_id = ?1 ORDER BY created_at DESC LIMIT 1',
    )
      .bind(poolId)
      .first<{ status: string }>()
      .then((r) => r?.status === 'suspended');
    m.set(poolId, p);
  }
  return p;
}
