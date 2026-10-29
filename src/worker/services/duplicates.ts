// D11 (ADR-081): files with the same content, to win quota back. Only the trees the person can
// see are looked at (their own, and their family's), so a group never hints that someone else
// keeps the same file (no dedup across pools or people, CLAUDE.md). Entries that share one content
// object ("Make a copy") cost it once and are not a waste.
//
// The tree comes from the index; the content hash stays with the content (`blobs.sha256`, set by
// the scanner) and is looked up only for files whose size another file shares.
import type { DriveCrumb } from '../../shared/drive-tree';
import type { Ctx } from '../context';
import { idSlices } from '../lib/access-db';
import { driveTree, familyAccess } from './drive-read';
import type { NodeDto } from './nodes';

export interface DuplicateFile extends NodeDto {
  /** The folders above it, from the root. */
  path: DriveCrumb[];
  /** Whether this person may put it in the Trash (SPEC §9.2). */
  canRemove: boolean;
}

export interface DuplicateGroup {
  size: number;
  /** Bytes back once all but one copy are gone from the Trash too. */
  saving: number;
  items: DuplicateFile[];
}

const MAX_GROUPS = 500;

export async function findDuplicates(
  ctx: Ctx,
  userId: string,
): Promise<{ groups: DuplicateGroup[]; saving: number }> {
  const trees = (
    await Promise.all([driveTree(ctx, userId, 'personal'), driveTree(ctx, userId, 'family')])
  ).filter((t) => t !== null);
  const files = trees.flatMap((t) =>
    t.tree.contents().map(({ node, blob }) => ({
      blob,
      file: {
        ...node,
        path: t.tree.path(node.id).slice(0, -1),
        canRemove: t.tree.space === 'personal' || familyAccess(node, userId, t.role).remove,
      },
    })),
  );

  // Only a size two content objects share can hold a duplicate.
  const objectsOfSize = new Map<number, Set<string>>();
  for (const f of files) {
    if (typeof f.blob !== 'string') continue;
    const set = objectsOfSize.get(f.file.size) ?? new Set<string>();
    objectsOfSize.set(f.file.size, set.add(f.blob));
  }
  const keys = [...objectsOfSize.values()].filter((s) => s.size > 1).flatMap((s) => [...s]);
  if (!keys.length) return { groups: [], saving: 0 };

  const hashOf = new Map<string, string>();
  for (const slice of idSlices(keys)) {
    const { results } = await ctx.env.DB.prepare(
      `SELECT r2_key, sha256 FROM blobs
       WHERE r2_key IN (SELECT value FROM json_each(?1)) AND sha256 IS NOT NULL
         AND pool_id IN (
           SELECT id FROM storage_pools WHERE owner_type = 'user' AND owner_id = ?2
           UNION SELECT f.pool_id FROM families f JOIN family_members m ON m.family_id = f.id
                 WHERE m.user_id = ?2)`,
    )
      .bind(slice, userId)
      .all<{ r2_key: string; sha256: string }>();
    for (const r of results) hashOf.set(r.r2_key, r.sha256);
  }

  const byHash = new Map<string, { objects: Set<string>; items: DuplicateFile[] }>();
  for (const f of files) {
    const hash = typeof f.blob === 'string' ? hashOf.get(f.blob) : undefined;
    if (!hash) continue;
    const g = byHash.get(hash) ?? { objects: new Set<string>(), items: [] };
    g.objects.add(f.blob as string);
    g.items.push(f.file);
    byHash.set(hash, g);
  }
  const groups = [...byHash.values()]
    .filter((g) => g.objects.size > 1)
    .map((g) => ({
      size: g.items[0]!.size,
      saving: (g.objects.size - 1) * g.items[0]!.size,
      // The oldest first: the copy most people keep.
      items: g.items.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)),
    }))
    .sort((a, b) => b.saving - a.saving || a.items[0]!.name.localeCompare(b.items[0]!.name));
  return {
    groups: groups.slice(0, MAX_GROUPS),
    saving: groups.reduce((s, g) => s + g.saving, 0),
  };
}
