// Conditional writes in Zeiko S3 (ADR-068): If-None-Match / If-Match on PutObject, CopyObject and
// CompleteMultipartUpload, checked when the index row is written, so racing writers can't both win.
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  PutObjectCommand,
  UploadPartCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import type { DevRuntime } from '../../dev/env';
import { s3Setup, usage } from '../helpers/s3';

const text = async (body: unknown) =>
  (body as { transformToString(): Promise<string> }).transformToString();

async function expectS3Error(p: Promise<unknown>, code: string, status: number) {
  try {
    await p;
  } catch (e) {
    const err = e as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
    expect(err.Code ?? err.name).toBe(code);
    expect(err.$metadata?.httpStatusCode).toBe(status);
    return;
  }
  throw new Error(`expected ${code}`);
}

/** Every blob of the account in R2: a losing writer must leave none behind. */
async function blobs(rt: DevRuntime, userId: string): Promise<number> {
  return (await rt.r2.list({ prefix: `s3/${userId}/` })).objects.length;
}

function scansFor(rt: DevRuntime, key: string) {
  return rt.queues.SCAN_QUEUE.sent.filter(
    (m) =>
      (m as { type: string; key?: string }).type === 's3_scan' &&
      (m as { key: string }).key === key,
  );
}

/** Adds a raw header to every request this client signs (for headers the SDK has no field for). */
function withHeader(client: S3Client, name: string, value: string) {
  client.middlewareStack.add(
    (next) => (args) => {
      (args.request as { headers: Record<string, string> }).headers[name] = value;
      return next(args);
    },
    { step: 'build', name: `add-${name}` },
  );
}

describe('Zeiko S3 conditional writes', () => {
  it('If-None-Match: * never overwrites, and of two racing writers exactly one wins', async () => {
    const { rt, client, user } = await s3Setup();
    await client.send(new CreateBucketCommand({ Bucket: 'tf-state' }));
    await client.send(
      new PutObjectCommand({
        Bucket: 'tf-state',
        Key: 'state.tflock',
        Body: 'saya',
        IfNoneMatch: '*',
      }),
    );
    await expectS3Error(
      client.send(
        new PutObjectCommand({
          Bucket: 'tf-state',
          Key: 'state.tflock',
          Body: 'kamu!',
          IfNoneMatch: '*',
        }),
      ),
      'PreconditionFailed',
      412,
    );
    const lock = await client.send(
      new GetObjectCommand({ Bucket: 'tf-state', Key: 'state.tflock' }),
    );
    expect(await text(lock.Body)).toBe('saya');
    expect(usage(rt, user.userId)).toEqual({ used: 4, reserved: 0 });

    // Hold both writers until each has passed the early check and is storing its bytes, so the
    // commit itself has to decide.
    const put = rt.r2.put.bind(rt.r2);
    const held: Array<() => void> = [];
    rt.r2.put = (async (...args: Parameters<typeof put>) => {
      if (String(args[0]).startsWith(`s3/${user.userId}/`))
        await new Promise<void>((go) => {
          held.push(go);
          if (held.length === 2) for (const g of held) g();
        });
      return put(...args);
    }) as typeof put;
    const race = await Promise.allSettled(
      ['pertama', 'kedua!!'].map((Body) =>
        client.send(
          new PutObjectCommand({ Bucket: 'tf-state', Key: 'race.lock', Body, IfNoneMatch: '*' }),
        ),
      ),
    );
    rt.r2.put = put;
    expect(held).toHaveLength(2);
    expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = race.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((lost.reason as { Code?: string }).Code).toBe('PreconditionFailed');
    expect(
      (lost.reason as { $metadata: { httpStatusCode: number } }).$metadata.httpStatusCode,
    ).toBe(412);
    const winner = race.findIndex((r) => r.status === 'fulfilled');
    const kept = await client.send(new GetObjectCommand({ Bucket: 'tf-state', Key: 'race.lock' }));
    expect(await text(kept.Body)).toBe(['pertama', 'kedua!!'][winner]);
    // The loser's bytes and reservation are gone; only the winner is scanned.
    expect(usage(rt, user.userId)).toEqual({ used: 4 + 7, reserved: 0 });
    expect(await blobs(rt, user.userId)).toBe(2);
    expect(scansFor(rt, 'race.lock')).toHaveLength(1);
  });

  it('If-Match replaces only the version the client names', async () => {
    const { rt, client, user } = await s3Setup();
    await client.send(new CreateBucketCommand({ Bucket: 'data' }));
    const v1 = await client.send(
      new PutObjectCommand({ Bucket: 'data', Key: 'a.json', Body: '{}' }),
    );
    const v2 = await client.send(
      new PutObjectCommand({ Bucket: 'data', Key: 'a.json', Body: '{"n":2}', IfMatch: v1.ETag }),
    );
    expect(v2.ETag).not.toBe(v1.ETag);
    await expectS3Error(
      client.send(
        new PutObjectCommand({ Bucket: 'data', Key: 'a.json', Body: '{"n":3}', IfMatch: v1.ETag }),
      ),
      'PreconditionFailed',
      412,
    );
    // Nothing there yet: If-Match cannot hold (the roadmap's rule for S2).
    await expectS3Error(
      client.send(
        new PutObjectCommand({ Bucket: 'data', Key: 'baru.json', Body: '{}', IfMatch: v1.ETag }),
      ),
      'PreconditionFailed',
      412,
    );
    const head = await client.send(new HeadObjectCommand({ Bucket: 'data', Key: 'a.json' }));
    expect(head.ETag).toBe(v2.ETag);
    expect(usage(rt, user.userId)).toEqual({ used: 7, reserved: 0 });
    expect(await blobs(rt, user.userId)).toBe(1);

    // A replaced object starts over: new bytes, no copies yet, scanned again.
    const row = rt.d1.sqlite
      .prepare(`SELECT size, replicated, scan_status FROM s3_objects WHERE key = 'a.json'`)
      .get();
    expect(row).toEqual({ size: 7, replicated: 0, scan_status: 'pending' });
    expect(scansFor(rt, 'a.json')).toHaveLength(2);
  });

  it('checks multipart completion; a write that lands mid-completion is a 409', async () => {
    const { rt, client, user } = await s3Setup();
    await client.send(new CreateBucketCommand({ Bucket: 'multi' }));
    await client.send(new PutObjectCommand({ Bucket: 'multi', Key: 'ada.bin', Body: 'lama' }));

    const upload = async (Key: string, body: string) => {
      const up = await client.send(new CreateMultipartUploadCommand({ Bucket: 'multi', Key }));
      const part = await client.send(
        new UploadPartCommand({
          Bucket: 'multi',
          Key,
          UploadId: up.UploadId,
          PartNumber: 1,
          Body: body,
        }),
      );
      return {
        UploadId: up.UploadId!,
        MultipartUpload: { Parts: [{ ETag: part.ETag!, PartNumber: 1 }] },
      };
    };

    // The condition fails before R2 joins anything: the upload stays, its bytes still reserved.
    const u1 = await upload('ada.bin', 'baru!');
    await expectS3Error(
      client.send(
        new CompleteMultipartUploadCommand({
          Bucket: 'multi',
          Key: 'ada.bin',
          ...u1,
          IfNoneMatch: '*',
        }),
      ),
      'PreconditionFailed',
      412,
    );
    const open = await client.send(new ListMultipartUploadsCommand({ Bucket: 'multi' }));
    expect(open.Uploads?.map((u) => u.UploadId)).toEqual([u1.UploadId]);
    expect(usage(rt, user.userId)).toEqual({ used: 4, reserved: 5 });
    const head = await client.send(new HeadObjectCommand({ Bucket: 'multi', Key: 'ada.bin' }));
    // The right ETag lets the same upload finish.
    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: 'multi',
        Key: 'ada.bin',
        ...u1,
        IfMatch: head.ETag,
      }),
    );
    expect(usage(rt, user.userId)).toEqual({ used: 5, reserved: 0 });

    const u2 = await upload('kosong.bin', 'satu');
    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: 'multi',
        Key: 'kosong.bin',
        ...u2,
        IfNoneMatch: '*',
      }),
    );
    expect(usage(rt, user.userId)).toEqual({ used: 9, reserved: 0 });

    // Someone writes the key while R2 is joining the parts: the commit loses, the upload is used
    // up, and nothing of it stays.
    const u3 = await upload('balapan.bin', 'multipart');
    const resume = rt.r2.resumeMultipartUpload.bind(rt.r2);
    rt.r2.resumeMultipartUpload = (key: string, id: string) => {
      const mpu = resume(key, id);
      const complete = mpu.complete.bind(mpu);
      mpu.complete = async (parts) => {
        await client.send(
          new PutObjectCommand({ Bucket: 'multi', Key: 'balapan.bin', Body: 'cepat' }),
        );
        return complete(parts);
      };
      return mpu;
    };
    await expectS3Error(
      client.send(
        new CompleteMultipartUploadCommand({
          Bucket: 'multi',
          Key: 'balapan.bin',
          ...u3,
          IfNoneMatch: '*',
        }),
      ),
      'ConditionalRequestConflict',
      409,
    );
    rt.r2.resumeMultipartUpload = resume;
    const got = await client.send(new GetObjectCommand({ Bucket: 'multi', Key: 'balapan.bin' }));
    expect(await text(got.Body)).toBe('cepat');
    expect(
      (await client.send(new ListMultipartUploadsCommand({ Bucket: 'multi' }))).Uploads ?? [],
    ).toEqual([]);
    expect(usage(rt, user.userId)).toEqual({ used: 9 + 5, reserved: 0 });
    expect(await blobs(rt, user.userId)).toBe(3);
    expect(scansFor(rt, 'balapan.bin')).toHaveLength(1);

    // An upload that failed its condition can still be aborted.
    const u4 = await upload('ada.bin', 'lagi');
    await expectS3Error(
      client.send(
        new CompleteMultipartUploadCommand({
          Bucket: 'multi',
          Key: 'ada.bin',
          ...u4,
          IfNoneMatch: '*',
        }),
      ),
      'PreconditionFailed',
      412,
    );
    await client.send(
      new AbortMultipartUploadCommand({ Bucket: 'multi', Key: 'ada.bin', UploadId: u4.UploadId }),
    );
    expect(usage(rt, user.userId).reserved).toBe(0);
  });

  it('checks a copy against its destination and its source', async () => {
    const { rt, client, user } = await s3Setup();
    await client.send(new CreateBucketCommand({ Bucket: 'salin' }));
    const src = await client.send(
      new PutObjectCommand({ Bucket: 'salin', Key: 'src', Body: 'sumber' }),
    );
    const dst = await client.send(
      new PutObjectCommand({ Bucket: 'salin', Key: 'dst', Body: 'tujuan' }),
    );

    await expectS3Error(
      client.send(
        new CopyObjectCommand({
          Bucket: 'salin',
          Key: 'dst',
          CopySource: 'salin/src',
          IfNoneMatch: '*',
        }),
      ),
      'PreconditionFailed',
      412,
    );
    await expectS3Error(
      client.send(
        new CopyObjectCommand({
          Bucket: 'salin',
          Key: 'dst',
          CopySource: 'salin/src',
          IfMatch: src.ETag,
        }),
      ),
      'PreconditionFailed',
      412,
    );
    await client.send(
      new CopyObjectCommand({
        Bucket: 'salin',
        Key: 'baru',
        CopySource: 'salin/src',
        IfNoneMatch: '*',
      }),
    );
    await client.send(
      new CopyObjectCommand({
        Bucket: 'salin',
        Key: 'dst',
        CopySource: 'salin/src',
        IfMatch: dst.ETag,
      }),
    );
    const now = await client.send(new GetObjectCommand({ Bucket: 'salin', Key: 'dst' }));
    expect(await text(now.Body)).toBe('sumber');

    // Onto itself (metadata only): If-Match is checked in the same UPDATE.
    await expectS3Error(
      client.send(
        new CopyObjectCommand({
          Bucket: 'salin',
          Key: 'src',
          CopySource: 'salin/src',
          MetadataDirective: 'REPLACE',
          ContentType: 'text/plain',
          IfMatch: '"0123456789abcdef0123456789abcdef"',
        }),
      ),
      'PreconditionFailed',
      412,
    );
    await client.send(
      new CopyObjectCommand({
        Bucket: 'salin',
        Key: 'src',
        CopySource: 'salin/src',
        MetadataDirective: 'REPLACE',
        ContentType: 'text/plain',
        IfMatch: src.ETag,
      }),
    );
    expect(
      (await client.send(new HeadObjectCommand({ Bucket: 'salin', Key: 'src' }))).ContentType,
    ).toBe('text/plain');

    // The source's dates were ignored before; now they count, like Amazon.
    const tomorrow = new Date(Date.now() + 86_400_000);
    const yesterday = new Date(Date.now() - 86_400_000);
    await expectS3Error(
      client.send(
        new CopyObjectCommand({
          Bucket: 'salin',
          Key: 'x',
          CopySource: 'salin/src',
          CopySourceIfModifiedSince: tomorrow,
        }),
      ),
      'PreconditionFailed',
      412,
    );
    await expectS3Error(
      client.send(
        new CopyObjectCommand({
          Bucket: 'salin',
          Key: 'x',
          CopySource: 'salin/src',
          CopySourceIfUnmodifiedSince: yesterday,
        }),
      ),
      'PreconditionFailed',
      412,
    );
    // A matching ETag outranks the unmodified date.
    await client.send(
      new CopyObjectCommand({
        Bucket: 'salin',
        Key: 'x',
        CopySource: 'salin/src',
        CopySourceIfMatch: src.ETag,
        CopySourceIfUnmodifiedSince: yesterday,
      }),
    );
    // src, dst, baru, x: each with its own bytes, nothing left of the failed copies.
    expect(usage(rt, user.userId)).toEqual({ used: 6 * 4, reserved: 0 });
    expect(await blobs(rt, user.userId)).toBe(4);
  });

  it('refuses conditions it does not support instead of ignoring them', async () => {
    const { rt, client, user, key } = await s3Setup();
    await client.send(new CreateBucketCommand({ Bucket: 'tolak' }));
    const v1 = await client.send(new PutObjectCommand({ Bucket: 'tolak', Key: 'a', Body: 'satu' }));

    // If-None-Match on a write only takes "*"; If-Match only one ETag.
    await expectS3Error(
      client.send(
        new PutObjectCommand({ Bucket: 'tolak', Key: 'a', Body: 'dua', IfNoneMatch: v1.ETag }),
      ),
      'NotImplemented',
      501,
    );
    await expectS3Error(
      client.send(
        new PutObjectCommand({
          Bucket: 'tolak',
          Key: 'a',
          Body: 'dua',
          IfMatch: `${v1.ETag}, "x"`,
        }),
      ),
      'NotImplemented',
      501,
    );
    await expectS3Error(
      client.send(new DeleteObjectCommand({ Bucket: 'tolak', Key: 'a', IfMatch: v1.ETag })),
      'NotImplemented',
      501,
    );
    const many = await client.send(
      new DeleteObjectsCommand({
        Bucket: 'tolak',
        Delete: { Objects: [{ Key: 'a', ETag: v1.ETag }] },
      }),
    );
    expect(many.Errors?.map((e) => e.Code)).toEqual(['NotImplemented']);
    expect(many.Deleted ?? []).toEqual([]);

    const { s3Client } = await import('../helpers/s3');
    const dated = s3Client(rt, key);
    withHeader(dated, 'if-unmodified-since', new Date().toUTCString());
    await expectS3Error(
      dated.send(new PutObjectCommand({ Bucket: 'tolak', Key: 'a', Body: 'dua' })),
      'NotImplemented',
      501,
    );
    const up = await client.send(new CreateMultipartUploadCommand({ Bucket: 'tolak', Key: 'b' }));
    await expectS3Error(
      dated.send(
        new UploadPartCommand({
          Bucket: 'tolak',
          Key: 'b',
          UploadId: up.UploadId,
          PartNumber: 1,
          Body: 'x',
        }),
      ),
      'NotImplemented',
      501,
    );
    // Nothing changed.
    const head = await client.send(new HeadObjectCommand({ Bucket: 'tolak', Key: 'a' }));
    expect(head.ETag).toBe(v1.ETag);
    expect(usage(rt, user.userId)).toEqual({ used: 4, reserved: 0 });
  });
});
