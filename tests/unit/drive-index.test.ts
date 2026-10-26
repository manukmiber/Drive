import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ShimR2Bucket } from '../../dev/shims/r2';
import {
  entryLine,
  INDEX_COLUMNS,
  IndexFormatError,
  parseIndex,
  serializeIndex,
  newIndexHead,
  type IndexEntry,
} from '../../src/shared/drive-index';
import { AppError } from '../../src/worker/lib/errors';
import { changeIndex, indexKey, IndexDoc, readIndex } from '../../src/worker/services/drive-index';

const T = Date.parse('2026-10-26T03:00:00Z');

function file(id: number, parent: number, name: string, extra: Partial<IndexEntry> = {}) {
  return {
    id,
    parent,
    kind: 'file',
    name,
    size: 1234,
    mime: 'image/jpeg',
    blob: id,
    status: 'ready',
    created: T,
    updated: T,
    clientModified: null,
    thumb: false,
    starred: false,
    trashedAt: null,
    trashRoot: 0,
    decor: null,
    owner: 0,
    canEdit: false,
    trashedBy: 0,
    ...extra,
  } satisfies IndexEntry;
}
const folder = (id: number, parent: number, name: string, extra: Partial<IndexEntry> = {}) =>
  file(id, parent, name, { kind: 'folder', size: 0, mime: '', blob: 0, ...extra });

/** A doc holding `entries`, written and read back like the Worker would. */
function docWith(entries: IndexEntry[]): IndexDoc {
  const doc = IndexDoc.empty();
  for (const e of entries) {
    while (doc.head.next <= e.id) doc.allocate();
    doc.set(e);
  }
  return IndexDoc.parse(doc.toText());
}

describe('drive index format (ADR-064)', () => {
  it('writes one compact JSON row per entry and leaves trailing defaults off', () => {
    expect(entryLine(folder(3, 0, 'Foto'))).toBe(`[3,0,1,"Foto",0,"",0,0,${T / 1000}]`);
    expect(
      entryLine(file(9, 3, 'a.jpg', { updated: T + 5000, thumb: true, clientModified: T - 1000 })),
    ).toBe(`[9,3,0,"a.jpg",1234,"image/jpeg",9,0,${T / 1000},${T / 1000 + 5},${T / 1000 - 1},1]`);
    expect(
      entryLine(folder(4, 0, 'Kerja', { decor: { color: 'teal', icon: null, cover: 9 } })),
    ).toBe(`[4,0,1,"Kerja",0,"",0,0,${T / 1000},0,0,0,0,0,0,["teal","",9]]`);
  });

  it('round-trips every field, with times in whole seconds', () => {
    const e = file(7, 2, 'Laporan "Q3", final\n(revisi)\t✓ 🎉.pdf', {
      mime: 'application/pdf',
      blob: '01JAZ3LEGACYKEY',
      status: 'scanning',
      created: T + 999,
      updated: T + 60_500,
      clientModified: T - 86_400_000,
      thumb: true,
      starred: true,
      trashedAt: T + 120_000,
      trashRoot: 2,
      owner: 3,
      canEdit: true,
      trashedBy: 1,
    });
    const { head, entries } = parseIndex(serializeIndex(newIndexHead(), [e]));
    expect(head.cols).toEqual([...INDEX_COLUMNS]);
    expect(entries).toEqual([{ ...e, created: T, updated: T + 60_000 }]);
  });

  it('keeps one entry per line whatever the name holds', () => {
    const text = serializeIndex(newIndexHead(), [
      file(1, 0, 'baris\nbaru'),
      file(2, 0, 'tipuan \n[5,0,0,"x"]'),
      file(5, 0, 'asli.jpg'),
    ]);
    expect(text.split('\n')).toHaveLength(5);
    const doc = IndexDoc.parse(text);
    expect(doc.get(5)?.name).toBe('asli.jpg');
    expect(doc.get(2)?.name).toBe('tipuan \n[5,0,0,"x"]');
  });

  it('refuses what it cannot read safely', () => {
    const ok = serializeIndex(newIndexHead(), [file(1, 0, 'a.jpg')]);
    expect(() => parseIndex(ok.slice(0, -1))).toThrow(IndexFormatError);
    expect(() => parseIndex(ok.replace('"v":1', '"v":2'))).toThrow(/unsupported version 2/);
    expect(() => parseIndex(`${ok}[2,0,0,""]\n`)).toThrow(/bad name/);
    expect(() => parseIndex(`${ok}[0,0,0,"x"]\n`)).toThrow(/bad id/);
    expect(() => parseIndex(`${ok}{oops\n`)).toThrow(/not JSON/);
    expect(() => IndexDoc.parse('no header')).toThrow(IndexFormatError);
    expect(parseIndex(`${JSON.stringify(newIndexHead())}\n`).entries).toEqual([]);
  });

  it('reads rows by column name, and rewrites another layout into the current one', () => {
    const head = { ...newIndexHead(), next: 3, cols: ['id', 'n', 'p', 'k', 'c', 'x-new'] };
    const text = `${JSON.stringify(head)}\n[1,"Foto",0,1,${T / 1000},"?"]\n[2,"a.jpg",1,0,${T / 1000}]\n`;
    const { entries } = parseIndex(text);
    expect(entries.map((e) => [e.id, e.name, e.parent, e.kind])).toEqual([
      [1, 'Foto', 0, 'folder'],
      [2, 'a.jpg', 1, 'file'],
    ]);
    const doc = IndexDoc.parse(text);
    expect(doc.get(2)?.name).toBe('a.jpg');
    expect([...doc.parents()]).toEqual([
      [1, 0],
      [2, 1],
    ]);
    doc.set({ ...doc.get(2)!, name: 'b.jpg' });
    const again = parseIndex(doc.toText());
    expect(again.head.cols).toEqual([...INDEX_COLUMNS]);
    expect(again.entries.map((e) => e.name)).toEqual(['Foto', 'b.jpg']);
  });
});

describe('IndexDoc', () => {
  it('changes single lines and leaves an unchanged doc byte for byte', () => {
    const text = docWith([folder(1, 0, 'Foto'), file(2, 1, 'a.jpg'), file(3, 1, 'b.jpg')]).toText();
    const doc = IndexDoc.parse(text);
    expect(doc.changed).toBe(false);
    expect(doc.toText()).toBe(text);

    const b = doc.get(3)!;
    doc.set({ ...b, name: 'c.jpg', starred: true });
    doc.delete(2);
    const id = doc.allocate();
    doc.set(file(id, 0, 'd.jpg'));
    doc.delete(99);
    const out = doc.toText();
    const parsed = parseIndex(out);
    expect(parsed.head.rev).toBe(parseIndex(text).head.rev + 1);
    expect(parsed.head.next).toBe(5);
    expect(parsed.entries.map((e) => [e.id, e.name, e.starred])).toEqual([
      [1, 'Foto', false],
      [3, 'c.jpg', true],
      [4, 'd.jpg', false],
    ]);
    // The untouched line is carried over as it was.
    const line1 = text.split('\n')[1];
    expect(out.split('\n')).toContain(line1);
  });

  it('hands out copies, so only set() changes the doc', () => {
    const doc = docWith([folder(1, 0, 'Foto', { decor: { color: 'red', icon: null, cover: 0 } })]);
    const e = doc.get(1)!;
    e.name = 'Lain';
    e.decor!.color = 'blue';
    expect(doc.get(1)?.name).toBe('Foto');
    expect(doc.get(1)?.decor?.color).toBe('red');
    expect(doc.changed).toBe(false);
  });

  it('refuses entries that were never allocated', () => {
    const doc = IndexDoc.empty();
    expect(() => doc.set(file(1, 0, 'a.jpg'))).toThrow(/not allocated/);
    expect(() => doc.set({ ...file(doc.allocate(), 0, 'x'), name: '' })).toThrow(/needs a name/);
  });

  it('gives the same text whether few or many entries change', () => {
    const base: IndexEntry[] = [folder(1, 0, 'A')];
    for (let i = 2; i <= 60; i++) base.push(file(i, 1, `f${i}.jpg`));
    const text = docWith(base).toText();
    const few = IndexDoc.parse(text);
    const many = IndexDoc.parse(text);
    // Same edits; `many` also touches 20 entries without changing them, so it takes the walk path.
    for (const doc of [few, many]) {
      doc.set({ ...doc.get(30)!, parent: 0 });
      doc.delete(31);
      doc.set(file(doc.allocate(), 1, 'baru.jpg'));
    }
    for (let i = 40; i < 60; i++) many.set(many.get(i)!);
    expect(parseIndex(many.toText()).entries).toEqual(parseIndex(few.toText()).entries);
  });

  it('maps the tree shape without decoding rows', () => {
    const doc = docWith([folder(1, 0, 'A'), folder(2, 1, 'B'), file(3, 2, 'c.jpg')]);
    doc.set({ ...doc.get(3)!, parent: 1 });
    doc.delete(2);
    expect([...doc.parents()].sort()).toEqual([
      [1, 0],
      [3, 1],
    ]);
    expect(
      doc
        .entries()
        .map((e) => e.id)
        .sort(),
    ).toEqual([1, 3]);
  });
});

describe('index storage in R2', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });
  async function bucket(now: () => number = Date.now) {
    const dir = mkdtempSync(join(tmpdir(), 'zeiko-index-'));
    dirs.push(dir);
    const shim = await new ShimR2Bucket(dir, now).init();
    return { shim, r2: shim as unknown as R2Bucket };
  }
  const owner = { user: 'u1' };
  const noWait = { wait: () => Promise.resolve() };
  const addFile = (name: string) => (doc: IndexDoc) => {
    const id = doc.allocate();
    doc.set(file(id, 0, name));
    return id;
  };

  it('keys one index per user and per family', () => {
    expect(indexKey({ user: 'abc' })).toBe('u/abc/index.txt');
    expect(indexKey({ family: 'fam' })).toBe('f/fam/index.txt');
  });

  it('creates the index on the first change and leaves it alone when nothing changes', async () => {
    const { r2 } = await bucket();
    expect(await changeIndex(r2, owner, (doc) => doc.get(1))).toBeNull();
    expect(await r2.head('u/u1/index.txt')).toBeNull();
    expect(await changeIndex(r2, owner, addFile('a.jpg'))).toBe(1);
    const first = await r2.head('u/u1/index.txt');
    expect(first?.httpMetadata?.contentType).toBe('text/plain; charset=utf-8');
    await changeIndex(r2, owner, (doc) => doc.get(1));
    expect((await r2.head('u/u1/index.txt'))?.etag).toBe(first?.etag);
    const { doc, etag } = await readIndex(r2, owner);
    expect(etag).toBe(first?.etag);
    expect(doc.get(1)?.name).toBe('a.jpg');
  });

  it('loses no change when writers race', async () => {
    const { r2 } = await bucket();
    const ids = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        changeIndex(r2, owner, addFile(`f${i}.jpg`), { ...noWait, attempts: 50 }),
      ),
    );
    expect([...ids].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const { doc } = await readIndex(r2, owner);
    expect(doc.head.rev).toBe(10);
    expect(
      doc
        .entries()
        .map((e) => e.name)
        .sort(),
    ).toEqual(Array.from({ length: 10 }, (_, i) => `f${i}.jpg`).sort());
  });

  it('waits out R2’s one-write-per-second limit', async () => {
    let now = T;
    const { shim, r2 } = await bucket(() => now);
    shim.limitWritesPerKey = true;
    await changeIndex(r2, owner, addFile('a.jpg'));
    const waits: number[] = [];
    await changeIndex(r2, owner, addFile('b.jpg'), {
      wait: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    });
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(1000);
    expect((await readIndex(r2, owner)).doc.entries()).toHaveLength(2);
  });

  it('gives up with INDEX_BUSY after the last attempt', async () => {
    const { r2 } = await bucket();
    const always412 = { ...r2, get: r2.get.bind(r2), put: async () => null } as unknown as R2Bucket;
    let runs = 0;
    const err = await changeIndex(
      always412,
      owner,
      (doc) => {
        runs++;
        addFile('a.jpg')(doc);
      },
      { ...noWait, attempts: 3 },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('INDEX_BUSY');
    expect((err as AppError).status).toBe(503);
    expect(runs).toBe(3);
  });

  it('never overwrites an index it cannot read', async () => {
    const { r2 } = await bucket();
    await r2.put('u/u1/index.txt', '{"v":1,"rev":3,"next":2,"cols":["id"]}\n[1,0,0,"a.jpg"');
    const err = await changeIndex(r2, owner, addFile('b.jpg')).catch((e: unknown) => e);
    expect((err as AppError).code).toBe('INTERNAL');
    expect(await (await r2.get('u/u1/index.txt'))!.text()).toMatch(/"a\.jpg"$/);
  });

  it('matches R2 conditions on a missing key', async () => {
    const { r2 } = await bucket();
    expect(await r2.put('k', 'x', { onlyIf: { etagMatches: 'abc' } })).toBeNull();
    expect(
      await r2.put('k', 'x', { onlyIf: new Headers({ 'if-none-match': '*' }) }),
    ).not.toBeNull();
    expect(await r2.put('k', 'y', { onlyIf: new Headers({ 'if-none-match': '*' }) })).toBeNull();
  });
});
