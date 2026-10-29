// R5 (ADR-079): share links live in the access database (`zeiko-access`, ACCESS_DB), apart from
// the file tree, and the main D1 answers for them until that database exists.
import { describe, expect, it } from 'vitest';
import type { DevRuntime } from '../../dev/env';
import { createFolder, grantPlan, rootOf, uploadText } from '../helpers/files';
import { APP, makeRuntime } from '../helpers/runtime';
import { signIn, type Session } from '../helpers/session';

interface ShareJson {
  id: string;
  url: string;
  nodeIds: string[];
  revokedAt: number | null;
}

async function share(s: Session, nodeIds: string[]): Promise<ShareJson> {
  const res = await s.req('POST', '/api/shares', { nodeIds });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { share: ShareJson }).share;
}

const count = (db: DevRuntime['d1'], table: string) =>
  (db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

const download = async (rt: DevRuntime, url: string) =>
  rt.fetch(new Request(url.replace(/^https?:\/\/[^/]+/, APP)));

describe('Share links in the access database (R5, ADR-079)', () => {
  it('keeps links, their items and sends there, and none in the main D1', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'akses@example.com');
    await grantPlan(rt, s.userId);
    const file = await uploadText(s, await rootOf(s), 'surat.txt', 'isi surat');
    await rt.settle();
    const sh = await share(s, [file.id]);
    expect(sh.nodeIds).toEqual([file.id]);
    await s.req('POST', `/api/shares/${sh.id}/sends`, { channel: 'copy' });

    expect(count(rt.access, 'shares')).toBe(1);
    expect(count(rt.access, 'share_items')).toBe(1);
    for (const t of ['shares', 'share_items', 'share_sends']) expect(count(rt.d1, t)).toBe(0);

    const res = await download(rt, sh.url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('isi surat');
    const list = (await (await s.req('GET', `/api/shares?nodeId=${file.id}`)).json()) as {
      items: ShareJson[];
    };
    expect(list.items.map((x) => x.id)).toEqual([sh.id]);
    const exported = (await (await s.req('GET', '/api/me/export')).json()) as {
      shares: unknown[];
    };
    expect(exported.shares).toHaveLength(1);
  });

  it('drops a deleted node from every link that held it (the old cascade)', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'hapus@example.com');
    await grantPlan(rt, s.userId);
    const root = await rootOf(s);
    const folder = await createFolder(s, root, 'Arsip');
    const inside = await uploadText(s, folder.id, 'a.txt', 'a');
    const keep = await uploadText(s, root, 'b.txt', 'b');
    await rt.settle();
    const sh = await share(s, [inside.id, keep.id]);
    await s.req('POST', '/api/nodes/trash', { ids: [folder.id] });
    expect((await s.req('POST', '/api/nodes/delete', { ids: [folder.id] })).status).toBe(200);
    const items = rt.access.sqlite
      .prepare('SELECT node_id FROM share_items WHERE share_id = ?')
      .all(sh.id) as Array<{ node_id: string }>;
    expect(items.map((i) => i.node_id)).toEqual([keep.id]);
  });

  it('answers from the main D1 while the access database is not there', async () => {
    const rt = await makeRuntime();
    delete (rt.env as { ACCESS_DB?: unknown }).ACCESS_DB;
    const s = await signIn(rt, 'tanpa@example.com');
    await grantPlan(rt, s.userId);
    const file = await uploadText(s, await rootOf(s), 'c.txt', 'cadangan');
    await rt.settle();
    const sh = await share(s, [file.id]);
    expect(count(rt.d1, 'shares')).toBe(1);
    expect(count(rt.access, 'shares')).toBe(0);
    expect(await (await download(rt, sh.url)).text()).toBe('cadangan');
    expect((await s.req('DELETE', `/api/shares/${sh.id}`)).status).toBe(204);
    expect((await download(rt, sh.url)).status).toBe(410);
  });
});
