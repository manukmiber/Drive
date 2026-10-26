import { describe, expect, it } from 'vitest';
import { ContainerScanner, type Scanner } from '../../src/worker/adapters/scanner';
import { createCtx } from '../../src/worker/context';
import { processScan } from '../../src/worker/services/scan';
import { makeRuntime } from '../helpers/runtime';
import { signIn } from '../helpers/session';
import { grantPlan, pool, rootOf, uploadText } from '../helpers/files';
import { noticesOf } from '../helpers/notices';

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

describe('scan pipeline (SPEC §3, §14.2)', () => {
  it('rejects EICAR, deletes the object, releases quota, blocklists and notifies', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'virus@example.com');
    const poolId = await grantPlan(rt, s.userId);
    const root = await rootOf(s);
    const node = await uploadText(s, root, 'eicar.com', EICAR);
    const key = (
      rt.d1.sqlite
        .prepare('SELECT r2_key FROM blobs b JOIN nodes n ON n.blob_id = b.id WHERE n.id = ?')
        .get(node.id) as { r2_key: string }
    ).r2_key;
    await rt.settle();
    const row = rt.d1.sqlite
      .prepare(
        'SELECT n.status, b.scan_status, b.sha256 FROM nodes n JOIN blobs b ON b.id = n.blob_id WHERE n.id = ?',
      )
      .get(node.id) as {
      status: string;
      scan_status: string;
      sha256: string;
    };
    expect(row).toMatchObject({ status: 'rejected', scan_status: 'infected' });
    expect(await rt.env.BUCKET.head(key)).toBeNull();
    expect(pool(rt, poolId)).toMatchObject({ used_bytes: 0, reserved_bytes: 0 });
    expect(
      rt.d1.sqlite
        .prepare('SELECT COUNT(*) AS n FROM blocked_hashes WHERE sha256 = ?')
        .get(row.sha256),
    ).toEqual({ n: 1 });
    expect((await noticesOf(rt, s.userId)).map((n) => ({ type: n.type }))).toEqual([
      { type: 'file_rejected' },
    ]);
    // Rejected files can't be downloaded
    expect((await s.req('GET', `/api/files/${node.id}/download`)).status).toBe(403);
  });

  it('blocks re-uploads of a blocklisted hash even when the scanner says clean', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'block@example.com');
    await grantPlan(rt, s.userId);
    const root = await rootOf(s);
    const sha = (await import('node:crypto'))
      .createHash('sha256')
      .update('takedown-content')
      .digest('hex');
    rt.d1.sqlite
      .prepare("INSERT INTO blocked_hashes (sha256, reason, created_at) VALUES (?, 'takedown', 0)")
      .run(sha);
    const node = await uploadText(s, root, 'lagi.txt', 'takedown-content');
    await rt.settle();
    expect(rt.d1.sqlite.prepare('SELECT status FROM nodes WHERE id = ?').get(node.id)).toEqual({
      status: 'rejected',
    });
  });

  it('retries scanner errors and alerts the admin after the last attempt', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'flaky@example.com');
    await grantPlan(rt, s.userId);
    const root = await rootOf(s);
    const node = await uploadText(s, root, 'a.txt', 'abc');
    const blobId = (
      rt.d1.sqlite.prepare('SELECT blob_id FROM nodes WHERE id = ?').get(node.id) as {
        blob_id: string;
      }
    ).blob_id;
    const ctx = createCtx(rt.env);
    const broken: Scanner = {
      name: 'broken',
      scan: async () => ({
        status: 'error',
        sha256: null,
        crc32: null,
        sniffedMime: null,
        detail: 'clamd down',
      }),
    };
    ctx.adapters.scanner = broken;
    await expect(processScan(ctx, blobId)).rejects.toThrow(/clamd down/);
    await expect(processScan(ctx, blobId)).rejects.toThrow();
    expect(await processScan(ctx, blobId)).toBe('error');
    expect(rt.queues.NOTIFY_QUEUE.sent.at(-1)).toMatchObject({ type: 'admin_alert' });
    expect(rt.d1.sqlite.prepare('SELECT status FROM nodes WHERE id = ?').get(node.id)).toEqual({
      status: 'scanning',
    });
  });
});

describe('ContainerScanner adapter', () => {
  it('streams the object to the container and maps the verdict', async () => {
    const rt = await makeRuntime();
    await rt.env.BUCKET.put('u/x/b', 'hello');
    let seenBody = '';
    let seenUrl = '';
    const ns = {
      idFromName: (n: string) => n,
      get: () => ({
        fetch: async (url: string, init: RequestInit) => {
          seenUrl = url;
          seenBody = await new Response(init.body).text();
          return Response.json({
            sha256: 'ab'.repeat(32),
            crc32: 123,
            size: 5,
            head: btoa('%PDF-1.7'),
            scanned: true,
            infected: true,
            virus: 'Win.Test',
          });
        },
      }),
    } as unknown as DurableObjectNamespace;
    const r = await new ContainerScanner(rt.env.BUCKET, ns).scan({
      key: 'u/x/b',
      size: 5,
      maxScanBytes: 100,
    });
    expect(seenUrl).toContain('scan=1');
    expect(seenBody).toBe('hello');
    expect(r).toMatchObject({
      status: 'infected',
      detail: 'Win.Test',
      sniffedMime: 'application/pdf',
      crc32: 123,
    });
    const big = await new ContainerScanner(rt.env.BUCKET, ns).scan({
      key: 'u/x/b',
      size: 5,
      maxScanBytes: 1,
    });
    expect(seenUrl).toContain('scan=0');
    expect(big.status).toBe('infected');
  });
});
