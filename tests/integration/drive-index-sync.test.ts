// R3 (ADR-074): every change to a personal tree is written to the user's index in R2, as a
// projection of D1 that keeps entry numbers, merges bursts into one write, and recovers through the
// hourly cron.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createCtx } from '../../src/worker/context';
import { parseIndex, type IndexEntry } from '../../src/shared/drive-index';
import { flushUserIndex, markIndexDirty } from '../../src/worker/services/drive-index-sync';
import { makeRuntime } from '../helpers/runtime';
import { signIn, type Session } from '../helpers/session';
import { createFolder, grantPlan, rootOf, uploadText } from '../helpers/files';
import type { DevRuntime } from '../../dev/env';

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
const WEBP = (() => {
  const b = new Uint8Array(64);
  b.set(new TextEncoder().encode('RIFF'), 0);
  new DataView(b.buffer).setUint32(4, b.length - 8, true);
  b.set(new TextEncoder().encode('WEBPVP8X'), 8);
  return b;
})();

async function indexOf(rt: DevRuntime, userId: string) {
  const obj = await rt.r2.get(`u/${userId}/index.txt`);
  if (!obj || !('text' in obj)) return null;
  return parseIndex(await obj.text());
}

async function entries(rt: DevRuntime, userId: string): Promise<Map<string, IndexEntry>> {
  const idx = await indexOf(rt, userId);
  return new Map((idx?.entries ?? []).map((e) => [e.legacy, e]));
}

function dirty(rt: DevRuntime, userId: string): number | null {
  const row = rt.d1.sqlite
    .prepare('SELECT dirty_at FROM manifest_dirty WHERE user_id = ?')
    .get(userId) as { dirty_at: number } | undefined;
  return row?.dirty_at ?? null;
}

/** Counts writes to one user's index. */
function countIndexPuts(rt: DevRuntime, userId: string): { n: number } {
  const count = { n: 0 };
  const put = rt.r2.put.bind(rt.r2);
  rt.r2.put = ((
    key: string,
    ...rest: Parameters<typeof put> extends [unknown, ...infer R] ? R : never
  ) => {
    if (key === `u/${userId}/index.txt`) count.n++;
    return put(key, ...rest);
  }) as typeof rt.r2.put;
  return count;
}

async function user(rt: DevRuntime, email = 'indeks@example.com'): Promise<[Session, string]> {
  const s = await signIn(rt, email);
  await grantPlan(rt, s.userId);
  return [s, await rootOf(s)];
}

describe('Drive index written for every change (R3, ADR-074)', () => {
  it('holds the personal tree, keeps entry numbers, and follows every kind of change', async () => {
    const rt = await makeRuntime();
    const [s, root] = await user(rt);
    const docs = await createFolder(s, root, 'Dokumen');
    const sub = await createFolder(s, docs.id, 'Arsip');
    const file = await uploadText(s, docs.id, 'catatan.txt', 'halo dunia');
    await rt.settle();

    const idx = (await indexOf(rt, s.userId))!;
    expect(idx.head.root).toBe(root);
    expect(idx.head.used).toBe(10);
    let e = await entries(rt, s.userId);
    expect([...e.keys()].sort()).toEqual([docs.id, sub.id, file.id].sort());
    const [d, a, f] = [e.get(docs.id)!, e.get(sub.id)!, e.get(file.id)!];
    expect(d).toMatchObject({ parent: 0, kind: 'folder', name: 'Dokumen' });
    expect(a).toMatchObject({ parent: d.id, kind: 'folder' });
    expect(f).toMatchObject({
      parent: d.id,
      kind: 'file',
      size: 10,
      status: 'ready',
      starred: false,
    });
    expect(typeof f.blob).toBe('string');

    // Rename, move, star, thumbnail, decoration: same entry numbers.
    expect((await s.req('PATCH', `/api/nodes/${file.id}`, { name: 'baru.txt' })).status).toBe(200);
    expect(
      (await s.req('POST', '/api/nodes/move', { ids: [file.id], targetId: sub.id })).status,
    ).toBe(200);
    expect((await s.req('PUT', `/api/nodes/${file.id}/star`)).status).toBe(204);
    const t = await s.req('PUT', `/api/files/${file.id}/thumbnail`, undefined, {
      body: WEBP,
      headers: { 'content-type': 'image/webp', 'content-length': String(WEBP.length) },
    });
    expect(t.status).toBe(204);
    expect(
      (
        await s.req('POST', '/api/nodes/decor', {
          ids: [docs.id],
          color: 'teal',
          icon: 'graduation-cap',
        })
      ).status,
    ).toBe(200);
    await rt.settle();
    e = await entries(rt, s.userId);
    expect(e.get(file.id)).toMatchObject({
      id: f.id,
      parent: a.id,
      name: 'baru.txt',
      starred: true,
      thumb: true,
    });
    expect(e.get(docs.id)).toMatchObject({
      id: d.id,
      decor: { color: 'teal', icon: 'graduation-cap', cover: 0 },
    });

    // Trash takes the subtree along; restore brings it back; delete forever drops the entries.
    expect((await s.req('POST', '/api/nodes/trash', { ids: [docs.id] })).status).toBe(200);
    await rt.settle();
    e = await entries(rt, s.userId);
    expect(e.get(docs.id)!.trashedAt).not.toBeNull();
    expect(e.get(docs.id)!.trashRoot).toBe(d.id);
    expect(e.get(file.id)!.trashRoot).toBe(d.id);
    expect((await s.req('POST', '/api/nodes/restore', { ids: [docs.id] })).status).toBe(200);
    await rt.settle();
    expect((await entries(rt, s.userId)).get(file.id)!.trashedAt).toBeNull();
    expect((await s.req('POST', '/api/nodes/trash', { ids: [sub.id] })).status).toBe(200);
    expect((await s.req('POST', '/api/nodes/delete', { ids: [sub.id] })).status).toBe(200);
    await rt.settle();
    e = await entries(rt, s.userId);
    expect([...e.keys()]).toEqual([docs.id]);
    const copy = await s.req('POST', `/api/nodes/${docs.id}/copy`, {});
    // Folders can't be copied; the entry count stays.
    expect(copy.status).not.toBe(201);
    expect(dirty(rt, s.userId)).toBeNull();
  });

  it('shows a file as scanning, then ready, and a refused one as blocked', async () => {
    const rt = await makeRuntime();
    const [s, root] = await user(rt);
    const ok = await uploadText(s, root, 'ok.txt', 'aman');
    const bad = await uploadText(s, root, 'eicar.com', EICAR);
    await rt.idle();
    let e = await entries(rt, s.userId);
    expect(e.get(ok.id)!.status).toBe('scanning');
    expect(e.get(bad.id)!.status).toBe('scanning');
    await rt.settle();
    e = await entries(rt, s.userId);
    expect(e.get(ok.id)!.status).toBe('ready');
    expect(e.get(bad.id)!.status).toBe('blocked');
  });

  it('leaves other people and family items out, and keeps one index per user', async () => {
    const rt = await makeRuntime();
    const [a, rootA] = await user(rt, 'a@example.com');
    const [b, rootB] = await user(rt, 'b@example.com');
    const fa = await uploadText(a, rootA, 'a.txt', 'a');
    const fb = await uploadText(b, rootB, 'b.txt', 'b');
    await rt.settle();
    expect([...(await entries(rt, a.userId)).keys()]).toEqual([fa.id]);
    expect([...(await entries(rt, b.userId)).keys()]).toEqual([fb.id]);

    // A node relabelled as family (R4 has its own index) leaves the personal one.
    rt.d1.sqlite.prepare(`UPDATE nodes SET space = 'family' WHERE id = ?`).run(fa.id);
    const ctx = createCtx(rt.env);
    await markIndexDirty(ctx, [a.userId]);
    await rt.idle();
    await ctx.drain();
    expect((await entries(rt, a.userId)).size).toBe(0);
  });

  it('merges a burst of changes into few writes', async () => {
    const rt = await makeRuntime({ vars: { INDEX_FLUSH_DELAY_MS: '100' } });
    const [s, root] = await user(rt);
    await rt.settle();
    const puts = countIndexPuts(rt, s.userId);
    const made = await Promise.all(
      Array.from({ length: 12 }, (_, i) => createFolder(s, root, `Folder ${i}`)),
    );
    await rt.idle();
    expect((await entries(rt, s.userId)).size).toBe(12);
    expect(made.every((m) => m.id)).toBe(true);
    expect(puts.n).toBeGreaterThanOrEqual(1);
    expect(puts.n).toBeLessThanOrEqual(2);
  });

  it('only one flush holds the mark; a stale claim is taken over; a change during a flush marks again', async () => {
    const rt = await makeRuntime();
    const [s, root] = await user(rt);
    await rt.settle();
    const ctx = createCtx(rt.env);
    const now = Date.now();

    // Nothing marked: nothing to do.
    expect(await flushUserIndex(ctx, s.userId)).toBe('skipped');
    // Another flush holds a fresh claim.
    rt.d1.sqlite
      .prepare('INSERT INTO manifest_dirty (user_id, dirty_at) VALUES (?, ?)')
      .run(s.userId, -(now - 1000));
    expect(await flushUserIndex(ctx, s.userId)).toBe('skipped');
    // That flush died: after five minutes the claim is free (and this user had no index yet).
    rt.d1.sqlite
      .prepare('UPDATE manifest_dirty SET dirty_at = ? WHERE user_id = ?')
      .run(-(now - 6 * 60_000), s.userId);
    expect(await flushUserIndex(ctx, s.userId)).toBe('written');
    rt.d1.sqlite
      .prepare('INSERT INTO manifest_dirty (user_id, dirty_at) VALUES (?, 1)')
      .run(s.userId);
    expect(await flushUserIndex(ctx, s.userId)).toBe('unchanged');
    expect(dirty(rt, s.userId)).toBeNull();

    // A change lands while the flush writes: the mark stays, and the next flush writes it.
    const late = await createFolder(s, root, 'Terlambat');
    rt.d1.sqlite.prepare('DELETE FROM manifest_dirty').run();
    rt.d1.sqlite
      .prepare('INSERT INTO manifest_dirty (user_id, dirty_at) VALUES (?, 1)')
      .run(s.userId);
    const put = rt.r2.put.bind(rt.r2);
    let once = true;
    rt.r2.put = (async (...args: Parameters<typeof put>) => {
      if (once && args[0] === `u/${s.userId}/index.txt`) {
        once = false;
        rt.d1.sqlite.prepare(`UPDATE nodes SET name = 'Diganti' WHERE id = ?`).run(late.id);
        rt.d1.sqlite
          .prepare('UPDATE manifest_dirty SET dirty_at = ? WHERE user_id = ?')
          .run(Date.now(), s.userId);
      }
      return put(...args);
    }) as typeof rt.r2.put;
    expect(await flushUserIndex(ctx, s.userId)).toBe('written');
    expect((await entries(rt, s.userId)).get(late.id)!.name).toBe('Terlambat');
    expect(dirty(rt, s.userId)).toBeGreaterThan(0);
    expect(await flushUserIndex(ctx, s.userId)).toBe('written');
    expect((await entries(rt, s.userId)).get(late.id)!.name).toBe('Diganti');
    expect(dirty(rt, s.userId)).toBeNull();
  });

  it('a failed flush hands the mark back and the hourly cron writes it', async () => {
    const rt = await makeRuntime();
    const [s, root] = await user(rt);
    await rt.settle();
    const put = rt.r2.put.bind(rt.r2);
    let fail = true;
    rt.r2.put = (async (...args: Parameters<typeof put>) => {
      if (fail && args[0] === `u/${s.userId}/index.txt`) {
        fail = false;
        throw new Error('R2 is down');
      }
      return put(...args);
    }) as typeof rt.r2.put;
    const f = await createFolder(s, root, 'Nanti');
    await rt.idle();
    expect((await entries(rt, s.userId)).has(f.id)).toBe(false);
    expect(dirty(rt, s.userId)).toBeGreaterThan(0);

    const r = await rt.runCron('0 * * * *');
    expect(r.failed).toEqual([]);
    expect((await entries(rt, s.userId)).has(f.id)).toBe(true);
    expect(dirty(rt, s.userId)).toBeNull();
  });

  it('the backfill migration marks existing users and the cron writes their first index', async () => {
    const rt = await makeRuntime();
    const [s, root] = await user(rt);
    const f = await uploadText(s, root, 'lama.txt', 'lama');
    await rt.settle();
    await rt.r2.delete(`u/${s.userId}/index.txt`);
    rt.d1.sqlite.prepare('DELETE FROM manifest_dirty').run();
    // A deleted account isn't marked.
    const gone = await signIn(rt, 'pergi@example.com');
    await uploadText(gone, await rootOf(gone), 'x.txt', 'x').catch(() => undefined);
    await rt.settle();
    rt.d1.sqlite.prepare('DELETE FROM manifest_dirty').run();
    rt.d1.sqlite.prepare(`UPDATE users SET status = 'deleted' WHERE id = ?`).run(gone.userId);

    rt.d1.sqlite.exec(readFileSync('migrations/0020_drive_index_backfill.sql', 'utf8'));
    expect(dirty(rt, s.userId)).toBe(1);
    expect(dirty(rt, gone.userId)).toBeNull();
    await rt.runCron('0 * * * *');
    expect((await entries(rt, s.userId)).has(f.id)).toBe(true);
  });

  it('a deleted account keeps no index', async () => {
    const rt = await makeRuntime();
    const [s, root] = await user(rt);
    await createFolder(s, root, 'Apa saja');
    await rt.settle();
    expect(await indexOf(rt, s.userId)).not.toBeNull();
    rt.d1.sqlite.prepare(`UPDATE users SET status = 'deleted' WHERE id = ?`).run(s.userId);
    const ctx = createCtx(rt.env);
    await markIndexDirty(ctx, [s.userId]);
    await rt.idle();
    await ctx.drain();
    expect(await indexOf(rt, s.userId)).toBeNull();
  });
});
