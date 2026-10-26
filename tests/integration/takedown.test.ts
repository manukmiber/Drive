import { describe, expect, it } from 'vitest';
import { APP, jsonReq, makeRuntime } from '../helpers/runtime';
import { signIn } from '../helpers/session';
import { grantPlan, rootOf, uploadText } from '../helpers/files';
import { operator } from '../helpers/ops';
import { createDownloadToken } from '../../src/worker/services/download';
import type { DevRuntime } from '../../dev/env';

async function sharedFile(
  rt: DevRuntime,
  email = 'pemilik@example.com',
  content = 'konten bermasalah',
) {
  const owner = await signIn(rt, email);
  await grantPlan(rt, owner.userId);
  const root = await rootOf(owner);
  const f = await uploadText(owner, root, 'x.txt', content);
  await rt.settle();
  const share = (
    (await (await owner.req('POST', '/api/shares', { nodeIds: [f.id] })).json()) as {
      share: { id: string; url: string };
    }
  ).share;
  return { owner, root, f, share };
}

const report = (rt: DevRuntime, body: Record<string, unknown>) =>
  rt.fetch(jsonReq('POST', '/api/public/reports', body));

describe('no admin panel in Drive (ADR-057)', () => {
  it('has no /api/admin, whatever role an old account still carries', async () => {
    const rt = await makeRuntime();
    const old = await signIn(rt, 'staf-lama@example.com');
    rt.d1.sqlite.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(old.userId);
    for (const path of ['/api/admin/whoami', '/api/admin/reports', '/api/admin/dashboard'])
      expect((await old.req('GET', path)).status, path).toBe(404);
    // And the ops API is the relay's alone.
    expect((await old.req('GET', '/api/ops/reports')).status).toBe(404);
  });

  it('the operator suspends a person: signed out, links off', async () => {
    const rt = await makeRuntime();
    const ops = operator(rt);
    const { owner, share } = await sharedFile(rt);
    const res = await ops('POST', `/users/${owner.userId}/suspend`, {
      suspended: true,
      reason: 'spam berulang',
    });
    expect(res.status).toBe(204);
    expect((await owner.req('GET', '/api/me')).status).toBe(401);
    expect((await rt.fetch(new Request(share.url))).status).toBe(410);
  });
});

describe('reports & takedown (SPEC §14.3)', () => {
  it('anonymous report → review (audited) → quarantine, disable link, blocklist → resolve', async () => {
    const rt = await makeRuntime();
    const ops = operator(rt);
    const { owner, root, f, share } = await sharedFile(rt);
    const r = await report(rt, {
      targetType: 'share',
      targetId: share.id,
      category: 'copyright',
      details: 'film bajakan',
    });
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: string };
    const list = (await (await ops('GET', '/reports')).json()) as {
      items: Array<{ id: string; priority: string; slaDueAt: number; createdAt: number }>;
    };
    expect(list.items[0]).toMatchObject({ id, priority: 'normal' });
    expect(list.items[0]!.slaDueAt - list.items[0]!.createdAt).toBe(24 * 3600_000);

    const detail = (await (await ops('GET', `/reports/${id}`)).json()) as {
      files: Array<{ id: string }>;
    };
    expect(detail.files.map((x) => x.id)).toEqual([f.id]);
    const { url } = (await (
      await ops('POST', `/reports/${id}/preview`, { nodeId: f.id })
    ).json()) as { url: string };
    expect(await (await rt.fetch(new Request(url))).text()).toBe('konten bermasalah');
    const viewed = rt.d1.sqlite
      .prepare("SELECT actor_id FROM audit_logs WHERE action = 'report.content_view'")
      .all();
    expect(viewed).toEqual([{ actor_id: 'relay-operator' }]);

    await ops('POST', `/reports/${id}/actions`, {
      actions: ['quarantine', 'disable_links', 'blocklist'],
      note: 'melanggar hak cipta',
    });
    expect((await rt.fetch(new Request(share.url))).status).toBe(410);
    expect((await owner.req('GET', `/api/files/${f.id}/download`)).status).toBe(403);
    // Quarantined content is still reviewable by the operator
    const again = (await (
      await ops('POST', `/reports/${id}/preview`, { nodeId: f.id })
    ).json()) as { url: string };
    expect((await rt.fetch(new Request(again.url))).status).toBe(200);
    // Same bytes can't come back
    const re = await uploadText(owner, root, 'lagi.txt', 'konten bermasalah');
    await rt.settle();
    expect(rt.d1.sqlite.prepare('SELECT status FROM nodes WHERE id = ?').get(re.id)).toEqual({
      status: 'rejected',
    });

    await ops('POST', `/reports/${id}/actions`, {
      actions: ['resolve'],
      note: 'selesai ditindak',
    });
    const done = (await (await ops('GET', '/reports?status=resolved')).json()) as {
      items: Array<{ id: string }>;
    };
    expect(done.items.map((x) => x.id)).toEqual([id]);
  });

  it('a CSAM report from a signed-in person takes the content down, not the account', async () => {
    const rt = await makeRuntime();
    const ops = operator(rt);
    const { owner, f, share } = await sharedFile(rt, 'pelaku@example.com', 'x');
    const reporter = await signIn(rt, 'pelapor@example.com');
    const r = await reporter.req('POST', '/api/public/reports', {
      targetType: 'share',
      targetId: share.id,
      category: 'csam',
    });
    const { id, priority } = (await r.json()) as { id: string; priority: string };
    expect(priority).toBe('urgent');
    expect((await rt.fetch(new Request(share.url))).status).toBe(410);
    // A report is only a claim: the account waits for the operator (ADR-056).
    expect((await owner.req('GET', '/api/me')).status).toBe(200);
    const blobId = (
      rt.d1.sqlite.prepare('SELECT blob_id FROM nodes WHERE id = ?').get(f.id) as {
        blob_id: string;
      }
    ).blob_id;
    expect(rt.d1.sqlite.prepare('SELECT scan_status FROM blobs WHERE id = ?').get(blobId)).toEqual({
      scan_status: 'quarantined',
    });
    expect(
      rt.d1.sqlite.prepare('SELECT COUNT(*) AS n FROM legal_holds WHERE blob_id = ?').get(blobId),
    ).toEqual({ n: 1 });
    expect(
      rt.d1.sqlite.prepare('SELECT created_by FROM legal_holds WHERE blob_id = ?').get(blobId),
    ).toEqual({ created_by: 'auto' });
    const del = await ops('POST', `/reports/${id}/actions`, {
      actions: ['delete'],
      note: 'hapus',
    });
    expect(del.status).toBe(409);
    // The operator freezes the account after looking.
    const ban = await ops('POST', `/reports/${id}/actions`, {
      actions: ['ban_uploader'],
      note: 'terbukti',
    });
    expect(ban.status).toBe(204);
    expect((await owner.req('GET', '/api/me')).status).toBe(401);
    expect(
      (
        await rt.fetch(
          jsonReq('POST', '/api/public/reports', {
            targetType: 'share',
            targetId: 'x'.repeat(64),
            category: 'spam',
          }),
        )
      ).status,
    ).toBe(404);
  });

  it('an anonymous CSAM report without Turnstile waits for the operator', async () => {
    const rt = await makeRuntime();
    const { owner, f, share } = await sharedFile(rt, 'korban@example.com', 'x');
    const r = await report(rt, { targetType: 'share', targetId: share.id, category: 'csam' });
    expect(r.status).toBe(201);
    expect(((await r.json()) as { priority: string }).priority).toBe('urgent');
    expect((await rt.fetch(new Request(share.url))).status).toBe(200);
    expect((await owner.req('GET', '/api/me')).status).toBe(200);
    const nodeReport = await report(rt, { targetType: 'node', targetId: f.id, category: 'csam' });
    expect(nodeReport.status).toBe(201);
    expect(
      rt.d1.sqlite
        .prepare(
          'SELECT b.scan_status FROM nodes n JOIN blobs b ON b.id = n.blob_id WHERE n.id = ?',
        )
        .get(f.id),
    ).toEqual({ scan_status: 'clean' });
  });

  it('rejecting a report puts back what it switched off', async () => {
    const rt = await makeRuntime();
    const ops = operator(rt);
    const { f, share } = await sharedFile(rt, 'dituduh@example.com', 'x');
    const reporter = await signIn(rt, 'iseng@example.com');
    const r = await reporter.req('POST', '/api/public/reports', {
      targetType: 'share',
      targetId: share.id,
      category: 'csam',
    });
    const { id } = (await r.json()) as { id: string };
    expect((await rt.fetch(new Request(share.url))).status).toBe(410);
    const rej = await ops('POST', `/reports/${id}/actions`, {
      actions: ['reject'],
      note: 'laporan palsu',
    });
    expect(rej.status).toBe(204);
    expect((await rt.fetch(new Request(share.url))).status).toBe(200);
    const blob = rt.d1.sqlite
      .prepare(
        'SELECT b.id, b.scan_status FROM nodes n JOIN blobs b ON b.id = n.blob_id WHERE n.id = ?',
      )
      .get(f.id) as { id: string; scan_status: string };
    expect(blob.scan_status).toBe('clean');
    expect(
      rt.d1.sqlite.prepare('SELECT COUNT(*) AS n FROM legal_holds WHERE blob_id = ?').get(blob.id),
    ).toEqual({ n: 0 });
  });

  it('a hold the operator places names the operator; a review link is theirs alone', async () => {
    const rt = await makeRuntime();
    const ops = operator(rt);
    const { f, share } = await sharedFile(rt, 'diperiksa@example.com', 'bukti');
    const { id } = (await (
      await report(rt, { targetType: 'share', targetId: share.id, category: 'malware' })
    ).json()) as { id: string };
    const held = await ops('POST', `/reports/${id}/actions`, {
      actions: ['legal_hold'],
      note: 'diminta penyidik',
    });
    expect(held.status).toBe(204);
    const blob = rt.d1.sqlite.prepare('SELECT blob_id FROM nodes WHERE id = ?').get(f.id) as {
      blob_id: string;
    };
    expect(
      rt.d1.sqlite.prepare('SELECT created_by FROM legal_holds WHERE blob_id = ?').get(blob.blob_id),
    ).toEqual({ created_by: 'relay-operator' });
    // A review token names its report; one that names anything else opens nothing.
    const forged = await createDownloadToken(
      rt.env.PREVIEW_SECRET,
      { blobId: blob.blob_id, nodeId: f.id, userId: f.id, exp: Date.now() + 60_000 },
      'a',
    );
    const res = await rt.fetch(new Request(`${new URL(rt.env.USERCONTENT_ORIGIN).origin}/p/${forged}/x.txt`));
    expect(res.status).toBe(403);
  });
});

export { APP };
