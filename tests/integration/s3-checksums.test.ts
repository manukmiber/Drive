// Checksums in Zeiko S3 (S8 part 3, ADR-076), through the real AWS SDK: each algorithm checked on
// PutObject (header and aws-chunked trailer), kept and returned with x-amz-checksum-mode, multipart
// COMPOSITE and FULL_OBJECT values, GetObjectAttributes, and the CRC size limit.
import { Readable } from 'node:stream';
import {
  ChecksumAlgorithm,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  GetObjectAttributesCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  UploadPartCommand,
  type ChecksumAlgorithm as Alg,
} from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import {
  checksumOf,
  combineCrcs,
  compositeOf,
  type ChecksumAlg,
} from '../../src/worker/lib/checksums';
import { invalidateConfigMemo } from '../../src/worker/services/config';
import { RuntimeHandler, s3Client, s3Setup } from '../helpers/s3';
import type { DevRuntime } from '../../dev/env';

const MIB = 1024 * 1024;
const bytes = (n: number, seed: number) =>
  Uint8Array.from({ length: n }, (_, i) => (i * 29 + seed) & 0xff);

async function s3Code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { name?: string; Code?: string };
    return err.Code ?? err.name ?? 'unknown';
  }
  return 'ok';
}

const field = (alg: ChecksumAlg) =>
  `Checksum${alg}` as
    'ChecksumCRC32' | 'ChecksumCRC32C' | 'ChecksumCRC64NVME' | 'ChecksumSHA1' | 'ChecksumSHA256';

/** Sends aws-chunked bodies with a wrong trailing checksum. */
class TamperHandler extends RuntimeHandler {
  override async handle(req: Parameters<RuntimeHandler['handle']>[0]) {
    if (req.headers['x-amz-trailer'] && req.body instanceof Readable) {
      const chunks: Buffer[] = [];
      for await (const c of req.body) chunks.push(Buffer.from(c as Uint8Array));
      const text = Buffer.concat(chunks).toString('latin1');
      req.body = Buffer.from(
        text.replace(/(x-amz-checksum-[a-z0-9]+:)[A-Za-z0-9+/=]+/, '$1AAAAAA=='),
        'latin1',
      );
    }
    return super.handle(req);
  }
}

async function setConfig(rt: DevRuntime, key: string, value: unknown) {
  rt.d1.sqlite
    .prepare(
      `INSERT INTO app_config (key, value_json, updated_by, updated_at) VALUES (?, ?, 'test', 0)
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
    )
    .run(key, JSON.stringify(value));
  await rt.env.CONFIG_KV.delete('config:v1');
  invalidateConfigMemo(rt.env);
}

describe('checksums (S8, ADR-076)', () => {
  it('checks, keeps and returns every algorithm', async () => {
    const { client, handler } = await s3Setup();
    await client.send(new CreateBucketCommand({ Bucket: 'cek' }));
    const body = bytes(70_000, 3);
    for (const alg of ['CRC32', 'CRC32C', 'CRC64NVME', 'SHA1', 'SHA256'] as ChecksumAlg[]) {
      const want = await checksumOf(alg, body);
      const put = await client.send(
        new PutObjectCommand({
          Bucket: 'cek',
          Key: `${alg}.bin`,
          Body: body,
          ChecksumAlgorithm: alg as Alg,
        }),
      );
      expect(put[field(alg)]).toBe(want);
      const got = await client.send(
        new GetObjectCommand({ Bucket: 'cek', Key: `${alg}.bin`, ChecksumMode: 'ENABLED' }),
      );
      expect(got[field(alg)]).toBe(want);
      expect(got.ChecksumType).toBe('FULL_OBJECT');
      // The SDK checks the bytes against it as it reads.
      expect((await got.Body!.transformToByteArray()).length).toBe(body.length);
      const head = await client.send(
        new HeadObjectCommand({ Bucket: 'cek', Key: `${alg}.bin`, ChecksumMode: 'ENABLED' }),
      );
      expect(head[field(alg)]).toBe(want);
    }
    // Without checksum mode, no checksum headers.
    const plain = await client.send(new HeadObjectCommand({ Bucket: 'cek', Key: 'CRC32.bin' }));
    expect(plain.ChecksumCRC32).toBeUndefined();
    // The SDK sent CRC32 as a trailer on a streamed body at least once (the path this covers).
    const streamed = await client.send(
      new PutObjectCommand({
        Bucket: 'cek',
        Key: 'stream.bin',
        Body: Readable.from([Buffer.from(body)]),
        ContentLength: body.length,
        ChecksumAlgorithm: ChecksumAlgorithm.CRC32,
      }),
    );
    expect(streamed.ChecksumCRC32).toBe(await checksumOf('CRC32', body));
    expect(handler.sent.some((s) => s.headers['x-amz-trailer'] === 'x-amz-checksum-crc32')).toBe(
      true,
    );
  });

  it('refuses a body that does not match its checksum, as a header or a trailer', async () => {
    const s = await s3Setup();
    await s.client.send(new CreateBucketCommand({ Bucket: 'salah' }));
    expect(
      await s3Code(
        s.client.send(
          new PutObjectCommand({
            Bucket: 'salah',
            Key: 'a',
            Body: 'halo',
            ChecksumCRC32: 'AAAAAA==',
          }),
        ),
      ),
    ).toBe('BadDigest');
    expect(
      await s3Code(
        s.client.send(
          new PutObjectCommand({
            Bucket: 'salah',
            Key: 'a',
            Body: 'halo',
            ChecksumSHA256: 'bm9wZQ==',
          }),
        ),
      ),
    ).toBe('InvalidRequest');
    const tamper = s3Client(s.rt, s.key, new TamperHandler(s.rt));
    expect(
      await s3Code(
        tamper.send(
          new PutObjectCommand({
            Bucket: 'salah',
            Key: 'b',
            Body: Readable.from([Buffer.from('isi yang diubah')]),
            ContentLength: 15,
            ChecksumAlgorithm: ChecksumAlgorithm.CRC32,
          }),
        ),
      ),
    ).toBe('BadDigest');
    // Nothing was stored, nothing is held.
    const objects = s.rt.d1.sqlite
      .prepare(`SELECT key FROM s3_objects WHERE bucket = 'salah'`)
      .all();
    expect(objects).toEqual([]);
    const acc = s.rt.d1.sqlite
      .prepare('SELECT used_bytes, reserved_bytes FROM s3_accounts WHERE user_id = ?')
      .get(s.user.userId);
    expect(acc).toEqual({ used_bytes: 0, reserved_bytes: 0 });
  });

  it('multipart: COMPOSITE and FULL_OBJECT values, part checks, ListParts and GetObjectAttributes', async () => {
    const { client } = await s3Setup({ limitBytes: 1024 ** 3 });
    await client.send(new CreateBucketCommand({ Bucket: 'bagian-mp' }));
    const pieces = [bytes(5 * MIB, 1), bytes(5 * MIB, 2), bytes(1234, 3)];
    for (const [alg, type] of [
      ['SHA256', 'COMPOSITE'],
      ['CRC32C', 'FULL_OBJECT'],
      ['CRC64NVME', 'FULL_OBJECT'],
    ] as Array<[ChecksumAlg, 'COMPOSITE' | 'FULL_OBJECT']>) {
      const Key = `${alg}.bin`;
      const up = await client.send(
        new CreateMultipartUploadCommand({
          Bucket: 'bagian-mp',
          Key,
          ChecksumAlgorithm: alg as Alg,
          ChecksumType: type,
        }),
      );
      expect(up.ChecksumType).toBe(type);
      const parts = [];
      const sums: string[] = [];
      for (let i = 0; i < pieces.length; i++) {
        const r = await client.send(
          new UploadPartCommand({
            Bucket: 'bagian-mp',
            Key,
            UploadId: up.UploadId,
            PartNumber: i + 1,
            Body: pieces[i],
            ChecksumAlgorithm: alg as Alg,
          }),
        );
        sums.push(r[field(alg)]!);
        expect(sums[i]).toBe(await checksumOf(alg, pieces[i]!));
        parts.push({ PartNumber: i + 1, ETag: r.ETag, [field(alg)]: sums[i] });
      }
      const listed = await client.send(
        new ListPartsCommand({ Bucket: 'bagian-mp', Key, UploadId: up.UploadId }),
      );
      expect(listed.Parts?.map((p) => p[field(alg)])).toEqual(sums);
      expect(listed.ChecksumAlgorithm).toBe(alg);

      // A part listed with another value than it was checked with.
      expect(
        await s3Code(
          client.send(
            new CompleteMultipartUploadCommand({
              Bucket: 'bagian-mp',
              Key,
              UploadId: up.UploadId,
              MultipartUpload: {
                Parts: [{ ...parts[0]!, [field(alg)]: sums[1] }, ...parts.slice(1)],
              },
            }),
          ),
        ),
      ).toBe('InvalidPart');

      const done = await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: 'bagian-mp',
          Key,
          UploadId: up.UploadId,
          MultipartUpload: { Parts: parts },
        }),
      );
      const whole = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
      let o = 0;
      for (const p of pieces) {
        whole.set(p, o);
        o += p.length;
      }
      const expected =
        type === 'COMPOSITE'
          ? await compositeOf(alg, sums)
          : combineCrcs(
              alg,
              sums.map((value, i) => ({ value, size: pieces[i]!.length })),
            );
      if (type === 'FULL_OBJECT') expect(expected).toBe(await checksumOf(alg, whole));
      expect(done[field(alg)]).toBe(expected);
      expect(done.ChecksumType).toBe(type);

      const attrs = await client.send(
        new GetObjectAttributesCommand({
          Bucket: 'bagian-mp',
          Key,
          ObjectAttributes: ['ETag', 'Checksum', 'ObjectParts', 'StorageClass', 'ObjectSize'],
          MaxParts: 2,
        }),
      );
      expect(attrs.ETag).toBe(done.ETag?.replace(/"/g, ''));
      expect(attrs.Checksum?.[field(alg)]).toBe(expected);
      expect(attrs.Checksum?.ChecksumType).toBe(type);
      expect(attrs.ObjectSize).toBe(whole.length);
      expect(attrs.StorageClass).toBe('STANDARD');
      expect(attrs.ObjectParts).toMatchObject({
        TotalPartsCount: 3,
        MaxParts: 2,
        IsTruncated: true,
        NextPartNumberMarker: '2',
      });
      expect(attrs.ObjectParts?.Parts?.map((p) => p.Size)).toEqual([5 * MIB, 5 * MIB]);
      if (type === 'COMPOSITE')
        expect(attrs.ObjectParts?.Parts?.map((p) => p[field(alg)])).toEqual(sums.slice(0, 2));

      // Reading one part of a COMPOSITE object gives that part's value.
      const second = await client.send(
        new GetObjectCommand({ Bucket: 'bagian-mp', Key, PartNumber: 2, ChecksumMode: 'ENABLED' }),
      );
      expect(second[field(alg)]).toBe(type === 'COMPOSITE' ? sums[1] : undefined);
      await second.Body!.transformToByteArray();
    }
    expect(
      await s3Code(
        client.send(
          new CreateMultipartUploadCommand({
            Bucket: 'bagian-mp',
            Key: 'x',
            ChecksumAlgorithm: 'SHA1',
            ChecksumType: 'FULL_OBJECT',
          }),
        ),
      ),
    ).toBe('InvalidRequest');
  });

  it('CRCs over the size limit are neither checked nor kept; SHA always is', async () => {
    const { rt, client } = await s3Setup();
    await client.send(new CreateBucketCommand({ Bucket: 'besar' }));
    await setConfig(rt, 's3_checksum_crc_max_bytes', 1000);
    const body = bytes(5000, 9);
    await client.send(
      new PutObjectCommand({ Bucket: 'besar', Key: 'crc', Body: body, ChecksumCRC32: 'AAAAAA==' }),
    );
    const crc = await client.send(
      new HeadObjectCommand({ Bucket: 'besar', Key: 'crc', ChecksumMode: 'ENABLED' }),
    );
    expect(crc.ChecksumCRC32).toBeUndefined();
    expect(
      await s3Code(
        client.send(
          new PutObjectCommand({
            Bucket: 'besar',
            Key: 'sha',
            Body: body,
            ChecksumSHA1: await checksumOf('SHA256', body).then(
              () => 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=',
            ),
          }),
        ),
      ),
    ).toBe('BadDigest');
    const attrs = await client.send(
      new GetObjectAttributesCommand({
        Bucket: 'besar',
        Key: 'crc',
        ObjectAttributes: ['ObjectParts', 'ObjectSize'],
      }),
    );
    expect(attrs.ObjectParts).toBeUndefined();
    expect(attrs.ObjectSize).toBe(5000);
  });
});
