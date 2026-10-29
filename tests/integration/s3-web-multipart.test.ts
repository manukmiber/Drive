// Big files from the /s3 page, in parts through the app (S4, ADR-075): start, parts in any order and
// again, what is stored, finish, cancel; quota, limits, the account's billing state, and owners.
import { CreateBucketCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { invalidateConfigMemo } from '../../src/worker/services/config';
import { webPartSize } from '../../src/worker/services/s3-browse';
import { s3Setup, usage } from '../helpers/s3';
import type { Session } from '../helpers/session';
import type { DevRuntime } from '../../dev/env';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

function bytes(n: number, seed: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff;
  return b;
}

const binary = (b: Uint8Array) => ({
  body: b,
  headers: { 'content-type': 'application/octet-stream', 'content-length': String(b.length) },
});

async function start(s: Session, bucket: string, key: string, size: number) {
  const res = await s.req('POST', `/api/s3/buckets/${bucket}/uploads`, { key, size });
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()) as { uploadId: string; partSize: number; parts: number };
}

function part(s: Session, bucket: string, id: string, key: string, n: number, b: Uint8Array) {
  return s.req(
    'PUT',
    `/api/s3/buckets/${bucket}/uploads/${id}/parts/${n}?key=${encodeURIComponent(key)}`,
    undefined,
    binary(b),
  );
}

async function etagOf(res: Response): Promise<string> {
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { etag: string }).etag;
}

function setConfig(rt: DevRuntime, key: string, value: unknown) {
  rt.d1.sqlite
    .prepare(
      `INSERT INTO app_config (key, value_json, updated_by, updated_at) VALUES (?, ?, 'test', 0)
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
    )
    .run(key, JSON.stringify(value));
}

async function reloadConfig(rt: DevRuntime) {
  await rt.env.CONFIG_KV.delete('config:v1');
  invalidateConfigMemo(rt.env);
}

describe('uploads in parts from the /s3 page (S4, ADR-075)', () => {
  it('sends parts in any order and again, carries on from what is stored, and the object is whole', async () => {
    const { rt, client, user } = await s3Setup({ limitBytes: GIB });
    await client.send(new CreateBucketCommand({ Bucket: 'besar' }));
    setConfig(rt, 's3_web_part_bytes', 5 * MIB);
    await reloadConfig(rt);
    const key = 'video/film.bin';
    const size = 5 * MIB + 10;
    const up = await start(user, 'besar', key, size);
    expect(up).toMatchObject({ partSize: 5 * MIB, parts: 2 });

    const whole = bytes(size, 7);
    const tail = whole.subarray(5 * MIB);
    // The last part first; the first part twice (the second one counts).
    const e2 = await etagOf(await part(user, 'besar', up.uploadId, key, 2, tail));
    await etagOf(await part(user, 'besar', up.uploadId, key, 1, bytes(5 * MIB, 99)));
    const e1 = await etagOf(
      await part(user, 'besar', up.uploadId, key, 1, whole.subarray(0, 5 * MIB)),
    );
    expect(usage(rt, user.userId).reserved).toBe(size);

    const listed = await user.req(
      'GET',
      `/api/s3/buckets/besar/uploads/${up.uploadId}?key=${encodeURIComponent(key)}`,
    );
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { parts: unknown[] }).parts).toEqual([
      { partNumber: 1, etag: e1, size: 5 * MIB },
      { partNumber: 2, etag: e2, size: 10 },
    ]);

    const done = await user.req('POST', `/api/s3/buckets/besar/uploads/${up.uploadId}/complete`, {
      key,
      parts: [
        { partNumber: 1, etag: e1 },
        { partNumber: 2, etag: e2 },
      ],
    });
    expect(done.status, await done.clone().text()).toBe(201);
    expect(((await done.json()) as { object: { size: number } }).object.size).toBe(size);
    expect(usage(rt, user.userId)).toEqual({ used: size, reserved: 0 });

    const got = await client.send(new GetObjectCommand({ Bucket: 'besar', Key: key }));
    const back = new Uint8Array(await got.Body!.transformToByteArray());
    expect(back.length).toBe(size);
    expect(Buffer.compare(Buffer.from(back), Buffer.from(whole))).toBe(0);
    // Finished uploads are gone.
    expect(
      (
        await user.req(
          'GET',
          `/api/s3/buckets/besar/uploads/${up.uploadId}?key=${encodeURIComponent(key)}`,
        )
      ).status,
    ).toBe(404);
  });

  it('refuses parts out of order or missing at the end, and cancel gives the storage back', async () => {
    const { rt, client, user } = await s3Setup({ limitBytes: GIB });
    await client.send(new CreateBucketCommand({ Bucket: 'arsip' }));
    setConfig(rt, 's3_web_part_bytes', 5 * MIB);
    await reloadConfig(rt);
    const up = await start(user, 'arsip', 'a.bin', 5 * MIB + 1);
    const e1 = await etagOf(await part(user, 'arsip', up.uploadId, 'a.bin', 1, bytes(5 * MIB, 1)));
    const e2 = await etagOf(await part(user, 'arsip', up.uploadId, 'a.bin', 2, bytes(1, 2)));
    const complete = (parts: unknown) =>
      user.req('POST', `/api/s3/buckets/arsip/uploads/${up.uploadId}/complete`, {
        key: 'a.bin',
        parts,
      });
    const order = await complete([
      { partNumber: 2, etag: e2 },
      { partNumber: 1, etag: e1 },
    ]);
    expect(order.status).toBe(400);
    const wrong = await complete([{ partNumber: 1, etag: 'nope' }]);
    expect(wrong.status).toBe(400);
    expect(usage(rt, user.userId).reserved).toBe(5 * MIB + 1);

    const gone = await user.req('DELETE', `/api/s3/buckets/arsip/uploads/${up.uploadId}?key=a.bin`);
    expect(gone.status).toBe(204);
    expect(usage(rt, user.userId)).toEqual({ used: 0, reserved: 0 });
    expect((await part(user, 'arsip', up.uploadId, 'a.bin', 1, bytes(10, 3))).status).toBe(404);
  });

  it('keeps to the quota, the size limits, and the bill', async () => {
    const { rt, client, user } = await s3Setup({ limitBytes: 6 * MIB });
    await client.send(new CreateBucketCommand({ Bucket: 'kecil' }));
    setConfig(rt, 's3_web_part_bytes', 5 * MIB);
    await reloadConfig(rt);
    const up = await start(user, 'kecil', 'b.bin', 10 * MIB);
    await etagOf(await part(user, 'kecil', up.uploadId, 'b.bin', 1, bytes(5 * MIB, 1)));
    const full = await part(user, 'kecil', up.uploadId, 'b.bin', 2, bytes(5 * MIB, 2));
    expect(full.status).toBe(413);
    expect(((await full.json()) as { error: { code: string } }).error.code).toBe('QUOTA_FULL');

    setConfig(rt, 's3_web_multipart_max_bytes', 8 * MIB);
    setConfig(rt, 's3_web_upload_max_bytes', 6 * MIB);
    await reloadConfig(rt);
    expect(
      (await user.req('POST', '/api/s3/buckets/kecil/uploads', { key: 'c.bin', size: 9 * MIB }))
        .status,
    ).toBe(413);
    expect((await part(user, 'kecil', up.uploadId, 'b.bin', 1, bytes(6 * MIB + 1, 1))).status).toBe(
      413,
    );

    rt.d1.sqlite
      .prepare(`UPDATE s3_accounts SET billing_state = 'readonly' WHERE user_id = ?`)
      .run(user.userId);
    const paused = await user.req('POST', '/api/s3/buckets/kecil/uploads', {
      key: 'd.bin',
      size: MIB,
    });
    expect(paused.status).toBe(403);
    expect(
      ((await paused.json()) as { error: { data: { reason: string } } }).error.data.reason,
    ).toBe('s3_readonly');
    // Cancelling still works on a paused account (it frees storage).
    expect(
      (await user.req('DELETE', `/api/s3/buckets/kecil/uploads/${up.uploadId}?key=b.bin`)).status,
    ).toBe(204);
  });

  it('raises the part size for files that would need more than 10,000 parts', () => {
    expect(webPartSize(10 * MIB, 32 * MIB, 95 * MIB)).toBe(32 * MIB);
    expect(webPartSize(1000 * GIB, 32 * MIB, 95 * MIB)).toBe(95 * MIB);
    expect(webPartSize(500 * GIB, 32 * MIB, 95 * MIB)).toBe(52 * MIB);
    expect(webPartSize(500 * GIB, 64 * MIB, 95 * MIB)).toBe(64 * MIB);
  });
});
