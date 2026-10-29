// GetObject/HeadObject ?partNumber (S8 part 2, ADR-076) through the real AWS SDK: each part of a
// multipart object as a range, the part count, single-part objects, and the errors Amazon gives.
import {
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { S3_ORIGIN, s3Setup } from '../helpers/s3';

const MIB = 1024 * 1024;

function bytes(n: number, seed: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 13 + seed) & 0xff;
  return b;
}

async function s3Code(p: Promise<unknown>): Promise<[string, number | undefined]> {
  try {
    await p;
  } catch (e) {
    const err = e as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
    return [err.Code ?? err.name ?? 'unknown', err.$metadata?.httpStatusCode];
  }
  return ['ok', 200];
}

describe('reading by part number (S8, ADR-076)', () => {
  it('serves each part of a multipart object with its range and the part count', async () => {
    const { client } = await s3Setup();
    await client.send(new CreateBucketCommand({ Bucket: 'bagian' }));
    const sizes = [5 * MIB, 5 * MIB, 1000];
    const chunks = sizes.map((n, i) => bytes(n, i + 1));
    const up = await client.send(
      new CreateMultipartUploadCommand({ Bucket: 'bagian', Key: 'mp.bin' }),
    );
    const parts = [];
    for (let i = 0; i < chunks.length; i++) {
      const r = await client.send(
        new UploadPartCommand({
          Bucket: 'bagian',
          Key: 'mp.bin',
          UploadId: up.UploadId,
          PartNumber: i + 1,
          Body: chunks[i],
        }),
      );
      parts.push({ PartNumber: i + 1, ETag: r.ETag });
    }
    const done = await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: 'bagian',
        Key: 'mp.bin',
        UploadId: up.UploadId,
        MultipartUpload: { Parts: parts },
      }),
    );
    const total = sizes.reduce((a, b) => a + b, 0);
    let start = 0;
    for (let i = 0; i < 3; i++) {
      const got = await client.send(
        new GetObjectCommand({ Bucket: 'bagian', Key: 'mp.bin', PartNumber: i + 1 }),
      );
      expect(got.PartsCount).toBe(3);
      expect(got.ContentLength).toBe(sizes[i]);
      expect(got.ContentRange).toBe(`bytes ${start}-${start + sizes[i]! - 1}/${total}`);
      expect(got.ETag).toBe(done.ETag);
      const body = await got.Body!.transformToByteArray();
      expect(Buffer.compare(Buffer.from(body), Buffer.from(chunks[i]!))).toBe(0);
      start += sizes[i]!;
    }
    const head = await client.send(
      new HeadObjectCommand({ Bucket: 'bagian', Key: 'mp.bin', PartNumber: 2 }),
    );
    expect(head.PartsCount).toBe(3);
    expect(head.ContentLength).toBe(5 * MIB);

    expect(
      await s3Code(
        client.send(new GetObjectCommand({ Bucket: 'bagian', Key: 'mp.bin', PartNumber: 4 })),
      ),
    ).toEqual(['InvalidPartNumber', 416]);
    expect(
      await s3Code(
        client.send(
          new GetObjectCommand({
            Bucket: 'bagian',
            Key: 'mp.bin',
            PartNumber: 1,
            Range: 'bytes=0-9',
          }),
        ),
      ),
    ).toEqual(['InvalidRequest', 400]);

    // A copy is one object in one put.
    await client.send(
      new CopyObjectCommand({ Bucket: 'bagian', Key: 'salinan.bin', CopySource: 'bagian/mp.bin' }),
    );
    const copy = await client.send(
      new HeadObjectCommand({ Bucket: 'bagian', Key: 'salinan.bin', PartNumber: 1 }),
    );
    expect(copy.PartsCount).toBeUndefined();
    expect(copy.ContentLength).toBe(total);
  });

  it('an object put in one go is part 1; bad part numbers and unrecorded parts are refused', async () => {
    const { rt, client } = await s3Setup();
    await client.send(new CreateBucketCommand({ Bucket: 'tunggal' }));
    await client.send(
      new PutObjectCommand({ Bucket: 'tunggal', Key: 'a.txt', Body: 'halo dunia' }),
    );
    const one = await client.send(
      new GetObjectCommand({ Bucket: 'tunggal', Key: 'a.txt', PartNumber: 1 }),
    );
    expect(one.ContentRange).toBe('bytes 0-9/10');
    expect(one.PartsCount).toBeUndefined();
    expect(await one.Body!.transformToString()).toBe('halo dunia');
    expect(
      await s3Code(
        client.send(new GetObjectCommand({ Bucket: 'tunggal', Key: 'a.txt', PartNumber: 2 })),
      ),
    ).toEqual(['InvalidPartNumber', 416]);
    // The SDK refuses 0 itself; a raw request gets Amazon's answer.
    const zero = await rt.fetch(new Request(`${S3_ORIGIN}/tunggal/a.txt?partNumber=0`));
    expect(zero.status).toBe(403); // unsigned: the bucket is private
    expect(
      await s3Code(
        client.send(new GetObjectCommand({ Bucket: 'tunggal', Key: 'a.txt', PartNumber: 10_001 })),
      ),
    ).toEqual(['InvalidArgument', 400]);

    // A multipart object completed before part sizes were kept.
    rt.d1.sqlite
      .prepare(
        `UPDATE s3_objects SET etag = 'abc-3', parts = NULL, part_size = NULL WHERE key = 'a.txt'`,
      )
      .run();
    expect(
      await s3Code(
        client.send(new GetObjectCommand({ Bucket: 'tunggal', Key: 'a.txt', PartNumber: 1 })),
      ),
    ).toEqual(['InvalidRequest', 400]);
  });
});
