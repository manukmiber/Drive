import { describe, expect, it } from 'vitest';
import { APP, makeRuntime } from '../helpers/runtime';
import { signIn } from '../helpers/session';
import { invalidateConfigMemo } from '../../src/worker/services/config';
import { createFolder, downloadPath, grantPlan, rootOf, uploadText } from '../helpers/files';

async function setup() {
  const rt = await makeRuntime();
  const s = await signIn(rt, 'dl@example.com');
  await grantPlan(rt, s.userId);
  const root = await rootOf(s);
  const node = await uploadText(
    s,
    root,
    'Laporan Keuangan 2026 — final.txt',
    '0123456789abcdefghij',
  );
  await rt.settle();
  const path = await downloadPath(s, node.id);
  // No cookie on purpose: download managers fetch the URL directly.
  const get = (headers: Record<string, string> = {}, method = 'GET') =>
    rt.fetch(new Request(`${APP}${path}`, { method, headers }));
  return { rt, s, node, path, get };
}

describe('signed downloads (SPEC §5.3)', () => {
  it('streams the whole file without cookies, as an attachment', async () => {
    const { get } = await setup();
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('0123456789abcdefghij');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-length')).toBe('20');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="Laporan Keuangan 2026 _ final.txt"; filename\*=UTF-8''Laporan%20Keuangan%202026%20%E2%80%94%20final.txt$/,
    );
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('serves byte ranges, suffix ranges and 416', async () => {
    const { get } = await setup();
    const r1 = await get({ range: 'bytes=10-14' });
    expect(r1.status).toBe(206);
    expect(r1.headers.get('content-range')).toBe('bytes 10-14/20');
    expect(await r1.text()).toBe('abcde');
    const r2 = await get({ range: 'bytes=-3' });
    expect(await r2.text()).toBe('hij');
    const r3 = await get({ range: 'bytes=50-' });
    expect(r3.status).toBe(416);
    expect(r3.headers.get('content-range')).toBe('bytes */20');
    const multi = await get({ range: 'bytes=0-1,5-6' });
    expect(multi.status).toBe(200);
    expect((await multi.text()).length).toBe(20);
  });

  it('supports HEAD, ETag/If-None-Match and If-Range', async () => {
    const { get } = await setup();
    const head = await get({}, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('20');
    expect(await head.text()).toBe('');
    const etag = head.headers.get('etag')!;
    expect((await get({ 'if-none-match': etag })).status).toBe(304);
    expect((await get({ range: 'bytes=0-1', 'if-range': etag })).status).toBe(206);
    expect((await get({ range: 'bytes=0-1', 'if-range': '"stale"' })).status).toBe(200);
  });

  it('reassembles 8 parallel range requests into the original bytes (IDM/aria2 style)', async () => {
    const { get } = await setup();
    const chunks = await Promise.all(
      Array.from({ length: 8 }, async (_, i) => {
        const start = Math.floor((i * 20) / 8);
        const end = Math.floor(((i + 1) * 20) / 8) - 1;
        return (await get({ range: `bytes=${start}-${end}` })).text();
      }),
    );
    expect(chunks.join('')).toBe('0123456789abcdefghij');
  });

  it('rejects tampered or expired tokens before touching D1', async () => {
    const { rt, path } = await setup();
    const parts = path.split('/');
    const token = parts[2]!;
    const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    const before = rt.d1.queryCount;
    const res = await rt.fetch(`${APP}/d/${tampered}/x.txt`);
    expect(res.status).toBe(410);
    expect(rt.d1.queryCount).toBe(before);
    const [blob, node, user, , sig] = token.split('.');
    expect(
      (await rt.fetch(`${APP}/d/${[blob, node, user, '1', sig].join('.')}/x.txt`)).status,
    ).toBe(410);
  });

  it('stops working when the file is deleted', async () => {
    const { s, node, get } = await setup();
    await s.req('POST', '/api/nodes/delete', { ids: [node.id] });
    expect((await get()).status).toBe(404);
  });

  it('never exposes R2/S3 URLs or credentials', async () => {
    const { s, node } = await setup();
    const body = await (await s.req('GET', `/api/files/${node.id}/download`)).text();
    expect(body).not.toMatch(/r2\.cloudflarestorage|X-Amz|amazonaws|r2\.dev/i);
    expect(JSON.parse(body).url).toMatch(/^\/d\//);
  });
});

describe('download separately (ADR-053)', () => {
  interface Plan {
    items: Array<{ nodeId: string; name: string; path: string; size: number; url: string }>;
    folders: string[];
    skipped: number;
    totalBytes: number;
    expiresAt: number;
  }

  it('lists every ready file under the chosen items with its own working link', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'plan@example.com');
    await grantPlan(rt, s.userId);
    const root = await rootOf(s);
    const photos = await createFolder(s, root, 'Foto');
    const y2024 = await createFolder(s, photos.id, '2024');
    await createFolder(s, photos.id, 'Kosong');
    const a = await uploadText(s, photos.id, 'a.txt', 'aaa');
    await uploadText(s, y2024.id, 'b.txt', 'bbbbb');
    const loose = await uploadText(s, root, 'c.txt', 'cc');
    await rt.settle();
    // Still being scanned: left out, and counted.
    await uploadText(s, y2024.id, 'pending.txt', 'zz');

    const res = await s.req('POST', '/api/files/download-plan', {
      // The folder, a file inside it again, and a loose file.
      nodeIds: [photos.id, a.id, loose.id],
    });
    expect(res.status).toBe(200);
    const plan = (await res.json()) as Plan;
    expect(plan.items.map((i) => i.path).sort()).toEqual([
      'Foto/2024/b.txt',
      'Foto/a.txt',
      'c.txt',
    ]);
    expect(plan.folders).toEqual(expect.arrayContaining(['Foto', 'Foto/2024', 'Foto/Kosong']));
    expect(plan.skipped).toBe(1);
    expect(plan.totalBytes).toBe(10);
    for (const i of plan.items) {
      expect(i.url).toMatch(/^\/d\//);
      // No cookie: the queue fetches like a download manager, Range included.
      const r = await rt.fetch(new Request(`${APP}${i.url}`, { headers: { range: 'bytes=1-' } }));
      expect(r.status).toBe(206);
      expect((await r.text()).length).toBe(i.size - 1);
    }
  });

  it("refuses someone else's items and too many files", async () => {
    const rt = await makeRuntime();
    const owner = await signIn(rt, 'owner-plan@example.com');
    await grantPlan(rt, owner.userId);
    const root = await rootOf(owner);
    const folder = await createFolder(owner, root, 'Rahasia');
    await uploadText(owner, folder.id, '1.txt', '1');
    await uploadText(owner, folder.id, '2.txt', '2');
    await uploadText(owner, folder.id, '3.txt', '3');
    await rt.settle();

    const other = await signIn(rt, 'other-plan@example.com');
    await grantPlan(rt, other.userId);
    const stolen = await other.req('POST', '/api/files/download-plan', { nodeIds: [folder.id] });
    expect([403, 404]).toContain(stolen.status);
    expect(await stolen.text()).not.toContain('/d/');

    rt.d1.sqlite
      .prepare(
        `INSERT INTO app_config (key, value_json, updated_by, updated_at)
         VALUES ('download_plan_max_items', '2', 'test', 0)`,
      )
      .run();
    await rt.env.CONFIG_KV.delete('config:v1');
    invalidateConfigMemo(rt.env);
    const big = await owner.req('POST', '/api/files/download-plan', { nodeIds: [folder.id] });
    expect(big.status).toBe(413);
    expect(((await big.json()) as { error: { data: { max: number } } }).error.data.max).toBe(2);
  });
});
