import { describe, expect, it } from 'vitest';
import { makeRuntime } from '../helpers/runtime';

const MiB = 1024 * 1024;

describe('D1 shim', () => {
  it('reports meta.changes for conditional updates (quota reservation pattern)', async () => {
    const rt = await makeRuntime();
    const db = rt.env.DB;
    await db
      .prepare(`INSERT INTO users (id, email, created_at, updated_at) VALUES ('u', 'u@x', 0, 0)`)
      .run();
    await db
      .prepare(
        `INSERT INTO storage_pools (id, owner_type, owner_id, limit_bytes, updated_at) VALUES ('p', 'user', 'u', 100, 0)`,
      )
      .run();
    const reserve = (n: number) =>
      db
        .prepare(
          `UPDATE storage_pools SET reserved_bytes = reserved_bytes + ?1
           WHERE id = 'p' AND used_bytes + reserved_bytes + ?1 <= limit_bytes`,
        )
        .bind(n)
        .run();
    expect((await reserve(60)).meta.changes).toBe(1);
    expect((await reserve(60)).meta.changes).toBe(0);
    expect((await reserve(40)).meta.changes).toBe(1);
  });

  it('rolls back a failing batch atomically', async () => {
    const rt = await makeRuntime();
    const db = rt.env.DB;
    await expect(
      db.batch([
        db.prepare(`INSERT INTO counters (name, value) VALUES ('a', 1)`),
        db.prepare(`INSERT INTO counters (name, value) VALUES ('a', 2)`),
      ]),
    ).rejects.toThrow(/UNIQUE/);
    expect(await db.prepare(`SELECT COUNT(*) AS n FROM counters`).first('n')).toBe(0);
  });

  it('rejects undefined bindings like D1', async () => {
    const rt = await makeRuntime();
    expect(() => rt.env.DB.prepare('SELECT ?').bind(undefined)).toThrow(/undefined/);
  });
});

describe('R2 shim', () => {
  it('supports ranged reads and conditional gets', async () => {
    const rt = await makeRuntime();
    const b = rt.env.BUCKET;
    const put = await b.put('k', 'hello world', { httpMetadata: { contentType: 'text/plain' } });
    expect(put?.size).toBe(11);
    const part = await b.get('k', { range: { offset: 6, length: 5 } });
    expect(await (part as R2ObjectBody).text()).toBe('world');
    const suffix = await b.get('k', { range: { suffix: 3 } });
    expect(await (suffix as R2ObjectBody).text()).toBe('rld');
    const notModified = await b.get('k', { onlyIf: { etagDoesNotMatch: put!.etag } });
    expect(notModified && 'body' in notModified).toBe(false);
  });

  it('never hands a reader half of an overwrite (reads race the index flush, ADR-077)', async () => {
    const rt = await makeRuntime();
    const b = rt.env.BUCKET;
    const versions = Array.from({ length: 8 }, (_, i) => `${String(i)}`.repeat(1000 * (i + 1)));
    await b.put('idx', versions[0]!);
    const reads: Promise<string | null>[] = [];
    const writes = versions.slice(1).map(async (v) => {
      reads.push(b.get('idx').then((o) => (o && 'text' in o ? o.text() : null)));
      await b.put('idx', v);
      reads.push(b.get('idx').then((o) => (o && 'text' in o ? o.text() : null)));
    });
    await Promise.all(writes);
    for (const text of await Promise.all(reads)) expect(versions).toContain(text);
    expect(await ((await b.get('idx')) as R2ObjectBody).text()).toBe(versions[7]);
    await b.delete('idx');
    expect(await b.get('idx')).toBeNull();
  });

  it('enforces uniform multipart part sizes', async () => {
    const rt = await makeRuntime();
    const b = rt.env.BUCKET;
    const mpu = await b.createMultipartUpload('big');
    const p1 = await mpu.uploadPart(1, new Uint8Array(5 * MiB));
    const p2 = await mpu.uploadPart(2, new Uint8Array(6 * MiB));
    const p3 = await mpu.uploadPart(3, new Uint8Array(10));
    await expect(mpu.complete([p1, p2, p3])).rejects.toThrow(/same size/);

    const ok = await b.createMultipartUpload('big2');
    const q1 = await ok.uploadPart(1, new Uint8Array(5 * MiB).fill(1));
    const q2 = await b
      .resumeMultipartUpload('big2', ok.uploadId)
      .uploadPart(2, new Uint8Array(3).fill(2));
    const obj = await ok.complete([q2, q1]);
    expect(obj.size).toBe(5 * MiB + 3);
    expect(obj.etag).toMatch(/-2$/);
    const tail = (await b.get('big2', { range: { offset: 5 * MiB } })) as R2ObjectBody;
    expect([...new Uint8Array(await tail.arrayBuffer())]).toEqual([2, 2, 2]);
  });

  it('rejects parts below 5 MiB except the last', async () => {
    const rt = await makeRuntime();
    const mpu = await rt.env.BUCKET.createMultipartUpload('small');
    const a = await mpu.uploadPart(1, new Uint8Array(1024));
    const b = await mpu.uploadPart(2, new Uint8Array(1024));
    await expect(mpu.complete([a, b])).rejects.toThrow(/EntityTooSmall/);
  });
});

describe('Queue shim', () => {
  it('retries failed messages and dead-letters after max retries', async () => {
    const rt = await makeRuntime();
    const q = rt.queues.CLEANUP_QUEUE;
    let calls = 0;
    q.setConsumer(async (batch) => {
      for (const m of batch.messages) {
        calls++;
        m.retry();
      }
    });
    await q.send({ type: 'delete_blob', blobId: 'x' });
    await q.drain();
    expect(calls).toBe(4); // first attempt + 3 retries
    expect(q.dead).toHaveLength(1);
  });
});
