import { describe, expect, it } from 'vitest';
import { APP, jsonReq, makeRuntime } from '../helpers/runtime';
import { signIn, type Session } from '../helpers/session';
import { grantPlan, rootOf, uploadText } from '../helpers/files';
import type { DevRuntime } from '../../dev/env';

async function staff(rt: DevRuntime, email: string, role: 'admin' | 'moderator', secondFactor = true): Promise<Session> {
  const s = await signIn(rt, email);
  rt.d1.sqlite.prepare('UPDATE users SET role = ?, two_factor_enabled = ? WHERE id = ?').run(role, secondFactor ? 1 : 0, s.userId);
  return signIn(rt, email); // fresh session carries the new role
}

async function sharedFile(rt: DevRuntime, email = 'pemilik@example.com', content = 'konten bermasalah') {
  const owner = await signIn(rt, email);
  await grantPlan(rt, owner.userId);
  const root = await rootOf(owner);
  const f = await uploadText(owner, root, 'x.txt', content);
  await rt.settle();
  const share = ((await (await owner.req('POST', '/api/shares', { nodeIds: [f.id] })).json()) as { share: { id: string; url: string } }).share;
  return { owner, root, f, share };
}

const report = (rt: DevRuntime, body: Record<string, unknown>) => rt.fetch(jsonReq('POST', '/api/public/reports', body));

describe('admin access (SPEC §13.1)', () => {
  it('requires a staff role and a second factor', async () => {
    const rt = await makeRuntime();
    const user = await signIn(rt, 'biasa@example.com');
    expect((await user.req('GET', '/api/admin/whoami')).status).toBe(403);
    const no2fa = await staff(rt, 'adm1@example.com', 'admin', false);
    const r = await no2fa.req('GET', '/api/admin/whoami');
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { data: { reason: string } } }).error.data.reason).toBe('ADMIN_2FA_REQUIRED');
    const adm = await staff(rt, 'adm2@example.com', 'admin');
    expect((await adm.req('GET', '/api/admin/whoami')).status).toBe(200);
    expect((await adm.req('GET', '/api/admin/dashboard')).status).toBe(200);
    // There is no endpoint to browse a user's files
    expect((await adm.req('GET', `/api/admin/users/${user.userId}/files`)).status).toBe(404);
  });

  it('moderators cannot touch money, roles or config', async () => {
    const rt = await makeRuntime();
    const mod = await staff(rt, 'mod@example.com', 'moderator');
    const u = await signIn(rt, 'u@example.com');
    expect((await mod.req('POST', `/api/admin/users/${u.userId}/balance`, { deltaIdr: 1000, reason: 'kompensasi' })).status).toBe(403);
    expect((await mod.req('GET', '/api/admin/config')).status).toBe(403);
    expect((await mod.req('GET', '/api/admin/reports')).status).toBe(200);
  });
});

describe('user management', () => {
  it('adjusts balance and bonus quota with a mandatory reason, all audited', async () => {
    const rt = await makeRuntime();
    const adm = await staff(rt, 'adm@example.com', 'admin');
    const u = await signIn(rt, 'pelanggan@example.com');
    await rootOf(u);
    expect((await adm.req('POST', `/api/admin/users/${u.userId}/balance`, { deltaIdr: 5000, reason: '' })).status).toBe(400);
    const b = await adm.req('POST', `/api/admin/users/${u.userId}/balance`, { deltaIdr: 5000, reason: 'kompensasi gangguan' });
    expect(await b.json()).toEqual({ balanceIdr: 5000 });
    expect((await adm.req('POST', `/api/admin/users/${u.userId}/balance`, { deltaIdr: -9000, reason: 'koreksi salah' })).status).toBe(402);
    await adm.req('POST', `/api/admin/users/${u.userId}/bonus`, { bonusBytes: 2 ** 30, reason: 'bonus peluncuran' });
    const me = (await (await u.req('GET', '/api/me')).json()) as { storage: { limitBytes: number } };
    expect(me.storage.limitBytes).toBe(2 ** 30);
    const audit = (await (await adm.req('GET', '/api/admin/audit')).json()) as { items: Array<{ action: string }> };
    expect(audit.items.map((a) => a.action)).toEqual(expect.arrayContaining(['wallet.adjust', 'quota.bonus']));
    const found = (await (await adm.req('GET', '/api/admin/users?q=pelanggan')).json()) as { items: Array<{ id: string; balanceIdr: number }> };
    expect(found.items).toMatchObject([{ id: u.userId, balanceIdr: 5000 }]);
  });

  it('suspending a user signs them out and disables their links', async () => {
    const rt = await makeRuntime();
    const adm = await staff(rt, 'adm@example.com', 'admin');
    const { owner, share } = await sharedFile(rt);
    await adm.req('POST', `/api/admin/users/${owner.userId}/suspend`, { suspended: true, reason: 'spam berulang' });
    expect((await owner.req('GET', '/api/me')).status).toBe(401);
    expect((await rt.fetch(new Request(share.url))).status).toBe(410);
  });

  it('edits config and catalog prices', async () => {
    const rt = await makeRuntime();
    const adm = await staff(rt, 'adm@example.com', 'admin');
    expect((await adm.req('PUT', '/api/admin/config/min_topup_idr', { value: 'murah' })).status).toBe(400);
    expect((await adm.req('PUT', '/api/admin/config/min_topup_idr', { value: 20000 })).status).toBe(200);
    const cat = (await (await rt.fetch(jsonReq('GET', '/api/public/catalog'))).json()) as { config: { min_topup_idr: number } };
    expect(cat.config.min_topup_idr).toBe(20000);
    expect((await adm.req('PATCH', '/api/admin/catalog/plans/mini', { price_idr: 1500 })).status).toBe(204);
    expect((await adm.req('PATCH', '/api/admin/catalog/plans/mini', { code: 'hack' })).status).toBe(400);
    const plans = (await (await rt.fetch(jsonReq('GET', '/api/public/catalog'))).json()) as { plans: Array<{ code: string; priceIdr: number }> };
    expect(plans.plans.find((p) => p.code === 'mini')?.priceIdr).toBe(1500);
  });
});

describe('reports & takedown (SPEC §14.3)', () => {
  it('anonymous report → review (audited) → quarantine, disable link, blocklist → resolve', async () => {
    const rt = await makeRuntime();
    const mod = await staff(rt, 'mod@example.com', 'moderator');
    const { owner, root, f, share } = await sharedFile(rt);
    const r = await report(rt, { targetType: 'share', targetId: share.id, category: 'copyright', details: 'film bajakan' });
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: string };
    const list = (await (await mod.req('GET', '/api/admin/reports')).json()) as { items: Array<{ id: string; priority: string; slaDueAt: number; createdAt: number }> };
    expect(list.items[0]).toMatchObject({ id, priority: 'normal' });
    expect(list.items[0]!.slaDueAt - list.items[0]!.createdAt).toBe(24 * 3600_000);

    const detail = (await (await mod.req('GET', `/api/admin/reports/${id}`)).json()) as { files: Array<{ id: string }> };
    expect(detail.files.map((x) => x.id)).toEqual([f.id]);
    const { url } = (await (await mod.req('POST', `/api/admin/reports/${id}/preview`, { nodeId: f.id })).json()) as { url: string };
    expect(await (await rt.fetch(new Request(url))).text()).toBe('konten bermasalah');
    const viewed = rt.d1.sqlite.prepare("SELECT actor_id FROM audit_logs WHERE action = 'report.content_view'").all();
    expect(viewed).toEqual([{ actor_id: mod.userId }]);

    await mod.req('POST', `/api/admin/reports/${id}/actions`, { actions: ['quarantine', 'disable_links', 'blocklist'], note: 'melanggar hak cipta' });
    expect((await rt.fetch(new Request(share.url))).status).toBe(410);
    expect((await owner.req('GET', `/api/files/${f.id}/download`)).status).toBe(403);
    // Quarantined content is still reviewable by staff
    const again = (await (await mod.req('POST', `/api/admin/reports/${id}/preview`, { nodeId: f.id })).json()) as { url: string };
    expect((await rt.fetch(new Request(again.url))).status).toBe(200);
    // Same bytes can't come back
    const re = await uploadText(owner, root, 'lagi.txt', 'konten bermasalah');
    await rt.settle();
    expect(rt.d1.sqlite.prepare('SELECT status FROM nodes WHERE id = ?').get(re.id)).toEqual({ status: 'rejected' });

    await mod.req('POST', `/api/admin/reports/${id}/actions`, { actions: ['resolve'], note: 'selesai ditindak' });
    const done = (await (await mod.req('GET', '/api/admin/reports?status=resolved')).json()) as { items: Array<{ id: string }> };
    expect(done.items.map((x) => x.id)).toEqual([id]);
  });

  it('CSAM reports act immediately: link off, quarantine + legal hold, uploader frozen; deletion is refused', async () => {
    const rt = await makeRuntime();
    const adm = await staff(rt, 'adm@example.com', 'admin');
    const { owner, f, share } = await sharedFile(rt, 'pelaku@example.com', 'x');
    const r = await report(rt, { targetType: 'share', targetId: share.id, category: 'csam' });
    const { id, priority } = (await r.json()) as { id: string; priority: string };
    expect(priority).toBe('urgent');
    expect((await rt.fetch(new Request(share.url))).status).toBe(410);
    expect((await owner.req('GET', '/api/me')).status).toBe(401);
    const blobId = (rt.d1.sqlite.prepare('SELECT blob_id FROM nodes WHERE id = ?').get(f.id) as { blob_id: string }).blob_id;
    expect(rt.d1.sqlite.prepare('SELECT scan_status FROM blobs WHERE id = ?').get(blobId)).toEqual({ scan_status: 'quarantined' });
    expect(rt.d1.sqlite.prepare('SELECT COUNT(*) AS n FROM legal_holds WHERE blob_id = ?').get(blobId)).toEqual({ n: 1 });
    const del = await adm.req('POST', `/api/admin/reports/${id}/actions`, { actions: ['delete'], note: 'hapus' });
    expect(del.status).toBe(409);
    expect((await rt.fetch(jsonReq('POST', '/api/public/reports', { targetType: 'share', targetId: 'x'.repeat(64), category: 'spam' }))).status).toBe(404);
  });
});

export { APP };
