// Zeiko S3 (ADR-044) driven by the real AWS SDK v3, the way people will use it.
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetBucketLocationCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListMultipartUploadsCommand,
  ListObjectsCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutBucketAclCommand,
  PutObjectCommand,
  UploadPartCommand,
  UploadPartCopyCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { describe, expect, it } from 'vitest';
import type { ShimD1Database } from '../../dev/shims/d1';
import { MIB } from '../../src/shared/constants';
import { s3Client, s3Setup, S3_ORIGIN, usage } from '../helpers/s3';
import { noticesOf } from '../helpers/notices';

const text = async (body: unknown) =>
  (body as { transformToString(): Promise<string> }).transformToString();

async function expectS3Error(p: Promise<unknown>, code: string, status?: number) {
  try {
    await p;
  } catch (e) {
    const err = e as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
    expect(err.Code ?? err.name).toBe(code);
    if (status) expect(err.$metadata?.httpStatusCode).toBe(status);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe('Zeiko S3 with the AWS SDK', () => {
  it('creates a bucket, stores, reads and deletes objects, and counts the storage', async () => {
    const { rt, client, user } = await s3Setup();
    await client.send(new CreateBucketCommand({ Bucket: 'foto-liburan' }));
    const buckets = await client.send(new ListBucketsCommand({}));
    expect(buckets.Buckets?.map((b) => b.Name)).toEqual(['foto-liburan']);
    await client.send(new HeadBucketCommand({ Bucket: 'foto-liburan' }));
    const loc = await client.send(new GetBucketLocationCommand({ Bucket: 'foto-liburan' }));
    expect(loc.LocationConstraint).toBe('auto');

    const put = await client.send(
      new PutObjectCommand({
        Bucket: 'foto-liburan',
        Key: 'pantai/hari 1+2.txt',
        Body: 'halo dari Zeiko S3',
        ContentType: 'text/plain',
        CacheControl: 'max-age=60',
        Metadata: { kota: 'malang' },
      }),
    );
    expect(put.ETag).toBe(`"${createHash('md5').update('halo dari Zeiko S3').digest('hex')}"`);

    const head = await client.send(
      new HeadObjectCommand({ Bucket: 'foto-liburan', Key: 'pantai/hari 1+2.txt' }),
    );
    expect(head.ContentLength).toBe(18);
    expect(head.ContentType).toBe('text/plain');
    expect(head.CacheControl).toBe('max-age=60');
    expect(head.Metadata).toEqual({ kota: 'malang' });

    const got = await client.send(
      new GetObjectCommand({ Bucket: 'foto-liburan', Key: 'pantai/hari 1+2.txt' }),
    );
    expect(await text(got.Body)).toBe('halo dari Zeiko S3');
    const part = await client.send(
      new GetObjectCommand({
        Bucket: 'foto-liburan',
        Key: 'pantai/hari 1+2.txt',
        Range: 'bytes=5-8',
      }),
    );
    expect(await text(part.Body)).toBe('dari');
    expect(part.ContentRange).toBe('bytes 5-8/18');
    expect(usage(rt, user.userId)).toEqual({ used: 18, reserved: 0 });

    // Overwrite: the old bytes go, the storage follows the new size.
    await client.send(
      new PutObjectCommand({ Bucket: 'foto-liburan', Key: 'pantai/hari 1+2.txt', Body: 'baru' }),
    );
    expect(usage(rt, user.userId)).toEqual({ used: 4, reserved: 0 });

    await client.send(
      new DeleteObjectCommand({ Bucket: 'foto-liburan', Key: 'pantai/hari 1+2.txt' }),
    );
    await expectS3Error(
      client.send(new GetObjectCommand({ Bucket: 'foto-liburan', Key: 'pantai/hari 1+2.txt' })),
      'NoSuchKey',
      404,
    );
    expect(usage(rt, user.userId)).toEqual({ used: 0, reserved: 0 });
    // Nothing of the account is left in R2.
    const left = await rt.r2.list({ prefix: `s3/${user.userId}/` });
    expect(left.objects).toHaveLength(0);
    await client.send(new DeleteBucketCommand({ Bucket: 'foto-liburan' }));
    expect((await client.send(new ListBucketsCommand({}))).Buckets ?? []).toEqual([]);
  });

  it('accepts streamed uploads (aws-chunked with a trailing checksum)', async () => {
    const { client, handler } = await s3Setup();
    await client.send(new CreateBucketCommand({ Bucket: 'stream' }));
    const data = Buffer.alloc(300_000, 'z');
    await client.send(
      new PutObjectCommand({
        Bucket: 'stream',
        Key: 'big.bin',
        Body: Readable.from([data.subarray(0, 100_000), data.subarray(100_000)]),
        ContentLength: data.length,
      }),
    );
    const put = handler.sent.find((s) => s.method === 'PUT' && s.url.includes('big.bin'))!;
    expect(put.headers['x-amz-content-sha256']).toMatch(/^STREAMING-/);
    const got = await client.send(new GetObjectCommand({ Bucket: 'stream', Key: 'big.bin' }));
    const bytes = Buffer.from(
      await (got.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray(),
    );
    expect(bytes.equals(data)).toBe(true);
  });

  it('lists like S3: prefixes, delimiters, pages, markers and url encoding', async () => {
    const { client } = await s3Setup();
    await client.send(new CreateBucketCommand({ Bucket: 'arsip' }));
    const keys = [
      'a.txt',
      'docs/2024/x.pdf',
      'docs/2024/y.pdf',
      'docs/2025/z.pdf',
      'docs/readme',
      'foto/1.jpg',
      'foto/2.jpg',
      'z z.txt',
    ];
    for (const k of keys)
      await client.send(new PutObjectCommand({ Bucket: 'arsip', Key: k, Body: k }));

    const all = await client.send(new ListObjectsV2Command({ Bucket: 'arsip' }));
    expect(all.Contents?.map((c) => c.Key)).toEqual(keys);
    expect(all.KeyCount).toBe(keys.length);

    const top = await client.send(new ListObjectsV2Command({ Bucket: 'arsip', Delimiter: '/' }));
    expect(top.Contents?.map((c) => c.Key)).toEqual(['a.txt', 'z z.txt']);
    expect(top.CommonPrefixes?.map((p) => p.Prefix)).toEqual(['docs/', 'foto/']);

    const docs = await client.send(
      new ListObjectsV2Command({ Bucket: 'arsip', Prefix: 'docs/', Delimiter: '/' }),
    );
    expect(docs.Contents?.map((c) => c.Key)).toEqual(['docs/readme']);
    expect(docs.CommonPrefixes?.map((p) => p.Prefix)).toEqual(['docs/2024/', 'docs/2025/']);

    // Pages of 2, prefixes counting as entries, until done.
    const seen: string[] = [];
    let token: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: 'arsip',
          Delimiter: '/',
          MaxKeys: 2,
          ContinuationToken: token,
        }),
      );
      seen.push(
        ...(page.CommonPrefixes ?? []).map((p) => p.Prefix!),
        ...(page.Contents ?? []).map((c) => c.Key!),
      );
      if (!page.IsTruncated) break;
      token = page.NextContinuationToken;
    }
    expect(seen.sort()).toEqual(['a.txt', 'docs/', 'foto/', 'z z.txt']);

    // v1 with a marker that is itself a common prefix: that prefix is not repeated.
    const v1 = await client.send(
      new ListObjectsCommand({ Bucket: 'arsip', Delimiter: '/', Marker: 'docs/' }),
    );
    expect(v1.CommonPrefixes?.map((p) => p.Prefix)).toEqual(['foto/']);
    expect(v1.Contents?.map((c) => c.Key)).toEqual(['z z.txt']);

    const after = await client.send(
      new ListObjectsV2Command({ Bucket: 'arsip', StartAfter: 'foto/1.jpg' }),
    );
    expect(after.Contents?.map((c) => c.Key)).toEqual(['foto/2.jpg', 'z z.txt']);

    const encoded = await client.send(
      new ListObjectsV2Command({ Bucket: 'arsip', Prefix: 'z', EncodingType: 'url' }),
    );
    expect(encoded.Contents?.map((c) => c.Key)).toEqual(['z+z.txt']);
  });

  it('runs multipart uploads (R2 rules: equal parts, last may be smaller) and copies', async () => {
    const { rt, client, user } = await s3Setup();
    await client.send(new CreateBucketCommand({ Bucket: 'video' }));
    const p1 = Buffer.alloc(5 * MIB, 1);
    const p2 = Buffer.alloc(5 * MIB, 2);
    const p3 = Buffer.from('ekor');
    const up = await client.send(
      new CreateMultipartUploadCommand({
        Bucket: 'video',
        Key: 'film.mp4',
        ContentType: 'video/mp4',
      }),
    );
    const etags: string[] = [];
    for (const [i, body] of [p1, p2, p3].entries()) {
      const r = await client.send(
        new UploadPartCommand({
          Bucket: 'video',
          Key: 'film.mp4',
          UploadId: up.UploadId,
          PartNumber: i + 1,
          Body: body,
        }),
      );
      etags.push(r.ETag!);
    }
    expect(usage(rt, user.userId).reserved).toBe(10 * MIB + 4);
    const parts = await client.send(
      new ListPartsCommand({ Bucket: 'video', Key: 'film.mp4', UploadId: up.UploadId }),
    );
    expect(parts.Parts?.map((p) => p.Size)).toEqual([5 * MIB, 5 * MIB, 4]);
    const uploads = await client.send(new ListMultipartUploadsCommand({ Bucket: 'video' }));
    expect(uploads.Uploads?.map((u) => u.Key)).toEqual(['film.mp4']);

    const done = await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: 'video',
        Key: 'film.mp4',
        UploadId: up.UploadId,
        MultipartUpload: { Parts: etags.map((ETag, i) => ({ ETag, PartNumber: i + 1 })) },
      }),
    );
    expect(done.ETag).toMatch(/-3"$/);
    expect(usage(rt, user.userId)).toEqual({ used: 10 * MIB + 4, reserved: 0 });
    const head = await client.send(new HeadObjectCommand({ Bucket: 'video', Key: 'film.mp4' }));
    expect(head.ContentLength).toBe(10 * MIB + 4);
    expect(head.ContentType).toBe('video/mp4');
    const tail = await client.send(
      new GetObjectCommand({ Bucket: 'video', Key: 'film.mp4', Range: `bytes=${10 * MIB}-` }),
    );
    expect(await text(tail.Body)).toBe('ekor');

    // Copy, then a copy that only changes the metadata.
    await client.send(
      new CopyObjectCommand({ Bucket: 'video', Key: 'salinan.mp4', CopySource: 'video/film.mp4' }),
    );
    expect(usage(rt, user.userId).used).toBe(2 * (10 * MIB + 4));
    await client.send(
      new CopyObjectCommand({
        Bucket: 'video',
        Key: 'salinan.mp4',
        CopySource: 'video/salinan.mp4',
        MetadataDirective: 'REPLACE',
        ContentType: 'application/octet-stream',
      }),
    );
    const h2 = await client.send(new HeadObjectCommand({ Bucket: 'video', Key: 'salinan.mp4' }));
    expect(h2.ContentType).toBe('application/octet-stream');
    expect(usage(rt, user.userId).used).toBe(2 * (10 * MIB + 4));

    // UploadPartCopy from a range of an object.
    const up2 = await client.send(
      new CreateMultipartUploadCommand({ Bucket: 'video', Key: 'potong.mp4' }),
    );
    const cp = await client.send(
      new UploadPartCopyCommand({
        Bucket: 'video',
        Key: 'potong.mp4',
        UploadId: up2.UploadId,
        PartNumber: 1,
        CopySource: 'video/film.mp4',
        CopySourceRange: `bytes=${10 * MIB}-${10 * MIB + 3}`,
      }),
    );
    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: 'video',
        Key: 'potong.mp4',
        UploadId: up2.UploadId,
        MultipartUpload: { Parts: [{ ETag: cp.CopyPartResult!.ETag!, PartNumber: 1 }] },
      }),
    );
    expect(
      await text(
        (await client.send(new GetObjectCommand({ Bucket: 'video', Key: 'potong.mp4' }))).Body,
      ),
    ).toBe('ekor');

    // Uneven parts are refused before R2 sees them; an abort gives the reservation back.
    const up3 = await client.send(
      new CreateMultipartUploadCommand({ Bucket: 'video', Key: 'rusak.bin' }),
    );
    const a = await client.send(
      new UploadPartCommand({
        Bucket: 'video',
        Key: 'rusak.bin',
        UploadId: up3.UploadId,
        PartNumber: 1,
        Body: p1,
      }),
    );
    const b = await client.send(
      new UploadPartCommand({
        Bucket: 'video',
        Key: 'rusak.bin',
        UploadId: up3.UploadId,
        PartNumber: 2,
        Body: Buffer.alloc(6 * MIB),
      }),
    );
    const c = await client.send(
      new UploadPartCommand({
        Bucket: 'video',
        Key: 'rusak.bin',
        UploadId: up3.UploadId,
        PartNumber: 3,
        Body: p3,
      }),
    );
    await expectS3Error(
      client.send(
        new CompleteMultipartUploadCommand({
          Bucket: 'video',
          Key: 'rusak.bin',
          UploadId: up3.UploadId,
          MultipartUpload: {
            Parts: [a, b, c].map((p, i) => ({ ETag: p.ETag!, PartNumber: i + 1 })),
          },
        }),
      ),
      'InvalidPart',
      400,
    );
    await client.send(
      new AbortMultipartUploadCommand({
        Bucket: 'video',
        Key: 'rusak.bin',
        UploadId: up3.UploadId,
      }),
    );
    expect(usage(rt, user.userId).reserved).toBe(0);
  });

  it('refuses writes past the storage limit, and keeps nothing of them', async () => {
    const { rt, client, user } = await s3Setup({ limitBytes: 10 });
    await client.send(new CreateBucketCommand({ Bucket: 'kecil' }));
    await client.send(new PutObjectCommand({ Bucket: 'kecil', Key: 'a', Body: '12345' }));
    await expectS3Error(
      client.send(new PutObjectCommand({ Bucket: 'kecil', Key: 'b', Body: '1234567' })),
      'QuotaExceeded',
      403,
    );
    expect(usage(rt, user.userId)).toEqual({ used: 5, reserved: 0 });
    expect((await rt.r2.list({ prefix: `s3/${user.userId}/` })).objects).toHaveLength(1);
  });

  it('deletes many objects in one request and refuses to drop a bucket that is not empty', async () => {
    const { rt, client, user } = await s3Setup();
    await client.send(new CreateBucketCommand({ Bucket: 'banyak' }));
    for (const k of ['1', '2', '3'])
      await client.send(new PutObjectCommand({ Bucket: 'banyak', Key: k, Body: k }));
    await expectS3Error(
      client.send(new DeleteBucketCommand({ Bucket: 'banyak' })),
      'BucketNotEmpty',
      409,
    );
    const res = await client.send(
      new DeleteObjectsCommand({
        Bucket: 'banyak',
        Delete: { Objects: [{ Key: '1' }, { Key: '2' }, { Key: 'tidak-ada' }] },
      }),
    );
    expect(res.Deleted?.map((d) => d.Key).sort()).toEqual(['1', '2', 'tidak-ada']);
    const left = await client.send(new ListObjectsV2Command({ Bucket: 'banyak' }));
    expect(left.Contents?.map((c) => c.Key)).toEqual(['3']);
    expect(usage(rt, user.userId).used).toBe(1);
  });

  it('works with presigned URLs, and only until they expire', async () => {
    const { rt, client } = await s3Setup();
    await client.send(new CreateBucketCommand({ Bucket: 'tautan' }));
    await client.send(
      new PutObjectCommand({ Bucket: 'tautan', Key: 'laporan.pdf', Body: '%PDF-1.7' }),
    );
    const url = await getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: 'tautan', Key: 'laporan.pdf' }),
      { expiresIn: 60 },
    );
    const res = await rt.fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('%PDF-1.7');
    // Objects never render as a page on a zeiko.biz.id host.
    expect(res.headers.get('content-security-policy')).toContain('sandbox');

    const putUrl = await getSignedUrl(
      client,
      new PutObjectCommand({ Bucket: 'tautan', Key: 'unggah.txt' }),
      { expiresIn: 60 },
    );
    // (A browser sends Content-Length itself; a test Request has to say it.)
    const put = await rt.fetch(
      new Request(putUrl, {
        method: 'PUT',
        body: 'dari browser',
        headers: { 'content-length': '12' },
      }),
    );
    expect(put.status).toBe(200);

    const tampered = url.replace('laporan.pdf', 'lain.pdf');
    expect((await rt.fetch(tampered)).status).toBe(403);
    const old = new URL(url);
    old.searchParams.set('X-Amz-Date', '20200101T000000Z');
    expect((await rt.fetch(old.toString())).status).toBe(403);
  });

  it('shows public buckets to everyone, but only scanned objects; private ones to nobody', async () => {
    const { rt, client, user } = await s3Setup();
    await client.send(new CreateBucketCommand({ Bucket: 'publik', ACL: 'public-read' }));
    await client.send(new CreateBucketCommand({ Bucket: 'pribadi' }));
    await client.send(
      new PutObjectCommand({
        Bucket: 'publik',
        Key: 'logo.png',
        Body: 'png',
        ContentType: 'image/png',
      }),
    );
    await client.send(new PutObjectCommand({ Bucket: 'pribadi', Key: 'ktp.jpg', Body: 'jpg' }));
    const anon = (path: string) => rt.fetch(`${S3_ORIGIN}${path}`);
    expect((await anon('/publik/logo.png')).status).toBe(403); // still being scanned
    await rt.settle();
    const ok = await anon('/publik/logo.png');
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('png');
    expect((await anon('/pribadi/ktp.jpg')).status).toBe(403);
    expect((await anon('/publik')).status).toBe(403); // no anonymous listing
    expect(
      (await rt.fetch(new Request(`${S3_ORIGIN}/publik/x`, { method: 'PUT', body: 'x' }))).status,
    ).toBe(403);

    await client.send(new PutBucketAclCommand({ Bucket: 'publik', ACL: 'private' }));
    expect((await anon('/publik/logo.png')).status).toBe(403);

    // Zeiko blocks a public bucket (ToS §4.2): it cannot be made public again by its owner.
    await client.send(new PutBucketAclCommand({ Bucket: 'publik', ACL: 'public-read' }));
    const { opsCall } = await import('../helpers/s3');
    const ops = opsCall(rt);
    expect(
      (await ops('POST', '/s3/buckets/publik/block', { blocked: true, reason: 'laporan hotlink' }))
        .status,
    ).toBe(204);
    expect((await anon('/publik/logo.png')).status).toBe(403);
    const again = await user.req('PATCH', '/api/s3/buckets/publik', { public: true });
    expect(again.status).toBe(403);
  });

  it('deletes infected objects after the scan and gives their storage back', async () => {
    const { rt, client, user } = await s3Setup();
    await client.send(new CreateBucketCommand({ Bucket: 'unduhan' }));
    await client.send(
      new PutObjectCommand({
        Bucket: 'unduhan',
        Key: 'eicar.com',
        Body: 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
      }),
    );
    expect(usage(rt, user.userId).used).toBeGreaterThan(0);
    await rt.settle();
    await expectS3Error(
      client.send(new HeadObjectCommand({ Bucket: 'unduhan', Key: 'eicar.com' })),
      'NotFound',
      404,
    );
    expect(usage(rt, user.userId).used).toBe(0);
    const note = (await noticesOf(rt, user.userId)).find((n) => n.type === 'file_rejected')!;
    expect(JSON.parse(note.payload_json).name).toBe('unduhan/eicar.com');
  });

  it('turns away wrong secrets, revoked keys, suspended accounts and other people', async () => {
    const { rt, client, key, user, ops } = await s3Setup();
    await client.send(new CreateBucketCommand({ Bucket: 'milikku' }));
    const wrong = s3Client(rt, { id: key.id, secret: 'x'.repeat(40) });
    await expectS3Error(wrong.send(new ListBucketsCommand({})), 'SignatureDoesNotMatch', 403);
    const unknown = s3Client(rt, { id: 'ZKAAAAAAAAAAAAAAAAAA', secret: key.secret });
    await expectS3Error(unknown.send(new ListBucketsCommand({})), 'InvalidAccessKeyId', 403);

    // Someone else with their own Zeiko S3 cannot touch this bucket, or take its name.
    const other = await s3Setup({ rt, email: 'orang-lain@zeiko.test' });
    await expectS3Error(
      other.client.send(new ListObjectsV2Command({ Bucket: 'milikku' })),
      'AccessDenied',
      403,
    );
    await expectS3Error(
      other.client.send(new PutObjectCommand({ Bucket: 'milikku', Key: 'x', Body: 'x' })),
      'AccessDenied',
      403,
    );
    await expectS3Error(
      other.client.send(new CreateBucketCommand({ Bucket: 'milikku' })),
      'BucketAlreadyExists',
      409,
    );

    expect(
      (
        await ops('PATCH', `/s3/accounts/${user.userId}`, {
          suspended: true,
          reason: 'laporan penyalahgunaan',
        })
      ).status,
    ).toBe(200);
    // The key cache holds for 15 s per isolate; a fresh lookup sees the suspension through the account row.
    await expectS3Error(client.send(new ListBucketsCommand({})), 'AccountProblem', 403);
    await ops('PATCH', `/s3/accounts/${user.userId}`, {
      suspended: false,
      reason: 'sudah dibereskan',
    });
    await client.send(new ListBucketsCommand({}));

    expect((await user.req('DELETE', `/api/s3/keys/${key.id}`)).status).toBe(204);
    await expectS3Error(client.send(new ListBucketsCommand({})), 'InvalidAccessKeyId', 403);
  });

  it('keeps an account’s index in its own D1 once one is bound (the diagram: 1 user, 1 D1)', async () => {
    const { rt, client, user, ops } = await s3Setup({ extraD1: ['S3_DB_A'] });
    const list = (await (await ops('GET', '/s3/accounts')).json()) as { indexBindings: string[] };
    expect(list.indexBindings).toEqual(['S3_DB_A']);
    const moved = await ops('PUT', `/s3/accounts/${user.userId}/index`, {
      binding: 'S3_DB_A',
      reason: 'database sendiri',
    });
    expect(moved.status).toBe(200);
    await client.send(new CreateBucketCommand({ Bucket: 'terpisah' }));
    await client.send(
      new PutObjectCommand({ Bucket: 'terpisah', Key: 'catatan.txt', Body: 'isi' }),
    );
    const own = (rt.env as unknown as Record<string, ShimD1Database>).S3_DB_A!;
    expect(own.sqlite.prepare('SELECT key FROM s3_objects').all()).toEqual([
      { key: 'catatan.txt' },
    ]);
    expect(rt.d1.sqlite.prepare('SELECT COUNT(*) AS n FROM s3_objects').get()).toEqual({ n: 0 });
    expect(
      await text(
        (await client.send(new GetObjectCommand({ Bucket: 'terpisah', Key: 'catatan.txt' }))).Body,
      ),
    ).toBe('isi');
    // With objects in it, the index stays where it is.
    const again = await ops('PUT', `/s3/accounts/${user.userId}/index`, {
      binding: 'S3_DB_B',
      reason: 'pindah lagi',
    });
    expect(again.status).toBe(400);
  });

  it('removes everything in Zeiko S3 when the account is deleted', async () => {
    const { rt, client, user } = await s3Setup();
    await client.send(new CreateBucketCommand({ Bucket: 'hapus-aku' }));
    await client.send(new PutObjectCommand({ Bucket: 'hapus-aku', Key: 'a', Body: 'a' }));
    await client.send(new CreateMultipartUploadCommand({ Bucket: 'hapus-aku', Key: 'b' }));
    const { purgeS3Account } = await import('../../src/worker/services/s3-objects');
    const { createCtx } = await import('../../src/worker/context');
    expect(await purgeS3Account(createCtx(rt.env), user.userId)).toBe(true);
    expect((await rt.r2.list({ prefix: `s3/${user.userId}/` })).objects).toHaveLength(0);
    for (const t of ['s3_accounts', 's3_keys', 's3_buckets'])
      expect(
        rt.d1.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`).get(user.userId),
      ).toEqual({ n: 0 });
    await expectS3Error(client.send(new ListBucketsCommand({})), 'InvalidAccessKeyId', 403);
  });
});
