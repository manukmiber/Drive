// R2 (ADR-077) and R4 (ADR-078): the app pulls the person's own index first
// (`GET /api/drive/index`), and their family's when a folder isn't in it (`?space=family`), and
// lists folders from them with the same code the Worker uses (shared/drive-tree.ts). Asking again
// sends the ETag, so an unchanged Drive costs a 304. Anything the indexes can't answer goes to the
// API as before.
import { parseIndex } from '../../shared/drive-index';
import { DriveTree } from '../../shared/drive-tree';
import { t } from './i18n';

type Space = 'personal' | 'family';

interface Held {
  etag: string | null;
  owner: string;
  tree: DriveTree;
}

const held = new Map<Space, Held>();
const pending = new Map<Space, Promise<DriveTree | null>>();

async function load(space: Space): Promise<DriveTree | null> {
  const before = held.get(space);
  const headers = new Headers();
  if (before?.etag) headers.set('if-none-match', before.etag);
  let res: Response;
  try {
    res = await fetch(`/api/drive/index${space === 'family' ? '?space=family' : ''}`, {
      credentials: 'same-origin',
      headers,
    });
  } catch {
    return null;
  }
  const owner = res.headers.get('x-drive-owner') ?? '';
  if (res.status === 304 && before && before.owner === owner) return before.tree;
  held.delete(space);
  if (!res.ok) return null;
  try {
    const { head, entries } = parseIndex(await res.text());
    const tree = new DriveTree(head, entries, {
      ownerId: owner,
      trashDays: Number(res.headers.get('x-drive-trash-days')) || 30,
      rootName: space === 'family' ? t.nav.familyDrive : t.nav.myDrive,
    });
    held.set(space, { etag: res.headers.get('etag'), owner, tree });
    return tree;
  } catch {
    return null;
  }
}

/** One of the person's trees as it stands now, or null when it can't be read (the API answers). */
export function driveTree(space: Space = 'personal'): Promise<DriveTree | null> {
  let p = pending.get(space);
  if (!p) {
    p = load(space).finally(() => pending.delete(space));
    pending.set(space, p);
  }
  return p;
}

/** The tree holding `id`: the person's own first, then their family's. */
export async function treeHolding(id: string): Promise<DriveTree | null> {
  const own = await driveTree('personal');
  if (own?.has(id)) return own;
  const family = await driveTree('family');
  return family?.has(id) ? family : null;
}
