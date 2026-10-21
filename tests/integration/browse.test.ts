import { describe, expect, it } from 'vitest';
import { ftsQuery } from '../../src/worker/services/browse';
import { APP, makeRuntime } from '../helpers/runtime';
import { signIn } from '../helpers/session';
import {
  createFolder,
  grantPlan,
  rootOf,
  simpleUpload,
  uploadText,
  type NodeJson,
} from '../helpers/files';

describe('search / starred / recent (SPEC §8)', () => {
  it('builds safe FTS queries', () => {
    expect(ftsQuery('Laporan keu')).toBe('"laporan"* AND "keu"*');
    expect(ftsQuery('"; DROP TABLE nodes; --')).toBe('"drop"* AND "table"* AND "nodes"*');
    expect(ftsQuery('   ')).toBeNull();
  });

  it("finds files by name prefix across folders, only within the user's own spaces", async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'cari@example.com');
    const other = await signIn(rt, 'lain@example.com');
    await grantPlan(rt, s.userId);
    await grantPlan(rt, other.userId);
    const root = await rootOf(s);
    const f = await createFolder(s, root, 'Kantor');
    await uploadText(s, f.id, 'Laporan_Keuangan-2026.xlsx', 'x');
    await uploadText(s, root, 'foto liburan.jpg', 'y');
    await uploadText(other, await rootOf(other), 'Laporan rahasia.txt', 'z');
    await rt.settle();
    const res = (await (await s.req('GET', '/api/search?q=lapor%20keu')).json()) as {
      items: NodeJson[];
    };
    expect(res.items.map((i) => i.name)).toEqual(['Laporan_Keuangan-2026.xlsx']);
    const folders = (await (await s.req('GET', '/api/search?q=kan&type=folder')).json()) as {
      items: NodeJson[];
    };
    expect(folders.items.map((i) => i.name)).toEqual(['Kantor']);
  });

  it('stars and lists recent files', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'star@example.com');
    await grantPlan(rt, s.userId);
    const root = await rootOf(s);
    const a = await uploadText(s, root, 'a.txt', 'a');
    await rt.settle();
    expect((await s.req('PUT', `/api/nodes/${a.id}/star`)).status).toBe(204);
    const starred = (await (await s.req('GET', '/api/starred')).json()) as {
      items: Array<NodeJson & { starred: boolean }>;
    };
    expect(starred.items.map((i) => [i.id, i.starred])).toEqual([[a.id, true]]);
    await s.req('DELETE', `/api/nodes/${a.id}/star`);
    expect(
      ((await (await s.req('GET', '/api/starred')).json()) as { items: unknown[] }).items,
    ).toEqual([]);
    const recent = (await (await s.req('GET', '/api/recent')).json()) as { items: NodeJson[] };
    expect(recent.items.map((i) => i.id)).toEqual([a.id]);
  });
});

describe('inline preview on USERCONTENT_ORIGIN (SPEC §8.4, §14.4)', () => {
  it('serves previews only from the user-content host, with CORS for the app', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'prev@example.com');
    await grantPlan(rt, s.userId);
    const root = await rootOf(s);
    const res = await simpleUpload(
      s,
      root,
      'gambar.png',
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]),
      { mime: 'image/png' },
    );
    const { node } = (await res.json()) as { node: NodeJson };
    await rt.settle();
    const p = (await (await s.req('GET', `/api/files/${node.id}/preview`)).json()) as {
      url: string;
      kind: string;
    };
    expect(p.kind).toBe('image');
    expect(p.url.startsWith('http://uc.localhost:8790/p/')).toBe(true);
    const img = await rt.fetch(new Request(p.url, { headers: { origin: APP } }));
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(img.headers.get('content-disposition')).toMatch(/^inline/);
    expect(img.headers.get('access-control-allow-origin')).toBe(APP);
    // Same path on the app host → 404 (user content never lives on APP_ORIGIN)
    const onApp = await rt.fetch(new Request(p.url.replace('http://uc.localhost:8790', APP)));
    expect(onApp.status).toBe(404);
    // A download token is not a preview token
    const dl = (await (await s.req('GET', `/api/files/${node.id}/download`)).json()) as {
      url: string;
    };
    const token = dl.url.split('/')[2];
    expect((await rt.fetch(new Request(`http://uc.localhost:8790/p/${token}/x`))).status).toBe(410);
  });

  it('shows SVG/HTML as plain text, never rendered', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'svg@example.com');
    await grantPlan(rt, s.userId);
    const root = await rootOf(s);
    for (const [name, mime] of [
      ['x.svg', 'image/svg+xml'],
      ['x.html', 'text/html'],
    ] as const) {
      const r = await simpleUpload(s, root, name, '<script>alert(1)</script>', { mime });
      const { node } = (await r.json()) as { node: NodeJson };
      await rt.settle();
      const p = (await (await s.req('GET', `/api/files/${node.id}/preview`)).json()) as {
        url: string;
        kind: string;
      };
      expect(p.kind).toBe('text');
      const body = await rt.fetch(new Request(p.url));
      expect(body.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      expect(body.headers.get('content-security-policy')).toContain('sandbox');
    }
  });
});
