// R2 (ADR-077): the explorer, API v1 and the app's first request read a personal Drive from its
// index in R2, answer exactly as D1 did, and never show a person less than their last change.
import { describe, expect, it } from 'vitest';
import { parseIndex } from '../../src/shared/drive-index';
import { createCtx } from '../../src/worker/context';
import { flushUserIndex } from '../../src/worker/services/drive-index-sync';
import {
  breadcrumb,
  getNodeDto,
  listChildren,
  type NodeDto,
} from '../../src/worker/services/nodes';
import { createFolder, grantPlan, rootOf, uploadText } from '../helpers/files';
import { APP, makeRuntime } from '../helpers/runtime';
import { signIn } from '../helpers/session';

/** The index keeps whole seconds (ADR-064); D1 keeps milliseconds. */
function seconds<T>(v: T): T {
  return JSON.parse(
    JSON.stringify(v, (k, x: unknown) =>
      typeof x === 'number' && /At$/.test(k) ? Math.floor(x / 1000) * 1000 : x,
    ),
  ) as T;
}

async function json<T>(res: Response): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as T;
}

async function drive(email = 'baca@example.com') {
  const rt = await makeRuntime();
  const s = await signIn(rt, email);
  await grantPlan(rt, s.userId);
  return { rt, s, root: await rootOf(s) };
}

describe('Drive read from the index (R2, ADR-077)', () => {
  it('lists, details and paths exactly as D1 did, for every sort', async () => {
    const { rt, s, root } = await drive();
    const docs = await createFolder(s, root, 'Dokumen');
    const sub = await createFolder(s, docs.id, 'Arsip 2026');
    await createFolder(s, root, 'alfa');
    const a = await uploadText(s, docs.id, 'b-catatan.txt', 'halo dunia');
    await uploadText(s, docs.id, 'A-rencana.md', 'x');
    await uploadText(s, root, 'zeta.csv', '1,2,3,4,5');
    const gone = await uploadText(s, docs.id, 'dibuang.txt', 'y');
    await s.req('POST', '/api/nodes/trash', { ids: [gone.id] });
    await s.req('PUT', `/api/nodes/${a.id}/star`);
    expect(
      (
        await s.req('POST', '/api/nodes/decor', {
          ids: [sub.id],
          color: 'teal',
          icon: 'star',
        })
      ).status,
    ).toBe(200);
    await rt.settle();

    const ctx = createCtx(rt.env);
    for (const folder of [root, docs.id, sub.id])
      for (const sort of ['name', 'updated', 'size', 'type'] as const)
        for (const dir of ['asc', 'desc'] as const) {
          const got = await json<{ folder: NodeDto; items: NodeDto[]; path: unknown[] }>(
            await s.req('GET', `/api/nodes/${folder}/children?sort=${sort}&dir=${dir}`),
          );
          const d1 = await listChildren(ctx, s.userId, folder, { sort, dir });
          // Same items in the same order; the root's own row is the only one the index describes
          // from its header.
          expect(seconds(got.items)).toEqual(seconds(d1.items));
          if (folder !== root) expect(seconds(got.folder)).toEqual(seconds(d1.folder));
          expect(got.path).toEqual(await breadcrumb(ctx, folder));
        }

    for (const id of [a.id, sub.id, docs.id]) {
      const got = await json<{ node: NodeDto; path: unknown[]; access: unknown }>(
        await s.req('GET', `/api/nodes/${id}`),
      );
      expect(seconds(got.node)).toEqual(seconds(await getNodeDto(ctx, s.userId, id)));
      expect(got.path).toEqual(await breadcrumb(ctx, id));
      expect(got.access).toEqual({
        view: true,
        edit: true,
        remove: true,
        add: true,
        isOwner: true,
      });
    }

    const trash = await json<{ items: NodeDto[] }>(await s.req('GET', '/api/trash'));
    expect(trash.items.map((n) => n.id)).toEqual([gone.id]);
    expect(trash.items[0]!.purgeAt).toBeGreaterThan(trash.items[0]!.trashedAt!);
    const starred = await json<{ items: NodeDto[] }>(await s.req('GET', '/api/starred'));
    expect(starred.items.map((n) => n.id)).toEqual([a.id]);
    const found = await json<{ items: NodeDto[] }>(await s.req('GET', '/api/search?q=arsip'));
    expect(found.items.map((n) => n.id)).toEqual([sub.id]);

    // Paging through the index walks the folder once.
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const q: string = cursor ? `&cursor=${cursor}` : '';
      const p: { items: NodeDto[]; nextCursor: string | null; path?: unknown } = await json(
        await s.req('GET', `/api/nodes/${docs.id}/children?limit=1${q}`),
      );
      expect(Boolean(p.path)).toBe(!cursor);
      ids.push(...p.items.map((n) => n.id));
      cursor = p.nextCursor;
    } while (cursor);
    expect(ids).toEqual((await listChildren(ctx, s.userId, docs.id)).items.map((n) => n.id));
    expect((await s.req('GET', `/api/nodes/${docs.id}/children?cursor=xyz`)).status).toBe(400);
    expect((await s.req('GET', `/api/nodes/${a.id}/children`)).status).toBe(400);
  });

  it('serves the index with an ETag, 304 when unchanged, and never behind a change', async () => {
    const { rt, s, root } = await drive();
    await createFolder(s, root, 'Satu');
    await rt.settle();

    const first = await s.req('GET', '/api/drive/index');
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(first.headers.get('x-drive-owner')).toBe(s.userId);
    expect(first.headers.get('x-drive-trash-days')).toBe('30');
    const etag = first.headers.get('etag')!;
    expect(etag).toMatch(/^".+"$/);
    const idx = parseIndex(await first.text());
    expect(idx.head.root).toBe(root);
    expect(idx.entries.map((e) => e.name)).toEqual(['Satu']);

    const again = await s.req('GET', '/api/drive/index', undefined, {
      headers: { 'if-none-match': etag },
    });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');

    // A change the index hasn't caught up with yet (its flush still to come) is in the next read.
    const ctx = createCtx(rt.env);
    const dua = await createFolder(s, root, 'Dua');
    rt.d1.sqlite
      .prepare('INSERT OR REPLACE INTO manifest_dirty (user_id, dirty_at) VALUES (?, ?)')
      .run(s.userId, Date.now());
    const behind = await s.req('GET', '/api/drive/index', undefined, {
      headers: { 'if-none-match': etag },
    });
    expect(behind.status).toBe(200);
    expect(behind.headers.get('etag')).toBeNull();
    expect(
      parseIndex(await behind.text())
        .entries.map((e) => e.name)
        .sort(),
    ).toEqual(['Dua', 'Satu']);
    const kids = await json<{ items: NodeDto[] }>(
      await s.req('GET', `/api/nodes/${root}/children`),
    );
    expect(kids.items.map((n) => n.id)).toContain(dua.id);

    await rt.settle();
    await flushUserIndex(ctx, s.userId);
    const after = await s.req('GET', '/api/drive/index', undefined, {
      headers: { 'if-none-match': etag },
    });
    expect(after.status).toBe(200);
    expect(after.headers.get('etag')).not.toBe(etag);
    expect(after.headers.get('etag')).toBeTruthy();
  });

  it("answers a person with no index yet, and never reaches someone else's files", async () => {
    const { rt, s, root } = await drive();
    const b = await signIn(rt, 'orang-lain@example.com');
    await grantPlan(rt, b.userId);
    const secret = await createFolder(s, root, 'Rahasia');
    const file = await uploadText(s, secret.id, 'ktp.txt', 'data');
    await rt.settle();

    // B never changed anything: no index object, an empty tree with B's root.
    const bIndex = await b.req('GET', '/api/drive/index');
    expect(bIndex.status).toBe(200);
    const parsed = parseIndex(await bIndex.text());
    expect(parsed.head.root).toBe(await rootOf(b));
    expect(parsed.entries).toEqual([]);
    expect(await rt.r2.get(`u/${b.userId}/index.txt`)).toBeNull();

    for (const path of [
      `/api/nodes/${secret.id}`,
      `/api/nodes/${secret.id}/children`,
      `/api/nodes/${file.id}`,
      `/api/nodes/${root}/children`,
    ])
      expect((await b.req('GET', path)).status, path).toBe(404);
    for (const path of ['/api/search?q=ktp', '/api/starred', '/api/trash'])
      expect(JSON.stringify(await json(await b.req('GET', path))), path).not.toContain(file.id);
    // Signed out, nothing.
    expect((await rt.fetch(new Request(`${APP}/api/drive/index`))).status).toBe(401);
  });

  it('keeps a suspended account locked out, as the D1 reads did', async () => {
    const { rt, s, root } = await drive();
    const f = await createFolder(s, root, 'Kunci');
    await rt.settle();
    rt.d1.sqlite.prepare(`UPDATE subscriptions SET status = 'suspended'`).run();
    for (const path of ['/api/drive/index', `/api/nodes/${f.id}`, `/api/nodes/${root}/children`]) {
      const res = await s.req('GET', path);
      expect(res.status, path).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'ACCOUNT_SUSPENDED',
      );
    }
  });

  it('gives API clients the same index under drive.read, documented as text', async () => {
    const { rt, s, root } = await drive();
    await createFolder(s, root, 'Untuk aplikasi');
    await rt.settle();
    const token = async (scopes: string[]) =>
      (
        (await (
          await s.req('POST', '/api/tokens', { name: 'app', scopes, expiresInDays: null })
        ).json()) as { token: string }
      ).token;
    const get = (t: string, headers: Record<string, string> = {}) =>
      rt.fetch(
        new Request(`${APP}/api/v1/drive/index`, {
          headers: { authorization: `Bearer ${t}`, ...headers },
        }),
      );
    const read = await token(['drive.read']);
    const res = await get(read);
    expect(res.status).toBe(200);
    expect(parseIndex(await res.text()).entries.map((e) => e.name)).toEqual(['Untuk aplikasi']);
    expect((await get(read, { 'if-none-match': res.headers.get('etag')! })).status).toBe(304);
    expect((await get(await token(['s3.manage']))).status).toBe(403);

    const doc = (await (await rt.fetch(new Request(`${APP}/api/v1/openapi.json`))).json()) as {
      paths: Record<string, { get: { responses: Record<string, { content?: object }> } }>;
    };
    const op = doc.paths['/drive/index']!.get;
    expect(Object.keys(op.responses['200']!.content!)).toEqual(['text/plain']);
    expect(op.responses['304']).toBeDefined();
  });
});
