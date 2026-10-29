import { describe, expect, it } from 'vitest';
import { makeRuntime } from '../helpers/runtime';
import { signIn, type Session } from '../helpers/session';
import {
  createFolder,
  downloadPath,
  grantPlan,
  pool,
  rootOf,
  uploadText,
  type NodeJson,
} from '../helpers/files';

async function children(s: Session, id: string, q = '') {
  const res = await s.req('GET', `/api/nodes/${id}/children${q}`);
  return (await res.json()) as {
    items: NodeJson[];
    nextCursor: string | null;
    path?: Array<{ name: string }>;
  };
}

describe('explorer operations (SPEC §8.3)', () => {
  it('creates folders with automatic "(1)" names and lists folders first', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'tree@example.com');
    await grantPlan(rt, s.userId);
    const root = await rootOf(s);
    await uploadText(s, root, 'a.txt', 'a');
    const f1 = await createFolder(s, root, 'Foto');
    const f2 = await createFolder(s, root, 'foto');
    expect(f2.name).toBe('foto (1)');
    const list = await children(s, root);
    expect(list.items.map((i) => i.name)).toEqual(['Foto', 'foto (1)', 'a.txt']);
    expect(list.path?.map((p) => p.name)).toEqual(['Drive Saya']);
    const sub = await createFolder(s, f1.id, 'Liburan');
    const inner = await children(s, sub.id);
    expect(inner.path?.map((p) => p.name)).toEqual(['Drive Saya', 'Foto', 'Liburan']);
  });

  it('paginates large folders with a cursor', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'many@example.com');
    const root = await rootOf(s);
    const db = rt.d1.sqlite;
    const p = db.prepare('SELECT pool_id FROM nodes WHERE id = ?').get(root) as { pool_id: string };
    const ins = db.prepare(
      `INSERT INTO nodes (id, pool_id, space, owner_id, created_by, parent_id, kind, name, name_key, created_at, updated_at)
       VALUES (?, ?, 'personal', ?, ?, ?, ?, ?, ?, 0, 0)`,
    );
    for (let i = 0; i < 250; i++) {
      const name = `item ${String(i).padStart(3, '0')}`;
      ins.run(
        `01J${String(i).padStart(23, '0')}`,
        p.pool_id,
        s.userId,
        s.userId,
        root,
        i % 10 === 0 ? 'folder' : 'file',
        name,
        name,
      );
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await children(s, root, cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
      seen.push(...page.items.map((i) => i.name));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(250);
    expect(seen.slice(0, 25).every((n) => Number(n.slice(5)) % 10 === 0)).toBe(true); // folders first
    const desc = await children(s, root, '?sort=name&dir=desc&limit=5');
    expect(desc.items[0]!.name).toBe('item 240');
  });

  it('renames, rejects clashes and refuses to move a folder into itself', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'mv@example.com');
    const root = await rootOf(s);
    const a = await createFolder(s, root, 'A');
    const b = await createFolder(s, a.id, 'B');
    await createFolder(s, root, 'C');
    const clash = await s.req('PATCH', `/api/nodes/${a.id}`, { name: 'c' });
    expect(clash.status).toBe(409);
    expect((await s.req('PATCH', `/api/nodes/${a.id}`, { name: 'Arsip' })).status).toBe(200);
    expect((await s.req('POST', '/api/nodes/move', { ids: [a.id], targetId: b.id })).status).toBe(
      400,
    );
    expect((await s.req('POST', '/api/nodes/move', { ids: [a.id], targetId: a.id })).status).toBe(
      400,
    );
    const moved = await s.req('POST', '/api/nodes/move', { ids: [b.id], targetId: root });
    expect(moved.status).toBe(200);
    expect((await children(s, root)).items.map((i) => i.name)).toEqual(['Arsip', 'B', 'C']);
    expect((await s.req('PATCH', `/api/nodes/${root}`, { name: 'x' })).status).toBe(403);
  });

  it('copies files by sharing the blob and counting quota per node', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'copy@example.com');
    const poolId = await grantPlan(rt, s.userId);
    const root = await rootOf(s);
    const f = await uploadText(s, root, 'doc.txt', '12345');
    await rt.settle();
    const res = await s.req('POST', `/api/nodes/${f.id}/copy`, {});
    expect(res.status).toBe(201);
    const { node: copy } = (await res.json()) as { node: NodeJson };
    expect(copy.name).toBe('doc (1).txt');
    expect(pool(rt, poolId).used_bytes).toBe(10);
    const blob = rt.d1.sqlite
      .prepare('SELECT refcount FROM blobs b JOIN nodes n ON n.blob_id = b.id WHERE n.id = ?')
      .get(copy.id);
    expect(blob).toEqual({ refcount: 2 });
    // Deleting one copy keeps the object; deleting both frees it.
    await s.req('POST', '/api/nodes/delete', { ids: [f.id] });
    await rt.settle();
    expect(pool(rt, poolId).used_bytes).toBe(5);
    const url = await downloadPath(s, copy.id);
    expect(url).toMatch(/^\/d\//);
    await s.req('POST', '/api/nodes/delete', { ids: [copy.id] });
    await rt.settle();
    expect(pool(rt, poolId).used_bytes).toBe(0);
    expect(rt.d1.sqlite.prepare('SELECT COUNT(*) AS n FROM blobs').get()).toEqual({ n: 0 });
    // Only the Drive index is left in the user's folder (ADR-074).
    const left = (await rt.env.BUCKET.list({ prefix: `u/${s.userId}/` })).objects;
    expect(left.map((o) => o.key)).toEqual([`u/${s.userId}/index.txt`]);
  });

  it('trashes subtrees, restores them (renaming on clash) and keeps quota until deleted', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'trash@example.com');
    const poolId = await grantPlan(rt, s.userId);
    const root = await rootOf(s);
    const folder = await createFolder(s, root, 'Proyek');
    const file = await uploadText(s, folder.id, 'rencana.txt', 'abc');
    await rt.settle();
    expect((await s.req('POST', '/api/nodes/trash', { ids: [folder.id] })).status).toBe(200);
    expect((await children(s, root)).items).toHaveLength(0);
    const trash = (await (await s.req('GET', '/api/trash')).json()) as {
      items: NodeJson[];
      retentionDays: number;
    };
    expect(trash.items.map((i) => i.id)).toEqual([folder.id]);
    expect(trash.retentionDays).toBe(30);
    expect(pool(rt, poolId).used_bytes).toBe(3); // trash still counts (SPEC §16 #13)
    // Can't download or upload into trashed content
    expect(
      (await s.req('POST', '/api/uploads', { parentId: folder.id, name: 'x', size: 1 })).status,
    ).toBe(409);

    await createFolder(s, root, 'Proyek'); // name taken meanwhile
    const restored = (await (
      await s.req('POST', '/api/nodes/restore', { ids: [folder.id] })
    ).json()) as { nodes: NodeJson[] };
    expect(restored.nodes[0]!.name).toBe('Proyek (1)');
    expect((await children(s, folder.id)).items.map((i) => i.id)).toEqual([file.id]);

    await s.req('POST', '/api/nodes/trash', { ids: [folder.id] });
    const emptied = (await (await s.req('POST', '/api/trash/empty')).json()) as { count: number };
    expect(emptied.count).toBe(2);
    await rt.settle();
    expect(pool(rt, poolId).used_bytes).toBe(0);
  });

  it('purges trash after the retention window (nightly cron)', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'purge@example.com');
    await grantPlan(rt, s.userId);
    const root = await rootOf(s);
    const f = await uploadText(s, root, 'lama.txt', 'old');
    await rt.settle();
    await s.req('POST', '/api/nodes/trash', { ids: [f.id] });
    rt.d1.sqlite.prepare('UPDATE nodes SET purge_at = 1 WHERE id = ?').run(f.id);
    const out = await rt.runCron('0 19 * * *');
    expect(out.failed).toEqual([]);
    expect(rt.d1.sqlite.prepare('SELECT COUNT(*) AS n FROM nodes WHERE id = ?').get(f.id)).toEqual({
      n: 0,
    });
  });

  it('deleting a file that is still scanning releases its reservation', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'scanning@example.com');
    const poolId = await grantPlan(rt, s.userId);
    const root = await rootOf(s);
    const f = await uploadText(s, root, 'baru.txt', 'xyz');
    expect(pool(rt, poolId).reserved_bytes).toBe(3);
    await s.req('POST', '/api/nodes/delete', { ids: [f.id] });
    await rt.settle(); // the scan message arrives after the delete → no-op
    expect(pool(rt, poolId)).toMatchObject({ used_bytes: 0, reserved_bytes: 0 });
  });
});

describe('IDOR (SPEC §8.6)', () => {
  it("never lets one user read or modify another user's nodes", async () => {
    const rt = await makeRuntime();
    const alice = await signIn(rt, 'alice@example.com');
    const bob = await signIn(rt, 'bob@example.com');
    await grantPlan(rt, alice.userId);
    const aliceRoot = await rootOf(alice);
    const bobRoot = await rootOf(bob);
    const file = await uploadText(alice, aliceRoot, 'rahasia.txt', 'KTP');
    const folder = await createFolder(alice, aliceRoot, 'Pribadi');
    await rt.settle();

    const attempts: Array<[string, string, unknown?]> = [
      ['GET', `/api/nodes/${file.id}`],
      ['GET', `/api/nodes/${aliceRoot}/children`],
      ['GET', `/api/files/${file.id}/download`],
      ['GET', `/api/files/${file.id}/thumbnail`],
      ['PATCH', `/api/nodes/${file.id}`, { name: 'x' }],
      ['POST', `/api/nodes/${file.id}/copy`, { targetId: bobRoot }],
      ['POST', '/api/nodes/move', { ids: [file.id], targetId: bobRoot }],
      ['POST', '/api/nodes/move', { ids: [bobRoot], targetId: folder.id }],
      ['POST', '/api/nodes/trash', { ids: [file.id] }],
      ['POST', '/api/nodes/restore', { ids: [file.id] }],
      ['POST', '/api/nodes/delete', { ids: [file.id] }],
      ['POST', '/api/folders', { parentId: folder.id, name: 'x' }],
    ];
    for (const [method, path, body] of attempts) {
      const res = await bob.req(method, path, body);
      expect([403, 404], `${method} ${path}`).toContain(res.status);
    }
    const node = rt.d1.sqlite
      .prepare('SELECT name, trashed_at FROM nodes WHERE id = ?')
      .get(file.id);
    expect(node).toEqual({ name: 'rahasia.txt', trashed_at: null });
    const trash = (await (await bob.req('GET', '/api/trash')).json()) as { items: unknown[] };
    expect(trash.items).toEqual([]);
  });
});
