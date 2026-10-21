import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MIB } from '../../src/shared/constants';
import { partSizeFor, totalPartsFor } from '../../src/worker/services/uploads';
import { APP, makeRuntime } from '../helpers/runtime';
import { signIn } from '../helpers/session';
import {
  grantPlan,
  pool,
  putPart,
  rootOf,
  simpleUpload,
  uploadText,
  type NodeJson,
} from '../helpers/files';

describe('part sizing (SPEC §5.2)', () => {
  it('clamps to 16–64 MiB and fits 600 GB in 10,000 parts', () => {
    expect(partSizeFor(1)).toBe(16 * MIB);
    expect(partSizeFor(5 * 2 ** 30)).toBe(16 * MIB);
    expect(partSizeFor(600 * 2 ** 30)).toBe(62 * MIB);
    expect(totalPartsFor(600 * 2 ** 30, partSizeFor(600 * 2 ** 30))).toBeLessThanOrEqual(10_000);
    expect(partSizeFor(10_000 * 64 * MIB)).toBe(64 * MIB);
  });
});

describe('uploads', () => {
  it('rejects uploads when the account has no quota', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'free@example.com');
    const root = await rootOf(s);
    const res = await s.req('POST', '/api/uploads', { parentId: root, name: 'a.bin', size: 10 });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({
      error: { code: 'QUOTA_FULL', data: { limitBytes: 0 } },
    });
  });

  it('never lets parallel uploads exceed the quota', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'race@example.com');
    const poolId = await grantPlan(rt, s.userId, 'mini', 100);
    const root = await rootOf(s);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        s.req('POST', '/api/uploads', { parentId: root, name: `f${i}.bin`, size: 30 }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.status === 413)).toHaveLength(7);
    expect(pool(rt, poolId)).toMatchObject({ reserved_bytes: 90, used_bytes: 0 });
  });

  it('uploads small files in one request; reservation turns into usage after the scan', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'simple@example.com');
    const poolId = await grantPlan(rt, s.userId);
    const root = await rootOf(s);
    const node = await uploadText(s, root, 'catatan.txt', 'halo zeiko');
    expect(node).toMatchObject({ name: 'catatan.txt', status: 'scanning', size: 10 });
    expect(pool(rt, poolId)).toMatchObject({ reserved_bytes: 10, used_bytes: 0 });
    await rt.settle(); // scan queue → mock scanner
    expect(pool(rt, poolId)).toMatchObject({ reserved_bytes: 0, used_bytes: 10 });
    const blob = rt.d1.sqlite
      .prepare(
        'SELECT scan_status, sha256, crc32 FROM blobs b JOIN nodes n ON n.blob_id = b.id WHERE n.id = ?',
      )
      .get(node.id) as { scan_status: string; sha256: string; crc32: number };
    expect(blob.scan_status).toBe('clean');
    expect(blob.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('runs the multipart protocol with resume and server-side assembly', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'big@example.com');
    const poolId = await grantPlan(rt, s.userId);
    const root = await rootOf(s);
    const size = 16 * MIB + 5;
    const data = new Uint8Array(size).map((_, i) => i % 251);
    const init = await s.req('POST', '/api/uploads', {
      parentId: root,
      name: 'video.mp4',
      size,
      mime: 'video/mp4',
    });
    expect(init.status).toBe(201);
    const { uploadId, partSize, totalParts } = (await init.json()) as {
      uploadId: string;
      partSize: number;
      totalParts: number;
    };
    expect({ partSize, totalParts }).toEqual({ partSize: 16 * MIB, totalParts: 2 });

    // Wrong length is rejected before touching R2.
    expect((await putPart(s, uploadId, 1, data.subarray(0, 100))).status).toBe(400);
    // Part 2 first (parallel/out-of-order is fine), then "refresh" and resume.
    expect((await putPart(s, uploadId, 2, data.subarray(partSize))).status).toBe(200);
    const status = (await (await s.req('GET', `/api/uploads/${uploadId}`)).json()) as {
      uploadedParts: number[];
    };
    expect(status.uploadedParts).toEqual([2]);
    expect((await s.req('POST', `/api/uploads/${uploadId}/complete`)).status).toBe(409); // part 1 missing
    expect((await putPart(s, uploadId, 1, data.subarray(0, partSize))).status).toBe(200);
    // Re-uploading a part overwrites it (idempotent).
    expect((await putPart(s, uploadId, 1, data.subarray(0, partSize))).status).toBe(200);

    const done = await s.req('POST', `/api/uploads/${uploadId}/complete`);
    expect(done.status).toBe(200);
    const { node } = (await done.json()) as { node: NodeJson };
    expect(node).toMatchObject({ name: 'video.mp4', size, status: 'scanning' });
    // complete is idempotent
    expect((await s.req('POST', `/api/uploads/${uploadId}/complete`)).status).toBe(200);

    const key = (
      rt.d1.sqlite.prepare('SELECT r2_key FROM uploads WHERE id = ?').get(uploadId) as {
        r2_key: string;
      }
    ).r2_key;
    expect(key).toMatch(new RegExp(`^u/${s.userId}/[0-9A-Z]{26}$`));
    const obj = (await rt.env.BUCKET.get(key)) as R2ObjectBody;
    const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
    expect(sha(new Uint8Array(await obj.arrayBuffer()))).toBe(sha(data));
    await rt.settle();
    expect(pool(rt, poolId)).toMatchObject({ used_bytes: size, reserved_bytes: 0 });
  });

  it('aborts and expires uploads, releasing the reservation', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'abort@example.com');
    const poolId = await grantPlan(rt, s.userId);
    const root = await rootOf(s);
    const a = (await (
      await s.req('POST', '/api/uploads', { parentId: root, name: 'a', size: 20 * MIB })
    ).json()) as { uploadId: string; nodeId: string };
    const b = (await (
      await s.req('POST', '/api/uploads', { parentId: root, name: 'b', size: 20 * MIB })
    ).json()) as { uploadId: string };
    expect(pool(rt, poolId).reserved_bytes).toBe(40 * MIB);

    expect((await s.req('DELETE', `/api/uploads/${a.uploadId}`)).status).toBe(204);
    expect(pool(rt, poolId).reserved_bytes).toBe(20 * MIB);
    expect(
      rt.d1.sqlite.prepare('SELECT COUNT(*) AS n FROM nodes WHERE id = ?').get(a.nodeId),
    ).toEqual({ n: 0 });
    // aborting twice does not release twice
    await s.req('DELETE', `/api/uploads/${a.uploadId}`);
    expect(pool(rt, poolId).reserved_bytes).toBe(20 * MIB);

    rt.d1.sqlite.prepare('UPDATE uploads SET expires_at = 0 WHERE id = ?').run(b.uploadId);
    expect((await putPart(s, b.uploadId, 1, new Uint8Array(16 * MIB))).status).toBe(409);
    await rt.runCron('0 * * * *');
    expect(pool(rt, poolId).reserved_bytes).toBe(0);
    const st = (await (await s.req('GET', `/api/uploads/${b.uploadId}`)).json()) as {
      status: string;
    };
    expect(st.status).toBe('expired');
  });

  it('handles name conflicts: error, keep both, replace', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'names@example.com');
    await grantPlan(rt, s.userId);
    const root = await rootOf(s);
    const first = await uploadText(s, root, 'Laporan.pdf', 'v1');
    const clash = await simpleUpload(s, root, 'laporan.PDF', 'v2');
    expect(clash.status).toBe(409);
    expect(await clash.json()).toMatchObject({
      error: { code: 'NAME_CONFLICT', data: { existingId: first.id } },
    });

    const both = (await (
      await simpleUpload(s, root, 'Laporan.pdf', 'v2', { onConflict: 'rename' })
    ).json()) as { node: NodeJson };
    expect(both.node.name).toBe('Laporan (1).pdf');

    const repl = (await (
      await simpleUpload(s, root, 'Laporan.pdf', 'v3', { onConflict: 'replace' })
    ).json()) as { node: NodeJson };
    expect(repl.node.name).toBe('Laporan.pdf');
    const old = rt.d1.sqlite.prepare('SELECT trashed_at FROM nodes WHERE id = ?').get(first.id) as {
      trashed_at: number | null;
    };
    expect(old.trashed_at).not.toBeNull();
  });

  it('rejects files above the plan limit and bad names', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'limits@example.com');
    await grantPlan(rt, s.userId, 'mini');
    const root = await rootOf(s);
    const tooBig = await s.req('POST', '/api/uploads', {
      parentId: root,
      name: 'x',
      size: 4 * 2 ** 30,
    });
    expect(tooBig.status).toBe(413);
    expect(await tooBig.json()).toMatchObject({ error: { code: 'FILE_TOO_LARGE' } });
    const bad = await s.req('POST', '/api/uploads', { parentId: root, name: '..', size: 1 });
    expect(await bad.json()).toMatchObject({ error: { code: 'INVALID_NAME' } });
  });

  it('blocks uploads into folders the user cannot see (IDOR)', async () => {
    const rt = await makeRuntime();
    const alice = await signIn(rt, 'alice@example.com');
    const bob = await signIn(rt, 'bob@example.com');
    await grantPlan(rt, alice.userId);
    await grantPlan(rt, bob.userId);
    const aliceRoot = await rootOf(alice);
    const res = await bob.req('POST', '/api/uploads', {
      parentId: aliceRoot,
      name: 'x.txt',
      size: 1,
    });
    expect(res.status).toBe(404);
    const init = (await (
      await alice.req('POST', '/api/uploads', { parentId: aliceRoot, name: 'y', size: 20 * MIB })
    ).json()) as {
      uploadId: string;
    };
    expect((await bob.req('GET', `/api/uploads/${init.uploadId}`)).status).toBe(404);
    expect((await putPart(bob, init.uploadId, 1, new Uint8Array(16 * MIB))).status).toBe(404);
    expect((await bob.req('POST', `/api/uploads/${init.uploadId}/complete`)).status).toBe(404);
    expect((await bob.req('DELETE', `/api/uploads/${init.uploadId}`)).status).toBe(404);
    void APP;
  });
});
