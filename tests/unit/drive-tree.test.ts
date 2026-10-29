// R2 (ADR-077): the explorer's views of a personal Drive, read from its index.
import { describe, expect, it } from 'vitest';
import {
  newIndexHead,
  serializeIndex,
  parseIndex,
  type IndexEntry,
} from '../../src/shared/drive-index';
import { DriveTree, matchesType, type DriveNode } from '../../src/shared/drive-tree';

const S = 1000;
const ROOT = '01ROOT0000000000000000ROOT';

function entry(over: Partial<IndexEntry> & Pick<IndexEntry, 'id' | 'name'>): IndexEntry {
  return {
    parent: 0,
    kind: 'file',
    size: 0,
    mime: '',
    blob: 0,
    legacy: `N${String(over.id).padStart(25, '0')}`,
    status: 'ready',
    created: 100 * S,
    updated: 100 * S,
    clientModified: null,
    thumb: false,
    starred: false,
    trashedAt: null,
    trashRoot: 0,
    decor: null,
    owner: 0,
    canEdit: false,
    trashedBy: 0,
    ...over,
  };
}

/** Round-trips through the stored text, as the Worker and the app read it. */
function tree(entries: IndexEntry[]): DriveTree {
  const head = { ...newIndexHead(), next: 100, root: ROOT, rootAt: 50 };
  const idx = parseIndex(serializeIndex(head, entries));
  return new DriveTree(idx.head, idx.entries, {
    ownerId: 'u1',
    trashDays: 30,
    rootName: 'Drive Saya',
  });
}

const id = (n: number) => `N${String(n).padStart(25, '0')}`;
const names = (nodes: DriveNode[]) => nodes.map((n) => n.name);

const SAMPLE = [
  entry({ id: 1, kind: 'folder', name: 'Foto', updated: 300 * S }),
  entry({ id: 2, kind: 'folder', name: 'arsip', updated: 200 * S }),
  entry({ id: 3, name: 'b.txt', size: 30, mime: 'text/plain', updated: 500 * S }),
  entry({ id: 4, name: 'A.pdf', size: 10, mime: 'application/pdf', updated: 400 * S }),
  entry({
    id: 5,
    name: 'Café liburan.jpg',
    parent: 1,
    mime: 'image/jpeg',
    thumb: true,
    starred: true,
  }),
  entry({ id: 6, name: 'lama.zip', mime: 'application/zip', trashedAt: 600 * S, trashRoot: 6 }),
  entry({ id: 7, kind: 'folder', name: 'Bekas', trashedAt: 700 * S, trashRoot: 7 }),
  entry({ id: 8, name: 'di dalam bekas.txt', parent: 7, trashedAt: 700 * S, trashRoot: 7 }),
  entry({ id: 9, name: 'virus.exe', parent: 1, status: 'blocked' }),
  entry({
    id: 10,
    name: 'masih dipindai.doc',
    parent: 1,
    status: 'scanning',
    mime: 'application/msword',
  }),
];

describe('DriveTree (R2, ADR-077)', () => {
  it('lists a folder folders first, sorted like D1, without the Trash', () => {
    const t = tree(SAMPLE);
    expect(names(t.children(ROOT))).toEqual(['arsip', 'Foto', 'A.pdf', 'b.txt']);
    expect(names(t.children(ROOT, 'name', 'desc'))).toEqual(['Foto', 'arsip', 'b.txt', 'A.pdf']);
    expect(names(t.children(ROOT, 'updated', 'desc'))).toEqual(['Foto', 'arsip', 'b.txt', 'A.pdf']);
    // Equal keys fall back to the id, as D1's keyset paging did.
    expect(names(t.children(ROOT, 'size'))).toEqual(['Foto', 'arsip', 'A.pdf', 'b.txt']);
    expect(names(t.children(ROOT, 'type'))).toEqual(['Foto', 'arsip', 'A.pdf', 'b.txt']);
    expect(names(t.children(id(7)))).toEqual([]);
    expect(t.children('nope')).toEqual([]);
  });

  it('pages with cursors that walk the whole folder once', () => {
    const many = Array.from({ length: 23 }, (_, i) =>
      entry({ id: i + 1, name: `f${String(i).padStart(2, '0')}.txt`, size: i % 5 }),
    );
    const t = tree(many);
    for (const sort of ['name', 'size', 'updated', 'type'] as const)
      for (const dir of ['asc', 'desc'] as const) {
        const seen: string[] = [];
        let cursor: string | null = null;
        do {
          const p = t.page(ROOT, { sort, dir, cursor, limit: 5 });
          seen.push(...p.items.map((n) => n.id));
          cursor = p.nextCursor;
        } while (cursor);
        expect(seen).toEqual(t.children(ROOT, sort, dir).map((n) => n.id));
      }
    expect(() => t.page(ROOT, { cursor: 'not-a-cursor' })).toThrow('invalid cursor');
  });

  it('answers for a node, its path, and the root', () => {
    const t = tree(SAMPLE);
    expect(t.has(ROOT) && t.has(id(5)) && !t.has('nope')).toBe(true);
    expect(t.node(ROOT)).toMatchObject({
      id: ROOT,
      parentId: null,
      kind: 'folder',
      name: 'Drive Saya',
      createdAt: 50 * S,
    });
    expect(t.node(id(5))).toMatchObject({
      parentId: id(1),
      space: 'personal',
      ownerId: 'u1',
      starred: true,
      hasThumb: true,
      status: 'ready',
      scanStatus: 'clean',
    });
    expect(t.node(id(9))).toMatchObject({ status: 'rejected', scanStatus: 'infected' });
    expect(t.node(id(10))).toMatchObject({ status: 'scanning', scanStatus: 'pending' });
    expect(t.node(id(1))).toMatchObject({ parentId: ROOT, scanStatus: null, mime: null });
    expect(t.node(id(8))).toMatchObject({ trashedAt: 700 * S, purgeAt: 700 * S + 30 * 86_400_000 });
    expect(t.path(id(5)).map((c) => c.name)).toEqual(['Drive Saya', 'Foto', 'Café liburan.jpg']);
    expect(t.path(ROOT).map((c) => c.id)).toEqual([ROOT]);
    expect(t.path('nope')).toEqual([]);
  });

  it('shows a cover only when it is a ready file outside the Trash with a thumbnail', () => {
    const base = [
      entry({ id: 1, name: 'pic.jpg', thumb: true }),
      entry({ id: 2, name: 'nothumb.jpg' }),
      entry({ id: 3, name: 'gone.jpg', thumb: true, trashedAt: 9 * S, trashRoot: 3 }),
      entry({ id: 4, name: 'bad.jpg', thumb: true, status: 'blocked' }),
    ];
    const folder = (cover: number) =>
      tree([
        ...base,
        entry({ id: 9, kind: 'folder', name: 'D', decor: { color: 'red', icon: 'star', cover } }),
      ]).node(id(9))!.decor;
    expect(folder(1)).toEqual({ color: 'red', icon: 'star', coverId: id(1) });
    for (const n of [2, 3, 4, 77])
      expect(folder(n)).toEqual({ color: 'red', icon: 'star', coverId: null });
    const odd = tree([
      entry({ id: 9, kind: 'folder', name: 'D', decor: { color: 'nope', icon: '', cover: 0 } }),
    ]);
    expect(odd.node(id(9))!.decor).toBeNull();
    expect(
      tree([
        entry({ id: 9, kind: 'folder', name: 'D', decor: { color: 'teal', icon: null, cover: 0 } }),
      ]).path(id(9))[1],
    ).toEqual({
      id: id(9),
      name: 'D',
      color: 'teal',
      icon: null,
    });
  });

  it('searches names the way FTS5 did: every word a prefix, accents ignored, no Trash', () => {
    const t = tree(SAMPLE);
    expect(names(t.search({ q: 'cafe lib' }))).toEqual(['Café liburan.jpg']);
    expect(names(t.search({ q: 'CAF' }))).toEqual(['Café liburan.jpg']);
    expect(names(t.search({ q: 'liburan cafx' }))).toEqual([]);
    expect(names(t.search({ q: 'bekas' }))).toEqual([]);
    expect(names(t.search({ q: '   ' }))).toEqual([]);
    expect(names(t.search({ q: 'a' }))).toEqual(['arsip', 'A.pdf']);
    expect(names(t.search({ q: 'a', type: 'pdf' }))).toEqual(['A.pdf']);
    expect(names(t.search({ q: 'a', type: 'folder' }))).toEqual(['arsip']);
    expect(names(t.search({ q: 'b', modifiedAfter: 450 * S }))).toEqual(['b.txt']);
  });

  it('lists starred and the Trash (only what was put there, not what came with it)', () => {
    const t = tree(SAMPLE);
    expect(names(t.starred())).toEqual(['Café liburan.jpg']);
    expect(names(t.trash())).toEqual(['Bekas', 'lama.zip']);
  });

  it("matches the app's type filters", () => {
    const f = (mime: string, kind: 'file' | 'folder' = 'file') => ({ kind, mime });
    expect(matchesType(f('', 'folder'), 'folder')).toBe(true);
    expect(matchesType(f('image/png'), 'image')).toBe(true);
    expect(matchesType(f('application/vnd.ms-excel'), 'document')).toBe(true);
    expect(matchesType(f('application/x-7z-compressed'), 'archive')).toBe(true);
    expect(matchesType(f('application/gzip'), 'archive')).toBe(true);
    expect(matchesType(f('video/mp4'), 'audio')).toBe(false);
  });
});
