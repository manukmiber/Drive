// SPEC §14.1 "Test IDOR untuk setiap endpoint": a second account replays every ID-taking endpoint
// against the first account's objects. Each call must fail (4xx) and nothing may change.
import { describe, expect, it } from 'vitest';
import { APP, makeRuntime } from '../helpers/runtime';
import { signIn } from '../helpers/session';
import { imageBody, operator } from '../helpers/ops';
import { createFolder, grantPlan, rootOf, uploadText } from '../helpers/files';
import { fileNotice, noticesOf } from '../helpers/notices';

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
    // Two ordinary people; the operator enters A's ad (ADR-043) and B tries to reach it.
    const a = await signIn(rt, 'korban@example.com');
    const b = await signIn(rt, 'penyerang@example.com');
    const op = operator(rt);
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
    await op('PUT', '/ads/advertiser', {
      email: 'korban@example.com',
      businessName: 'Toko A',
      kind: 'umkm',
      phone: '081234567890',
    });
    const creative = (await (
      await op('POST', '/ads/creatives', {
        advertiserId: a.userId,
        title: 'Toko A',
        body: 'Promo',
        ctaType: 'web',
        ctaValue: 'https://example.com',
        category: 'lainnya',
      })
    ).json()) as { id: string };
    await op('PUT', `/ads/creatives/${creative.id}/image`, imageBody(a.userId, WEBP));
    const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
    const campaign = (await (
      await op('POST', '/ads/campaigns', {
        creativeId: creative.id,
        scope: 'national',
        startDate: today,
        days: 1,
      })
    ).json()) as { id: string };
    await op('POST', `/ads/${creative.id}/review`, {
      decision: 'approve',
      reason: '',
    });
    rt.d1.sqlite
      .prepare(`INSERT INTO wallets (user_id, balance_idr, updated_at) VALUES (?, 100000, 0)`)
      .run(b.userId);
    await fileNotice(rt, a.userId, { id: 'n1' });
    // Zeiko S3 (ADR-044): both have an account; A has a key and a bucket.
    for (const id of [a.userId, b.userId])
      rt.d1.sqlite
        .prepare(
          `INSERT INTO s3_accounts (user_id, status, limit_bytes, created_at, updated_at) VALUES (?, 'active', 1000000, 0, 0)`,
        )
        .run(id);
    const s3Key = (
      (await (await a.req('POST', '/api/s3/keys', { label: 'A' })).json()) as {
        key: { id: string };
      }
    ).key;
    expect((await a.req('POST', '/api/s3/buckets', { name: 'milik-a' })).status).toBe(201);
    expect((await b.req('POST', '/api/s3/buckets', { name: 'milik-b' })).status).toBe(201);
    // S4: A's upload in parts from the /s3 page.
    const started = await a.req('POST', '/api/s3/buckets/milik-a/uploads', {
      key: 'besar.bin',
      size: 10,
    });
    expect(started.status).toBe(201);
    const aUpload = ((await started.json()) as { uploadId: string }).uploadId;
    // ADR-061: A's access token.
    const aToken = (
      (await (
        await a.req('POST', '/api/tokens', {
          name: 'A',
          scopes: ['drive.read'],
          expiresInDays: null,
        })
      ).json()) as { info: { id: string } }
    ).info;
    const payment = 'pay_a';
    rt.d1.sqlite
      .prepare(
        `INSERT INTO payments (id, user_id, provider, provider_ref, method, amount_idr, fee_idr, status, purpose, created_at, updated_at)
         VALUES (?, ?, 'mock', 'mock_pay_a', 'qris', 1000, 0, 'pending', 'direct', 0, 0)`,
      )
      .run(payment, a.userId);

    const snapshot = async () =>
      JSON.stringify([
        rt.d1.sqlite
          .prepare(
            'SELECT id, parent_id, name, trashed_at, status, blob_id, decor_color, decor_icon, decor_cover_id FROM nodes WHERE owner_id = ? ORDER BY id',
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
        rt.d1.sqlite.prepare('SELECT id, status FROM ad_campaigns ORDER BY id').all(),
        (await noticesOf(rt, a.userId)).map((n) => ({ id: n.id, read_at: n.read_at })),
        rt.d1.sqlite.prepare('SELECT node_id FROM node_stars WHERE user_id = ?').all(b.userId),
        rt.d1.sqlite.prepare('SELECT id, revoked_at FROM s3_keys ORDER BY id').all(),
        rt.d1.sqlite.prepare('SELECT id, key FROM s3_uploads ORDER BY id').all(),
        rt.d1.sqlite.prepare('SELECT upload_id, part_number FROM s3_upload_parts').all(),
        rt.d1.sqlite
          .prepare('SELECT id, user_id, revoked_at, scopes FROM api_tokens ORDER BY id')
          .all(),
        rt.d1.sqlite
          .prepare(
            'SELECT name, user_id, public, cors_json, logging_json FROM s3_buckets ORDER BY name',
          )
          .all(),
      ]);
    // B's own folder, to try A's photo as its cover (ADR-058).
    const bFolder = await createFolder(b, bRoot, 'Punya B');
    const before = await snapshot();
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
      ['POST', '/api/nodes/decor', { ids: [folder.id], color: 'red' }],
      ['POST', '/api/nodes/decor', { ids: [bFolder.id], coverId: file.id }],
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
      ['GET', `/api/billing/payments/${payment}`],
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
      ['POST', '/api/files/download-plan', { nodeIds: [folder.id] }],
      ['POST', '/api/files/download-plan', { nodeIds: [file.id] }],
      ['GET', `/api/advertiser/creatives/${creative.id}/image`],
      // The operator's side is the relay's ops key, never a session (ADR-057).
      ['POST', `/api/ops/ads/campaigns/${campaign.id}/send-payment`, {}],
      ['GET', `/api/ops/ads/advertiser?email=korban@example.com`],
      ['POST', `/api/ops/ads/${creative.id}/suspend`, { severe: true, reason: 'iseng saja' }],
      ['GET', `/api/ops/ads/${creative.id}/image`],
      ['DELETE', `/api/family/members/${a.userId}`],
      ['DELETE', `/api/s3/keys/${s3Key.id}`],
      ['PATCH', '/api/s3/buckets/milik-a', { public: true }],
      ['DELETE', '/api/s3/buckets/milik-a'],
      ['POST', '/api/s3/buckets', { name: 'milik-a' }],
      // ADR-055: A's bucket from the /s3 page.
      ['GET', '/api/s3/buckets/milik-a/objects'],
      ['POST', '/api/s3/buckets/milik-a/objects/link', { key: 'x.txt' }],
      ['POST', '/api/s3/buckets/milik-a/objects/delete', { keys: ['x.txt'] }],
      ['PUT', '/api/s3/buckets/milik-a/objects?key=x.txt', undefined, body(new Uint8Array(3))],
      ['GET', '/api/s3/buckets/milik-a/cors'],
      [
        'PUT',
        '/api/s3/buckets/milik-a/cors',
        { rules: [{ allowedOrigins: ['*'], allowedMethods: ['GET'] }] },
      ],
      ['DELETE', '/api/s3/buckets/milik-a/cors'],
      // ADR-060: A's statistics and access logging; B cannot point A's logs at its own bucket.
      ['GET', '/api/s3/buckets/milik-a/stats'],
      ['PUT', '/api/s3/buckets/milik-a/logging', { target: 'milik-b', prefix: '' }],
      ['DELETE', '/api/s3/buckets/milik-a/logging'],
      // S4: A's upload in parts, by A's bucket or through B's own.
      ['POST', '/api/s3/buckets/milik-a/uploads', { key: 'b.bin', size: 10 }],
      [
        'PUT',
        `/api/s3/buckets/milik-a/uploads/${aUpload}/parts/1?key=besar.bin`,
        undefined,
        body(new Uint8Array(10)),
      ],
      [
        'PUT',
        `/api/s3/buckets/milik-b/uploads/${aUpload}/parts/1?key=besar.bin`,
        undefined,
        body(new Uint8Array(10)),
      ],
      ['GET', `/api/s3/buckets/milik-a/uploads/${aUpload}?key=besar.bin`],
      ['GET', `/api/s3/buckets/milik-b/uploads/${aUpload}?key=besar.bin`],
      [
        'POST',
        `/api/s3/buckets/milik-b/uploads/${aUpload}/complete`,
        { key: 'besar.bin', parts: [{ partNumber: 1, etag: 'x' }] },
      ],
      ['DELETE', `/api/s3/buckets/milik-a/uploads/${aUpload}?key=besar.bin`],
      ['DELETE', `/api/s3/buckets/milik-b/uploads/${aUpload}?key=besar.bin`],
      // ADR-061: A's token cannot be revoked by B.
      ['DELETE', `/api/tokens/${aToken.id}`],
    ];

    const leaks: string[] = [];
    for (const [method, path, json, init] of attempts) {
      const res = await b.req(method, path, json, init);
      if (res.status < 400 || res.status >= 500) leaks.push(`${method} ${path} → ${res.status}`);
    }
    // Marking someone else's notifications read is a silent no-op (204), but must not touch theirs.
    expect((await b.req('POST', '/api/notifications/read', { ids: ['n1'] })).status).toBe(204);
    await rt.settle();

    expect(leaks).toEqual([]);
    expect(JSON.parse(await snapshot())).toEqual(JSON.parse(before));
    // The index a person pulls first (R2, ADR-077) is only ever their own.
    const bIndex = await (await b.req('GET', '/api/drive/index')).text();
    for (const secret of [folder.id, file.id, aRoot, 'ktp.txt', 'Pribadi'])
      expect(bIndex).not.toContain(secret);
    // Guessing the anonymous download path without a signed token never yields the content.
    for (const path of [`/d/${file.id}`, `/d/${file.id}/ktp.txt`, `/d/x.y.z/ktp.txt`]) {
      expect(await (await rt.fetch(new Request(`${APP}${path}`))).text()).not.toContain(
        'data rahasia',
      );
    }
  });
});
