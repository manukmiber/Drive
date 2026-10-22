// SPEC §14.1 "Test IDOR untuk setiap endpoint": a second account replays every ID-taking endpoint
// against the first account's objects. Each call must fail (4xx) and nothing may change.
import { describe, expect, it } from 'vitest';
import { createCtx } from '../../src/worker/context';
import { reviewCreative } from '../../src/worker/services/ads';
import { APP, makeRuntime } from '../helpers/runtime';
import { signIn } from '../helpers/session';
import { createFolder, grantPlan, rootOf, uploadText } from '../helpers/files';

const WEBP = (() => {
  const b = new Uint8Array(2000);
  const v = new DataView(b.buffer);
  b.set(new TextEncoder().encode('RIFF'), 0);
  v.setUint32(4, b.length - 8, true);
  b.set(new TextEncoder().encode('WEBPVP8X'), 8);
  v.setUint32(16, 10, true);
  b.set([0x57, 0x02, 0, 0x57, 0x02, 0], 24); // 600×600
  return b;
})();

describe('IDOR (SPEC §14.1)', () => {
  it("rejects every endpoint replayed against another user's IDs", async () => {
    const rt = await makeRuntime();
    const a = await signIn(rt, 'korban@example.com');
    const b = await signIn(rt, 'penyerang@example.com');
    await grantPlan(rt, a.userId);
    await grantPlan(rt, b.userId);
    const aRoot = await rootOf(a);
    const bRoot = await rootOf(b);

    // Victim's objects.
    const folder = await createFolder(a, aRoot, 'Pribadi');
    const file = await uploadText(a, folder.id, 'ktp.txt', 'data rahasia');
    await rt.settle();
    const share = (
      (await (await a.req('POST', '/api/shares', { nodeIds: [file.id] })).json()) as {
        share: { id: string };
      }
    ).share;
    const upload = {
      id: (
        (await (
          await a.req('POST', '/api/uploads', {
            parentId: folder.id,
            name: 'besar.bin',
            size: 20 * 1024 * 1024,
          })
        ).json()) as { uploadId: string }
      ).uploadId,
    };
    rt.d1.sqlite
      .prepare(
        `INSERT INTO credit_ledger (id, user_id, delta, remaining, source, ref, created_at) VALUES ('g', ?, 5, 5, 'pack', 't', 0)`,
      )
      .run(a.userId);
    const job = (await (
      await a.req('POST', '/api/compress/standalone', {
        name: 'a.jpg',
        size: 10,
        mime: 'image/jpeg',
      })
    ).json()) as { jobId: string };
    await a.req('PUT', '/api/advertiser', {
      businessName: 'Toko A',
      kind: 'umkm',
      phone: '081234567890',
    });
    const creative = (await (
      await a.req('POST', '/api/advertiser/creatives', {
        title: 'Toko A',
        body: 'Promo',
        ctaType: 'web',
        ctaValue: 'https://example.com',
        category: 'lainnya',
      })
    ).json()) as { id: string };
    await a.req('PUT', `/api/advertiser/creatives/${creative.id}/image`, undefined, {
      body: WEBP,
      headers: { 'content-type': 'image/webp', 'content-length': String(WEBP.length) },
    });
    await a.req('POST', `/api/advertiser/creatives/${creative.id}/submit`);
    await reviewCreative(createCtx(rt.env), b.userId, creative.id, 'approve', '');
    const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
    const booking = (await (
      await a.req('POST', '/api/advertiser/bookings', {
        creativeId: creative.id,
        areaCode: 'ID',
        placement: 'explorer_sidebar',
        dates: [today],
      })
    ).json()) as { bookingIds: string[] };
    rt.d1.sqlite
      .prepare(`INSERT INTO wallets (user_id, balance_idr, updated_at) VALUES (?, 100000, 0)`)
      .run(b.userId);
    rt.d1.sqlite
      .prepare(
        `INSERT INTO notifications (id, user_id, type, payload_json, created_at) VALUES ('n1', ?, 'quota', '{}', 0)`,
      )
      .run(a.userId);
    const invoice = 'inv_a';
    rt.d1.sqlite
      .prepare(
        `INSERT INTO invoices (id, number, user_id, lines_json, subtotal_idr, tax_idr, total_idr, status, issued_at) VALUES (?, 'ZK-X', ?, '[]', 0, 0, 0, 'paid', 0)`,
      )
      .run(invoice, a.userId);

    const snapshot = () =>
      JSON.stringify([
        rt.d1.sqlite
          .prepare(
            'SELECT id, parent_id, name, trashed_at, status, blob_id FROM nodes WHERE owner_id = ? ORDER BY id',
          )
          .all(a.userId),
        rt.d1.sqlite
          .prepare('SELECT id, revoked_at, expires_at, password_hash FROM shares ORDER BY id')
          .all(),
        rt.d1.sqlite
          .prepare('SELECT id, status FROM uploads WHERE user_id = ? ORDER BY id')
          .all(a.userId),
        rt.d1.sqlite
          .prepare('SELECT id, title, status, image_key FROM ad_creatives ORDER BY id')
          .all(),
        rt.d1.sqlite.prepare('SELECT id, status FROM ad_bookings ORDER BY id').all(),
        rt.d1.sqlite
          .prepare('SELECT id, read_at FROM notifications WHERE user_id = ?')
          .all(a.userId),
        rt.d1.sqlite.prepare('SELECT node_id FROM node_stars WHERE user_id = ?').all(b.userId),
      ]);
    const before = snapshot();
    const body = (bytes: Uint8Array) => ({
      body: bytes,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(bytes.length),
      },
    });

    const attempts: Array<[string, string, unknown?, RequestInit?]> = [
      ['GET', `/api/nodes/${file.id}`],
      ['GET', `/api/nodes/${folder.id}/children`],
      ['PATCH', `/api/nodes/${file.id}`, { name: 'dicuri.txt' }],
      ['POST', '/api/nodes/move', { ids: [file.id], targetId: bRoot }],
      [
        'POST',
        '/api/nodes/move',
        { ids: [(await uploadText(b, bRoot, 'b.txt', 'x')).id], targetId: folder.id },
      ],
      ['POST', `/api/nodes/${file.id}/copy`, { targetId: bRoot }],
      ['POST', '/api/nodes/trash', { ids: [file.id] }],
      ['POST', '/api/nodes/delete', { ids: [file.id] }],
      ['PUT', `/api/nodes/${file.id}/star`],
      ['GET', `/api/files/${file.id}/preview`],
      ['GET', `/api/files/${file.id}/download`],
      ['GET', `/api/files/${file.id}/thumbnail`],
      ['POST', '/api/folders', { parentId: folder.id, name: 'x' }],
      ['POST', '/api/uploads', { parentId: folder.id, name: 'x.bin', size: 10 }],
      [
        'PUT',
        `/api/uploads/${upload.id}/parts/1`,
        undefined,
        body(new Uint8Array(8 * 1024 * 1024)),
      ],
      ['GET', `/api/uploads/${upload.id}`],
      ['POST', `/api/uploads/${upload.id}/complete`, { parts: [] }],
      ['DELETE', `/api/uploads/${upload.id}`],
      ['POST', '/api/shares', { nodeIds: [file.id] }],
      ['GET', `/api/shares/${share.id}`],
      ['PATCH', `/api/shares/${share.id}`, { password: 'punyaku123' }],
      ['DELETE', `/api/shares/${share.id}`],
      ['POST', `/api/shares/${share.id}/regenerate`],
      ['POST', `/api/shares/${share.id}/sends`, { mode: 'email', recipients: ['x@example.com'] }],
      ['GET', `/api/billing/invoices/${invoice}`],
      ['POST', '/api/compress', { nodeIds: [file.id] }],
      ['PUT', `/api/compress/standalone/${job.jobId}/parts/1`, undefined, body(new Uint8Array(10))],
      [
        'POST',
        `/api/compress/standalone/${job.jobId}/complete`,
        { parts: [{ partNumber: 1, etag: 'x' }] },
      ],
      ['GET', `/api/compress/standalone/${job.jobId}/result`],
      ['POST', '/api/archives', { nodeIds: [folder.id] }],
      ['POST', '/api/archives/estimate', { nodeIds: [folder.id] }],
      [
        'PATCH',
        `/api/advertiser/creatives/${creative.id}`,
        {
          title: 'x',
          body: 'y',
          ctaType: 'web',
          ctaValue: 'https://evil.example',
          category: 'lainnya',
        },
      ],
      [
        'PUT',
        `/api/advertiser/creatives/${creative.id}/image`,
        undefined,
        {
          body: WEBP,
          headers: { 'content-type': 'image/webp', 'content-length': String(WEBP.length) },
        },
      ],
      ['POST', `/api/advertiser/creatives/${creative.id}/submit`],
      ['GET', `/api/advertiser/creatives/${creative.id}/image`],
      [
        'POST',
        '/api/advertiser/bookings',
        { creativeId: creative.id, areaCode: 'ID', placement: 'explorer_sidebar', dates: [today] },
      ],
      [
        'POST',
        '/api/advertiser/bookings/checkout',
        { bookingIds: booking.bookingIds, method: 'saldo' },
      ],
      ['POST', '/api/advertiser/bookings/cancel', { bookingIds: booking.bookingIds }],
      ['DELETE', `/api/family/members/${a.userId}`],
    ];
    // B must be an advertiser for the advertiser endpoints to get past "not an advertiser".
    await b.req('PUT', '/api/advertiser', {
      businessName: 'Toko B',
      kind: 'umkm',
      phone: '081298765432',
    });

    const leaks: string[] = [];
    for (const [method, path, json, init] of attempts) {
      const res = await b.req(method, path, json, init);
      if (res.status < 400 || res.status >= 500) leaks.push(`${method} ${path} → ${res.status}`);
    }
    // Marking someone else's notifications read is a silent no-op (204), but must not touch theirs.
    expect((await b.req('POST', '/api/notifications/read', { ids: ['n1'] })).status).toBe(204);
    await rt.settle();

    expect(leaks).toEqual([]);
    expect(JSON.parse(snapshot())).toEqual(JSON.parse(before));
    // Guessing the anonymous download path without a signed token never yields the content.
    for (const path of [`/d/${file.id}`, `/d/${file.id}/ktp.txt`, `/d/x.y.z/ktp.txt`]) {
      expect(await (await rt.fetch(new Request(`${APP}${path}`))).text()).not.toContain(
        'data rahasia',
      );
    }
  });
});
