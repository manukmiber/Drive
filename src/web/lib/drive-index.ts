// R2 (ADR-077): the app pulls the person's own index first (`GET /api/drive/index`) and lists their
// folders from it, with the same code the Worker uses (shared/drive-tree.ts). Asking again sends the
// ETag, so an unchanged Drive costs a 304. Family folders and anything the index can't answer go to
// the API as before.
import { parseIndex } from '../../shared/drive-index';
import { DriveTree } from '../../shared/drive-tree';
import { t } from './i18n';

let held: { etag: string | null; owner: string; tree: DriveTree } | null = null;
let pending: Promise<DriveTree | null> | null = null;

async function load(): Promise<DriveTree | null> {
  const headers = new Headers();
  if (held?.etag) headers.set('if-none-match', held.etag);
  let res: Response;
  try {
    res = await fetch('/api/drive/index', { credentials: 'same-origin', headers });
  } catch {
    return null;
  }
  const owner = res.headers.get('x-drive-owner') ?? '';
  if (res.status === 304 && held && held.owner === owner) return held.tree;
  if (!res.ok) {
    held = null;
    return null;
  }
  try {
    const { head, entries } = parseIndex(await res.text());
    const tree = new DriveTree(head, entries, {
      ownerId: owner,
      trashDays: Number(res.headers.get('x-drive-trash-days')) || 30,
      rootName: t.nav.myDrive,
    });
    held = { etag: res.headers.get('etag'), owner, tree };
    return tree;
  } catch {
    held = null;
    return null;
  }
}

/** The person's own tree as it stands now, or null when the index can't be read (the API answers). */
export function personalTree(): Promise<DriveTree | null> {
  pending ??= load().finally(() => {
    pending = null;
  });
  return pending;
}
