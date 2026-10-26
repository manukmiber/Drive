// The public API v1 (ADR-062): every route documented, every answer matching its schema, scopes,
// pagination, Idempotency-Key, and no reach into another account.
import { describe, expect, it } from 'vitest';
import type { DevRuntime } from '../../dev/env';
import { honoPath } from '../../src/worker/lib/openapi';
import { ENDPOINTS, v1 } from '../../src/worker/routes/v1';
import { TOKEN_SCOPES } from '../../src/worker/services/tokens';
import { grantPlan, rootOf, uploadText } from '../helpers/files';
import { APP, makeRuntime } from '../helpers/runtime';
import { s3Setup } from '../helpers/s3';
import { signIn, type Session } from '../helpers/session';

const ANY_ID = '01JD00000000000000000000ZZ';

async function tokenFor(user: Session, scopes: string[] = [...TOKEN_SCOPES]) {
  const res = await user.req('POST', '/api/tokens', { name: 'test', scopes, expiresInDays: null });
  expect(res.status).toBe(201);
  return ((await res.json()) as { token: string }).token;
}

/** A Bearer client that checks every answer against the endpoint's documented schema. */
function client(rt: DevRuntime, token: string) {
  return async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; json: unknown; res: Response }> => {
    const init: RequestInit = {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined && !(body instanceof Uint8Array)
          ? { 'content-type': 'application/json' }
          : {}),
        ...headers,
      },
    };
    if (body instanceof Uint8Array) {
      init.body = body as BodyInit;
      (init.headers as Record<string, string>)['content-length'] = String(body.length);
    } else if (body !== undefined) init.body = JSON.stringify(body);
    const res = await rt.fetch(new Request(`${APP}/api/v1${path}`, init));
    const text = await res.clone().text();
    const json: unknown = text ? JSON.parse(text) : null;
    const pathOnly = path.split('?')[0]!;
    const ep = ENDPOINTS.find(
      (e) =>
        e.def.method === method.toLowerCase() &&
        new RegExp(`^${honoPath(e.def.path).replace(/:\w+/g, '[^/]+')}$`).test(pathOnly),
    );
    if (ep && res.status < 300) {
      const schema = ep.def.responses[res.status];
      expect(schema, `${method} ${path} → ${res.status} is documented`).not.toBeUndefined();
      if (schema) schema.parse(json);
    }
    return { status: res.status, json, res };
  };
}

describe('API v1 document (ADR-062)', () => {
  it('serves OpenAPI 3.1 without a token, covering every route the router has', async () => {
    const rt = await makeRuntime();
    const res = await rt.fetch(new Request(`${APP}/api/v1/openapi.json`));
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      paths: Record<string, Record<string, { 'x-scope'?: string; responses: object }>>;
    };
    expect(doc.openapi).toBe('3.1.0');
    for (const { def } of ENDPOINTS) {
      const op = doc.paths[def.path]?.[def.method];
      expect(op, `${def.method} ${def.path}`).toBeDefined();
      expect(op!['x-scope'] ?? null).toBe(def.scope);
    }
    // Every route registered on the router is one of the documented endpoints.
    const documented = new Set(
      [...ENDPOINTS.map((e) => e.def), { method: 'get', path: '/openapi.json' }].map(
        (d) => `${d.method.toUpperCase()} ${honoPath(d.path)}`,
      ),
    );
    const routes = v1.routes.filter((r) => r.method !== 'ALL');
    expect(routes.length).toBeGreaterThan(20);
    for (const r of routes)
      expect(documented, `${r.method} ${r.path}`).toContain(`${r.method} ${r.path}`);
  });
});

describe('API v1 (ADR-062)', () => {
  it('runs the Drive flow, every answer matching its schema', async () => {
    const rt = await makeRuntime();
    const user = await signIn(rt, 'api@zeiko.test');
    await grantPlan(rt, user.userId);
    const api = client(rt, await tokenFor(user));
    const root = await rootOf(user);

    const account = await api('GET', '/account');
    expect(account.status).toBe(200);
    expect((account.json as { space: { personalRootId: string } }).space.personalRootId).toBe(root);
    expect(account.res.headers.get('x-ratelimit-limit')).toBe('300');

    const made = await api('POST', '/folders', { parentId: root, name: 'Laporan' });
    expect(made.status).toBe(201);
    const folder = (made.json as { node: { id: string } }).node.id;
    expect((await api('GET', `/nodes/${folder}`)).status).toBe(200);
    expect((await api('PATCH', `/nodes/${folder}`, { name: 'Laporan 2026' })).status).toBe(200);

    // Upload through the multipart protocol.
    const bytes = new TextEncoder().encode('isi laporan v1');
    const init = await api('POST', '/uploads', {
      parentId: folder,
      name: 'catatan.txt',
      size: bytes.length,
      mime: 'text/plain',
    });
    expect(init.status).toBe(201);
    const up = init.json as { uploadId: string; totalParts: number };
    expect(up.totalParts).toBe(1);
    expect((await api('PUT', `/uploads/${up.uploadId}/parts/1`, bytes)).status).toBe(200);
    expect(
      ((await api('GET', `/uploads/${up.uploadId}`)).json as { uploadedParts: number[] })
        .uploadedParts,
    ).toEqual([1]);
    const done = await api('POST', `/uploads/${up.uploadId}/complete`);
    expect(done.status).toBe(200);
    await rt.settle();
    const file = (done.json as { node: { id: string } }).node.id;

    const list = await api('GET', `/nodes/${folder}/children`);
    expect((list.json as { items: unknown[] }).items).toHaveLength(1);
    const dl = await api('GET', `/files/${file}/download`);
    expect(dl.status).toBe(200);
    const url = (dl.json as { url: string }).url;
    expect(url.startsWith(`${APP}/d/`)).toBe(true);
    expect(await (await rt.fetch(new Request(url))).text()).toBe('isi laporan v1');

    const copy = await api('POST', `/nodes/${file}/copy`, {});
    expect(copy.status).toBe(201);
    const other = await api('POST', '/folders', { parentId: root, name: 'Arsip' });
    const archive = (other.json as { node: { id: string } }).node.id;
    expect((await api('POST', '/nodes/move', { ids: [folder], targetId: archive })).status).toBe(
      200,
    );
    expect(
      ((await api('GET', '/search?q=catatan')).json as { items: unknown[] }).items.length,
    ).toBeGreaterThan(0);

    const share = await api('POST', '/shares', { nodeIds: [file], title: 'Catatan' });
    expect(share.status).toBe(201);
    const shareId = (share.json as { share: { id: string } }).share.id;
    expect(
      ((await api('GET', `/shares?nodeId=${file}`)).json as { items: unknown[] }).items,
    ).toHaveLength(1);
    expect((await api('DELETE', `/shares/${shareId}`)).status).toBe(204);

    expect((await api('POST', '/nodes/trash', { ids: [file] })).status).toBe(200);
    expect(((await api('GET', '/trash')).json as { items: unknown[] }).items).toHaveLength(1);
    expect((await api('POST', '/nodes/restore', { ids: [file] })).status).toBe(200);

    // A second upload, given up.
    const init2 = await api('POST', '/uploads', { parentId: root, name: 'batal.bin', size: 10 });
    const up2 = (init2.json as { uploadId: string }).uploadId;
    expect((await api('DELETE', `/uploads/${up2}`)).status).toBe(204);
  });

  it('pages through a folder with a cursor', async () => {
    const rt = await makeRuntime();
    const user = await signIn(rt, 'api@zeiko.test');
    const api = client(rt, await tokenFor(user, ['drive.read', 'drive.write']));
    const root = await rootOf(user);
    for (const n of ['a', 'b', 'c', 'd', 'e'])
      expect((await api('POST', '/folders', { parentId: root, name: n })).status).toBe(201);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const page = (await api('GET', `/nodes/${root}/children?limit=2${q}`)).json as {
        items: Array<{ name: string }>;
        nextCursor: string | null;
      };
      seen.push(...page.items.map((i) => i.name));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(seen).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(pages).toBe(3);
  });

  it('answers a repeated Idempotency-Key with the first result, and refuses a reused one', async () => {
    const rt = await makeRuntime();
    const user = await signIn(rt, 'api@zeiko.test');
    const api = client(rt, await tokenFor(user, ['drive.write']));
    const root = await rootOf(user);
    const key = { 'idempotency-key': 'buat-folder-1' };
    const first = await api('POST', '/folders', { parentId: root, name: 'Sekali' }, key);
    const again = await api('POST', '/folders', { parentId: root, name: 'Sekali' }, key);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.res.headers.get('idempotent-replayed')).toBe('true');
    expect(again.json).toEqual(first.json);
    const count = rt.d1.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM nodes WHERE name = 'Sekali' AND kind = 'folder'`)
      .get() as { n: number };
    expect(count.n).toBe(1);
    const reused = await api('POST', '/folders', { parentId: root, name: 'Lain' }, key);
    expect(reused.status).toBe(409);
    expect(JSON.stringify(reused.json)).toContain('idempotency_key_reused');
    // A failure is not kept: the same key may be tried again.
    const fail = await api(
      'POST',
      '/folders',
      { parentId: ANY_ID, name: 'x' },
      { 'idempotency-key': 'k2' },
    );
    expect(fail.status).toBeGreaterThanOrEqual(400);
    const retry = await api(
      'POST',
      '/folders',
      { parentId: root, name: 'x' },
      { 'idempotency-key': 'k2' },
    );
    expect(retry.status).toBe(201);
  });

  it('needs each operation’s scope', async () => {
    const rt = await makeRuntime();
    const user = await signIn(rt, 'api@zeiko.test');
    for (const s of TOKEN_SCOPES) {
      const others = TOKEN_SCOPES.filter((x) => x !== s);
      const api = client(rt, await tokenFor(user, others));
      for (const { def } of ENDPOINTS.filter((e) => e.def.scope === s)) {
        const path = def.path.replace('{n}', '1').replace(/\{\w+\}/g, ANY_ID);
        const res = await api(def.method.toUpperCase(), path, def.body ? {} : undefined);
        expect(res.status, `${def.method} ${def.path} without ${s}`).toBe(403);
        expect(JSON.stringify(res.json)).toContain('missing_scope');
      }
    }
  });

  it('never reaches another account’s files, uploads or links', async () => {
    const rt = await makeRuntime();
    const a = await signIn(rt, 'a@zeiko.test');
    const b = await signIn(rt, 'b@zeiko.test');
    await grantPlan(rt, a.userId);
    await grantPlan(rt, b.userId);
    const aRoot = await rootOf(a);
    const bRoot = await rootOf(b);
    const file = await uploadText(a, aRoot, 'rahasia.txt', 'data rahasia');
    await rt.settle();
    const share = (await (await a.req('POST', '/api/shares', { nodeIds: [file.id] })).json()) as {
      share: { id: string };
    };
    const upload = (await (
      await a.req('POST', '/api/uploads', { parentId: aRoot, name: 'x.bin', size: 5 })
    ).json()) as { uploadId: string };
    const snapshot = () =>
      JSON.stringify([
        rt.d1.sqlite.prepare('SELECT id, name, parent_id, trashed_at FROM nodes ORDER BY id').all(),
        rt.d1.sqlite.prepare('SELECT id, revoked_at FROM shares ORDER BY id').all(),
        rt.d1.sqlite.prepare('SELECT id, status FROM uploads ORDER BY id').all(),
      ]);
    const before = snapshot();
    const api = client(rt, await tokenFor(b));
    const attempts: Array<[string, string, unknown?]> = [
      ['GET', `/nodes/${file.id}`],
      ['GET', `/nodes/${aRoot}/children`],
      ['GET', `/files/${file.id}/download`],
      ['PATCH', `/nodes/${file.id}`, { name: 'milik-b.txt' }],
      ['POST', '/nodes/move', { ids: [file.id], targetId: bRoot }],
      ['POST', `/nodes/${file.id}/copy`, { targetId: bRoot }],
      ['POST', '/nodes/trash', { ids: [file.id] }],
      ['POST', '/nodes/restore', { ids: [file.id] }],
      ['POST', '/folders', { parentId: aRoot, name: 'dari-b' }],
      ['POST', '/uploads', { parentId: aRoot, name: 'dari-b.bin', size: 3 }],
      ['GET', `/uploads/${upload.uploadId}`],
      ['PUT', `/uploads/${upload.uploadId}/parts/1`, new Uint8Array(5)],
      ['POST', `/uploads/${upload.uploadId}/complete`],
      ['DELETE', `/uploads/${upload.uploadId}`],
      ['POST', '/shares', { nodeIds: [file.id] }],
      ['DELETE', `/shares/${share.share.id}`],
    ];
    const leaks: string[] = [];
    for (const [m, p, body] of attempts) {
      const res = await api(m, p, body);
      if (res.status < 400 || res.status >= 500) leaks.push(`${m} ${p} → ${res.status}`);
    }
    expect(leaks).toEqual([]);
    const search = (await api('GET', '/search?q=rahasia')).json as { items: unknown[] };
    expect(search.items).toEqual([]);
    expect(
      ((await api('GET', `/shares?nodeId=${file.id}`)).json as { items: unknown[] }).items,
    ).toEqual([]);
    expect(snapshot()).toBe(before);
  });

  it('manages Zeiko S3 with s3.manage', async () => {
    const { rt, user } = await s3Setup();
    const api = client(rt, await tokenFor(user, ['s3.manage']));
    const o = await api('GET', '/s3');
    expect(o.status).toBe(200);
    const key = await api('POST', '/s3/keys', { label: 'ci' });
    expect(key.status).toBe(201);
    const keyId = (key.json as { key: { id: string } }).key.id;
    expect((await api('POST', '/s3/buckets', { name: 'dari-api' })).status).toBe(201);
    expect((await api('PATCH', '/s3/buckets/dari-api', { public: true })).status).toBe(204);
    expect(
      (
        await api('PUT', '/s3/buckets/dari-api/cors', {
          rules: [{ allowedOrigins: ['https://app.example.com'], allowedMethods: ['GET'] }],
        })
      ).status,
    ).toBe(200);
    expect((await api('DELETE', '/s3/buckets/dari-api/cors')).status).toBe(204);
    expect((await api('DELETE', '/s3/buckets/dari-api')).status).toBe(204);
    expect((await api('DELETE', `/s3/keys/${keyId}`)).status).toBe(204);
    // Another account's bucket is not reachable.
    const other = await s3Setup({ rt, email: 'lain@zeiko.test' });
    await other.user.req('POST', '/api/s3/buckets', { name: 'punya-lain' });
    expect((await api('DELETE', '/s3/buckets/punya-lain')).status).toBe(403);
  });
});
