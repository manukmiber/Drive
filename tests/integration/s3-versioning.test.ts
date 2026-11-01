// Zeiko S3 versioning (ADR-092, S5) through the real AWS SDK v3: versions kept on overwrite and
// delete, delete markers, reading and restoring old versions, listing, storage per version,
// Suspended's null version, and lifecycle for older versions.
import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  PutBucketLifecycleConfigurationCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { CRON, DAY_MS } from '../../src/shared/constants';
import { FakeClock } from '../../src/worker/adapters/clock';
import { makeRuntime } from '../helpers/runtime';
import { OPS_KEY, S3_ORIGIN, s3Setup, usage } from '../helpers/s3';

const text = async (body: unknown) =>
  (body as { transformToString(): Promise<string> }).transformToString();

async function expectS3Error(p: Promise<unknown>, code: string, status: number) {
  try {
    await p;
  } catch (e) {
    const err = e as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
    expect(err.Code ?? err.name).toBe(code);
    expect(err.$metadata?.httpStatusCode).toBe(status);
    return e;
  }
  throw new Error(`expected ${code}`);
}

async function versioned(Bucket: string) {
  const s = await s3Setup();
  await s.client.send(new CreateBucketCommand({ Bucket }));
  await s.client.send(
    new PutBucketVersioningCommand({ Bucket, VersioningConfiguration: { Status: 'Enabled' } }),
  );
  return s;
}

describe('Zeiko S3 versioning', () => {
  it('keeps every version, reads any of them, and counts them all toward storage', async () => {
    const s = await versioned('arsip');
    expect((await s.client.send(new GetBucketVersioningCommand({ Bucket: 'arsip' }))).Status).toBe(
      'Enabled',
    );
    const v1 = await s.client.send(
      new PutObjectCommand({ Bucket: 'arsip', Key: 'laporan.txt', Body: 'satu' }),
    );
    const v2 = await s.client.send(
      new PutObjectCommand({ Bucket: 'arsip', Key: 'laporan.txt', Body: 'dua!!' }),
    );
    expect(v1.VersionId).toMatch(/^[0-9A-Z]{26}$/);
    expect(v2.VersionId).not.toBe(v1.VersionId);
    // Both kept: 4 + 5 bytes.
    expect(usage(s.rt, s.user.userId).used).toBe(9);
    const now = await s.client.send(new GetObjectCommand({ Bucket: 'arsip', Key: 'laporan.txt' }));
    expect(await text(now.Body)).toBe('dua!!');
    expect(now.VersionId).toBe(v2.VersionId);
    const old = await s.client.send(
      new GetObjectCommand({ Bucket: 'arsip', Key: 'laporan.txt', VersionId: v1.VersionId }),
    );
    expect(await text(old.Body)).toBe('satu');
    const head = await s.client.send(
      new HeadObjectCommand({ Bucket: 'arsip', Key: 'laporan.txt', VersionId: v1.VersionId }),
    );
    expect(head.ContentLength).toBe(4);
    await expectS3Error(
      s.client.send(
        new GetObjectCommand({
          Bucket: 'arsip',
          Key: 'laporan.txt',
          VersionId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        }),
      ),
      'NoSuchVersion',
      404,
    );
    // Plain listings still show one object.
    const list = await s.client.send(new ListObjectsV2Command({ Bucket: 'arsip' }));
    expect(list.Contents?.map((c) => [c.Key, c.Size])).toEqual([['laporan.txt', 5]]);
  });

  it('a delete leaves a marker; deleting the marker brings the object back', async () => {
    const s = await versioned('arsip');
    const v1 = await s.client.send(
      new PutObjectCommand({ Bucket: 'arsip', Key: 'foto.jpg', Body: 'gambar' }),
    );
    const del = await s.client.send(new DeleteObjectCommand({ Bucket: 'arsip', Key: 'foto.jpg' }));
    expect(del.DeleteMarker).toBe(true);
    expect(del.VersionId).toMatch(/^[0-9A-Z]{26}$/);
    // Gone from view, still stored and counted.
    expect((await s.client.send(new ListObjectsV2Command({ Bucket: 'arsip' }))).KeyCount).toBe(0);
    const missing = (await expectS3Error(
      s.client.send(new GetObjectCommand({ Bucket: 'arsip', Key: 'foto.jpg' })),
      'NoSuchKey',
      404,
    )) as { $response?: { headers: Record<string, string> } };
    expect(missing.$response?.headers['x-amz-delete-marker']).toBe('true');
    await expectS3Error(
      s.client.send(
        new GetObjectCommand({ Bucket: 'arsip', Key: 'foto.jpg', VersionId: del.VersionId }),
      ),
      'MethodNotAllowed',
      405,
    );
    expect(usage(s.rt, s.user.userId).used).toBe(6);
    const versions = await s.client.send(new ListObjectVersionsCommand({ Bucket: 'arsip' }));
    expect(versions.DeleteMarkers?.map((m) => [m.Key, m.VersionId, m.IsLatest])).toEqual([
      ['foto.jpg', del.VersionId, true],
    ]);
    expect(versions.Versions?.map((v) => [v.Key, v.VersionId, v.IsLatest])).toEqual([
      ['foto.jpg', v1.VersionId, false],
    ]);
    // A bucket with versions left is not empty.
    await expectS3Error(
      s.client.send(new DeleteBucketCommand({ Bucket: 'arsip' })),
      'BucketNotEmpty',
      409,
    );
    // Removing the marker for good: the photo is back.
    const undo = await s.client.send(
      new DeleteObjectCommand({ Bucket: 'arsip', Key: 'foto.jpg', VersionId: del.VersionId }),
    );
    expect(undo.DeleteMarker).toBe(true);
    const back = await s.client.send(new GetObjectCommand({ Bucket: 'arsip', Key: 'foto.jpg' }));
    expect(await text(back.Body)).toBe('gambar');
    expect(back.VersionId).toBe(v1.VersionId);
  });

  it('deleting the current version for good puts the one before it back; copying restores', async () => {
    const s = await versioned('arsip');
    const v1 = await s.client.send(
      new PutObjectCommand({ Bucket: 'arsip', Key: 'a.txt', Body: 'v1' }),
    );
    const v2 = await s.client.send(
      new PutObjectCommand({ Bucket: 'arsip', Key: 'a.txt', Body: 'v22' }),
    );
    await s.client.send(
      new DeleteObjectCommand({ Bucket: 'arsip', Key: 'a.txt', VersionId: v2.VersionId }),
    );
    expect(usage(s.rt, s.user.userId).used).toBe(2);
    const now = await s.client.send(new GetObjectCommand({ Bucket: 'arsip', Key: 'a.txt' }));
    expect(await text(now.Body)).toBe('v1');
    expect(now.VersionId).toBe(v1.VersionId);
    // Restore by copying an older version over the current one (what consoles do).
    const v3 = await s.client.send(
      new PutObjectCommand({ Bucket: 'arsip', Key: 'a.txt', Body: 'v333' }),
    );
    const copy = await s.client.send(
      new CopyObjectCommand({
        Bucket: 'arsip',
        Key: 'a.txt',
        CopySource: `arsip/a.txt?versionId=${v1.VersionId}`,
      }),
    );
    expect(copy.CopySourceVersionId).toBe(v1.VersionId);
    expect(copy.VersionId).not.toBe(v3.VersionId);
    const restored = await s.client.send(new GetObjectCommand({ Bucket: 'arsip', Key: 'a.txt' }));
    expect(await text(restored.Body)).toBe('v1');
    const all = await s.client.send(
      new ListObjectVersionsCommand({ Bucket: 'arsip', Prefix: 'a.txt' }),
    );
    expect(all.Versions?.map((v) => v.VersionId)).toEqual([
      copy.VersionId,
      v3.VersionId,
      v1.VersionId,
    ]);
    expect(usage(s.rt, s.user.userId).used).toBe(2 + 4 + 2);
  });

  it('DeleteObjects makes markers, or removes named versions', async () => {
    const s = await versioned('massal');
    const put = async (Key: string) =>
      (await s.client.send(new PutObjectCommand({ Bucket: 'massal', Key, Body: Key }))).VersionId!;
    const a = await put('a');
    await put('b');
    const res = await s.client.send(
      new DeleteObjectsCommand({
        Bucket: 'massal',
        Delete: { Objects: [{ Key: 'a', VersionId: a }, { Key: 'b' }] },
      }),
    );
    const byKey = Object.fromEntries((res.Deleted ?? []).map((d) => [d.Key, d]));
    expect(byKey.a?.VersionId).toBe(a);
    expect(byKey.a?.DeleteMarker).toBeUndefined();
    expect(byKey.b?.DeleteMarker).toBe(true);
    expect(byKey.b?.DeleteMarkerVersionId).toMatch(/^[0-9A-Z]{26}$/);
    expect(usage(s.rt, s.user.userId).used).toBe(1);
  });

  it('paginates versions with key and version markers, and rolls up prefixes', async () => {
    const s = await versioned('banyak');
    for (const Key of ['f/1', 'f/2', 'x'])
      for (let i = 0; i < 3; i++)
        await s.client.send(new PutObjectCommand({ Bucket: 'banyak', Key, Body: `${Key}${i}` }));
    const seen: string[] = [];
    let KeyMarker: string | undefined;
    let VersionIdMarker: string | undefined;
    for (let page = 0; page < 10; page++) {
      const r = await s.client.send(
        new ListObjectVersionsCommand({ Bucket: 'banyak', MaxKeys: 2, KeyMarker, VersionIdMarker }),
      );
      seen.push(...(r.Versions ?? []).map((v) => `${v.Key}${v.IsLatest ? '*' : ''}`));
      if (!r.IsTruncated) break;
      KeyMarker = r.NextKeyMarker;
      VersionIdMarker = r.NextVersionIdMarker;
    }
    expect(seen).toEqual(['f/1*', 'f/1', 'f/1', 'f/2*', 'f/2', 'f/2', 'x*', 'x', 'x']);
    const rolled = await s.client.send(
      new ListObjectVersionsCommand({ Bucket: 'banyak', Delimiter: '/' }),
    );
    expect(rolled.CommonPrefixes?.map((p) => p.Prefix)).toEqual(['f/']);
    expect(rolled.Versions?.map((v) => v.Key)).toEqual(['x', 'x', 'x']);
  });

  it('Suspended writes the null version, replacing the older null version only', async () => {
    const s = await s3Setup();
    await s.client.send(new CreateBucketCommand({ Bucket: 'jeda' }));
    // Written before versioning: the null version.
    await s.client.send(new PutObjectCommand({ Bucket: 'jeda', Key: 'k', Body: 'awal' }));
    await s.client.send(
      new PutBucketVersioningCommand({
        Bucket: 'jeda',
        VersioningConfiguration: { Status: 'Enabled' },
      }),
    );
    const v = await s.client.send(
      new PutObjectCommand({ Bucket: 'jeda', Key: 'k', Body: 'versi' }),
    );
    await s.client.send(
      new PutBucketVersioningCommand({
        Bucket: 'jeda',
        VersioningConfiguration: { Status: 'Suspended' },
      }),
    );
    const n1 = await s.client.send(
      new PutObjectCommand({ Bucket: 'jeda', Key: 'k', Body: 'null-1' }),
    );
    expect(n1.VersionId).toBe('null');
    const n2 = await s.client.send(
      new PutObjectCommand({ Bucket: 'jeda', Key: 'k', Body: 'null-22' }),
    );
    expect(n2.VersionId).toBe('null');
    const list = await s.client.send(new ListObjectVersionsCommand({ Bucket: 'jeda' }));
    // The first null version ("awal") was replaced by the suspended writes; "versi" is kept.
    expect(list.Versions?.map((x) => [x.VersionId, x.Size, x.IsLatest])).toEqual([
      ['null', 7, true],
      [v.VersionId, 5, false],
    ]);
    expect(usage(s.rt, s.user.userId).used).toBe(12);
    const del = await s.client.send(new DeleteObjectCommand({ Bucket: 'jeda', Key: 'k' }));
    expect(del.VersionId).toBe('null');
    expect(del.DeleteMarker).toBe(true);
    // The null version went with it; "versi" stays.
    expect(usage(s.rt, s.user.userId).used).toBe(5);
    expect(await s.rt.d1.sqlite.prepare('SELECT COUNT(*) AS n FROM s3_versions').get()).toEqual({
      n: 2,
    });
  });

  it('lifecycle removes older versions after NoncurrentDays and markers left alone', async () => {
    const clock = new FakeClock(Date.UTC(2026, 10, 1, 9, 30));
    const rt = await makeRuntime({ vars: { ZEIKO_OPS_TOKEN: OPS_KEY, S3_ORIGIN }, clock });
    const s = await s3Setup({ rt });
    await s.client.send(new CreateBucketCommand({ Bucket: 'siklus' }));
    await s.client.send(
      new PutBucketVersioningCommand({
        Bucket: 'siklus',
        VersioningConfiguration: { Status: 'Enabled' },
      }),
    );
    await s.client.send(new PutObjectCommand({ Bucket: 'siklus', Key: 'log/a', Body: 'lama' }));
    await s.client.send(new PutObjectCommand({ Bucket: 'siklus', Key: 'log/a', Body: 'baru' }));
    await s.client.send(new PutObjectCommand({ Bucket: 'siklus', Key: 'log/b', Body: 'b' }));
    await s.client.send(new DeleteObjectCommand({ Bucket: 'siklus', Key: 'log/b' }));
    await s.client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: 'siklus',
        LifecycleConfiguration: {
          Rules: [
            {
              ID: 'versi-lama',
              Status: 'Enabled',
              Filter: { Prefix: 'log/' },
              NoncurrentVersionExpiration: { NoncurrentDays: 1 },
            },
            {
              ID: 'penanda',
              Status: 'Enabled',
              Filter: { Prefix: 'log/' },
              Expiration: { ExpiredObjectDeleteMarker: true },
            },
          ],
        },
      }),
    );
    clock.set(Date.UTC(2026, 10, 3, 1, 0));
    for (let i = 0; i < 4; i++) await rt.runCron(CRON.hourly);
    // The old "lama" and b's old version went; b's marker had nothing left behind it next pass.
    clock.advance(DAY_MS);
    for (let i = 0; i < 4; i++) await rt.runCron(CRON.hourly);
    const left = await s.client.send(new ListObjectVersionsCommand({ Bucket: 'siklus' }));
    expect(left.Versions?.map((v) => [v.Key, v.IsLatest])).toEqual([['log/a', true]]);
    expect(left.DeleteMarkers ?? []).toEqual([]);
    expect(usage(rt, s.user.userId).used).toBe(4);
  });

  it('the /s3 page lists versions, brings deleted files back and links to a version', async () => {
    const s = await s3Setup();
    await s.client.send(new CreateBucketCommand({ Bucket: 'web' }));
    const on = await s.user.req('PATCH', '/api/s3/buckets/web', { versioning: 'Enabled' });
    expect(on.status).toBe(204);
    const page = (await (await s.user.req('GET', '/api/s3')).json()) as {
      buckets: Array<{ name: string; versioning: string }>;
    };
    expect(page.buckets[0]?.versioning).toBe('Enabled');
    const v1 = await s.client.send(
      new PutObjectCommand({ Bucket: 'web', Key: 'doc/a.txt', Body: 'satu' }),
    );
    await s.client.send(new PutObjectCommand({ Bucket: 'web', Key: 'doc/a.txt', Body: 'dua' }));
    await s.client.send(new DeleteObjectCommand({ Bucket: 'web', Key: 'doc/a.txt' }));
    const deleted = (await (
      await s.user.req('GET', '/api/s3/buckets/web/deleted?prefix=doc/')
    ).json()) as {
      items: Array<{ key: string; markerId: string }>;
    };
    expect(deleted.items.map((d) => d.key)).toEqual(['doc/a.txt']);
    const list = (await (
      await s.user.req('GET', '/api/s3/buckets/web/versions?key=doc/a.txt')
    ).json()) as {
      versions: Array<{ versionId: string; deleteMarker: boolean; isLatest: boolean }>;
    };
    expect(list.versions.map((v) => [v.deleteMarker, v.isLatest])).toEqual([
      [true, true],
      [false, false],
      [false, false],
    ]);
    // Bring it back (the marker goes), then restore the first version over it.
    const back = await s.user.req('POST', '/api/s3/buckets/web/versions/restore', {
      key: 'doc/a.txt',
      versionId: deleted.items[0]!.markerId,
    });
    expect(back.status).toBe(204);
    const r1 = await s.user.req('POST', '/api/s3/buckets/web/versions/restore', {
      key: 'doc/a.txt',
      versionId: v1.VersionId,
    });
    expect(r1.status).toBe(204);
    const now = await s.client.send(new GetObjectCommand({ Bucket: 'web', Key: 'doc/a.txt' }));
    expect(await text(now.Body)).toBe('satu');
    // A link to the old version reads that version, and can't be bent into another.
    const link = (await (
      await s.user.req('POST', '/api/s3/buckets/web/objects/link', {
        key: 'doc/a.txt',
        versionId: v1.VersionId,
        download: false,
      })
    ).json()) as { url: string };
    expect(new URL(link.url).searchParams.get('versionId')).toBe(v1.VersionId);
    const got = await s.rt.fetch(new Request(link.url));
    expect(await got.text()).toBe('satu');
    const bent = new URL(link.url);
    bent.searchParams.set('versionId', now.VersionId!);
    expect((await s.rt.fetch(new Request(bent.toString()))).status).toBe(403);
    // Removing a version for good.
    const gone = await s.user.req('POST', '/api/s3/buckets/web/versions/delete', {
      key: 'doc/a.txt',
      versionId: v1.VersionId,
    });
    expect(gone.status).toBe(204);
    const after = (await (
      await s.user.req('GET', '/api/s3/buckets/web/versions?key=doc/a.txt')
    ).json()) as { versions: Array<{ versionId: string }> };
    expect(after.versions.map((v) => v.versionId)).not.toContain(v1.VersionId);
  });
});
