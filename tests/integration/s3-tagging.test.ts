// Object tags in Zeiko S3 (S8 part 1, ADR-076), through the real AWS SDK: on PutObject, multipart and
// CopyObject, Put/Get/DeleteObjectTagging, Amazon's limits, who may read and write them, and lifecycle
// rules that pick objects by tag.
import {
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectTaggingCommand,
  GetBucketTaggingCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  PutObjectTaggingCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { CRON, DAY_MS } from '../../src/shared/constants';
import { FakeClock } from '../../src/worker/adapters/clock';
import { lifecycleXml, parseLifecycleXml } from '../../src/worker/services/s3-lifecycle';
import { tagsFromHeader } from '../../src/worker/services/s3-tags';
import { makeRuntime } from '../helpers/runtime';
import { OPS_KEY, S3_ORIGIN, s3Client, s3Setup } from '../helpers/s3';

async function s3Code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { name?: string; Code?: string };
    return err.Code ?? err.name ?? 'unknown';
  }
  return 'ok';
}

const tagSet = async (client: ReturnType<typeof s3Client>, Bucket: string, Key: string) =>
  ((await client.send(new GetObjectTaggingCommand({ Bucket, Key }))).TagSet ?? []).map(
    (t) => `${t.Key}=${t.Value}`,
  );

describe('object tags (S8, ADR-076)', () => {
  it('tags on PutObject, Put/Get/DeleteObjectTagging, and the count on GetObject', async () => {
    const { client } = await s3Setup();
    await client.send(new CreateBucketCommand({ Bucket: 'tagged' }));
    const put = await client.send(
      new PutObjectCommand({
        Bucket: 'tagged',
        Key: 'a.txt',
        Body: 'halo',
        Tagging: 'proyek=zeiko&tahap=uji%20coba&kosong=',
      }),
    );
    expect(await tagSet(client, 'tagged', 'a.txt')).toEqual([
      'proyek=zeiko',
      'tahap=uji coba',
      'kosong=',
    ]);
    const got = await client.send(new GetObjectCommand({ Bucket: 'tagged', Key: 'a.txt' }));
    expect(got.TagCount).toBe(3);
    await got.Body!.transformToString();

    await client.send(
      new PutObjectTaggingCommand({
        Bucket: 'tagged',
        Key: 'a.txt',
        Tagging: { TagSet: [{ Key: 'kelas', Value: 'arsip' }] },
      }),
    );
    expect(await tagSet(client, 'tagged', 'a.txt')).toEqual(['kelas=arsip']);
    // Tags don't change the object.
    const head = await client.send(new HeadObjectCommand({ Bucket: 'tagged', Key: 'a.txt' }));
    expect(head.ETag).toBe(put.ETag);

    await client.send(new DeleteObjectTaggingCommand({ Bucket: 'tagged', Key: 'a.txt' }));
    expect(await tagSet(client, 'tagged', 'a.txt')).toEqual([]);
    const plain = await client.send(new GetObjectCommand({ Bucket: 'tagged', Key: 'a.txt' }));
    expect(plain.TagCount).toBeUndefined();
    await plain.Body!.transformToString();

    expect(
      await s3Code(client.send(new GetObjectTaggingCommand({ Bucket: 'tagged', Key: 'x' }))),
    ).toBe('NoSuchKey');
    // A bucket's own tags aren't kept.
    expect(await s3Code(client.send(new GetBucketTaggingCommand({ Bucket: 'tagged' })))).toBe(
      'NotImplemented',
    );
  });

  it("keeps to Amazon's limits", async () => {
    const { client } = await s3Setup();
    await client.send(new CreateBucketCommand({ Bucket: 'batas' }));
    await client.send(new PutObjectCommand({ Bucket: 'batas', Key: 'a', Body: 'a' }));
    const tag = (TagSet: Array<{ Key: string; Value: string }>) =>
      s3Code(
        client.send(
          new PutObjectTaggingCommand({ Bucket: 'batas', Key: 'a', Tagging: { TagSet } }),
        ),
      );
    const ten = Array.from({ length: 10 }, (_, i) => ({ Key: `k${i}`, Value: `v${i}` }));
    expect(await tag(ten)).toBe('ok');
    expect(await tag([...ten, { Key: 'k10', Value: 'x' }])).toBe('InvalidTag');
    expect(
      await tag([
        { Key: 'a', Value: '1' },
        { Key: 'a', Value: '2' },
      ]),
    ).toBe('InvalidTag');
    expect(await tag([{ Key: 'aws:x', Value: '1' }])).toBe('InvalidTag');
    expect(await tag([{ Key: 'k'.repeat(129), Value: '1' }])).toBe('InvalidTag');
    expect(await tag([{ Key: 'k', Value: 'v'.repeat(257) }])).toBe('InvalidTag');
    expect(await tag([{ Key: 'k', Value: 'tanda<ini>' }])).toBe('InvalidTag');
    expect(await tag([{ Key: 'Proyek Ü 2026', Value: 'a+b=c.d_e:f/g@h-i' }])).toBe('ok');
    expect(
      await s3Code(
        client.send(
          new PutObjectCommand({ Bucket: 'batas', Key: 'b', Body: 'b', Tagging: 'a=1&a=2' }),
        ),
      ),
    ).toBe('InvalidTag');
    expect(tagsFromHeader('a=1&b&c=%C3%A9')).toEqual([
      { key: 'a', value: '1' },
      { key: 'b', value: '' },
      { key: 'c', value: 'é' },
    ]);
  });

  it('multipart takes the tags given at the start; CopyObject copies or replaces them', async () => {
    const { client } = await s3Setup();
    await client.send(new CreateBucketCommand({ Bucket: 'salin' }));
    const up = await client.send(
      new CreateMultipartUploadCommand({
        Bucket: 'salin',
        Key: 'mp.bin',
        Tagging: 'asal=multipart',
      }),
    );
    const part = await client.send(
      new UploadPartCommand({
        Bucket: 'salin',
        Key: 'mp.bin',
        UploadId: up.UploadId,
        PartNumber: 1,
        Body: 'isi',
      }),
    );
    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: 'salin',
        Key: 'mp.bin',
        UploadId: up.UploadId,
        MultipartUpload: { Parts: [{ PartNumber: 1, ETag: part.ETag }] },
      }),
    );
    expect(await tagSet(client, 'salin', 'mp.bin')).toEqual(['asal=multipart']);

    await client.send(
      new CopyObjectCommand({ Bucket: 'salin', Key: 'copy.bin', CopySource: 'salin/mp.bin' }),
    );
    expect(await tagSet(client, 'salin', 'copy.bin')).toEqual(['asal=multipart']);
    await client.send(
      new CopyObjectCommand({
        Bucket: 'salin',
        Key: 'baru.bin',
        CopySource: 'salin/mp.bin',
        TaggingDirective: 'REPLACE',
        Tagging: 'asal=salinan',
      }),
    );
    expect(await tagSet(client, 'salin', 'baru.bin')).toEqual(['asal=salinan']);
    // REPLACE without tags clears them; onto itself, only the tags change.
    await client.send(
      new CopyObjectCommand({
        Bucket: 'salin',
        Key: 'copy.bin',
        CopySource: 'salin/copy.bin',
        TaggingDirective: 'REPLACE',
      }),
    );
    expect(await tagSet(client, 'salin', 'copy.bin')).toEqual([]);
  });

  it('read-only keys read tags, may not write them; strangers on a public bucket see none', async () => {
    const s = await s3Setup();
    await s.client.send(new CreateBucketCommand({ Bucket: 'umum', ACL: 'public-read' }));
    await s.client.send(
      new PutObjectCommand({ Bucket: 'umum', Key: 'a.txt', Body: 'a', Tagging: 'r=1' }),
    );
    const made = await s.user.req('POST', '/api/s3/keys', { label: 'baca', access: 'r' });
    expect(made.status).toBe(201);
    const ro = (await made.json()) as { key: { id: string; secret: string } };
    const reader = s3Client(s.rt, ro.key);
    expect(await tagSet(reader, 'umum', 'a.txt')).toEqual(['r=1']);
    expect(
      await s3Code(
        reader.send(
          new PutObjectTaggingCommand({ Bucket: 'umum', Key: 'a.txt', Tagging: { TagSet: [] } }),
        ),
      ),
    ).toBe('AccessDenied');
    expect(
      await s3Code(reader.send(new DeleteObjectTaggingCommand({ Bucket: 'umum', Key: 'a.txt' }))),
    ).toBe('AccessDenied');

    const anon = await s.rt.fetch(new Request(`${S3_ORIGIN}/umum/a.txt?tagging`));
    expect(anon.status).toBe(403);
    const anonGet = await s.rt.fetch(new Request(`${S3_ORIGIN}/umum/a.txt`));
    expect(anonGet.headers.get('x-amz-tagging-count')).toBeNull();
    // Another account's key: not its bucket.
    const other = await s3Setup({ rt: s.rt, email: 'lain@zeiko.test' });
    expect(
      await s3Code(
        other.client.send(new GetObjectTaggingCommand({ Bucket: 'umum', Key: 'a.txt' })),
      ),
    ).toBe('AccessDenied');
  });
});

describe('lifecycle rules by tag (ADR-076)', () => {
  it('parses and writes Tag and And filters', () => {
    const xml = `<LifecycleConfiguration>
      <Rule><ID>satu</ID><Status>Enabled</Status>
        <Filter><Tag><Key>hapus</Key><Value>ya</Value></Tag></Filter>
        <Expiration><Days>3</Days></Expiration></Rule>
      <Rule><ID>dua</ID><Status>Enabled</Status>
        <Filter><And><Prefix>log/</Prefix><Tag><Key>a</Key><Value>1</Value></Tag><Tag><Key>b</Key><Value>2</Value></Tag><ObjectSizeGreaterThan>10</ObjectSizeGreaterThan></And></Filter>
        <Expiration><Days>1</Days></Expiration></Rule>
    </LifecycleConfiguration>`;
    const rules = parseLifecycleXml(xml, 10);
    expect(rules[0]).toMatchObject({ prefix: '', tags: [{ key: 'hapus', value: 'ya' }] });
    expect(rules[1]).toMatchObject({
      prefix: 'log/',
      sizeGreaterThan: 10,
      tags: [
        { key: 'a', value: '1' },
        { key: 'b', value: '2' },
      ],
    });
    const out = lifecycleXml(rules);
    expect(out).toContain('<Filter><Tag><Key>hapus</Key><Value>ya</Value></Tag></Filter>');
    expect(out).toContain('<And><Prefix>log/</Prefix><Tag><Key>a</Key>');
    expect(parseLifecycleXml(out, 10)).toEqual(rules);
    // Abort can't go with tags (Amazon's rule).
    expect(() =>
      parseLifecycleXml(
        `<LifecycleConfiguration><Rule><Status>Enabled</Status><Filter><Tag><Key>a</Key><Value>b</Value></Tag></Filter><AbortIncompleteMultipartUpload><DaysAfterInitiation>1</DaysAfterInitiation></AbortIncompleteMultipartUpload></Rule></LifecycleConfiguration>`,
        10,
      ),
    ).toThrow(/Tags/);
  });

  it('the hourly run deletes only objects with every tag of the rule', async () => {
    const START = Date.UTC(2026, 10, 1, 12, 0);
    const clock = new FakeClock(START);
    const rt = await makeRuntime({ vars: { ZEIKO_OPS_TOKEN: OPS_KEY, S3_ORIGIN }, clock });
    const { client } = await s3Setup({ rt });
    await client.send(new CreateBucketCommand({ Bucket: 'siklus' }));
    const put = (Key: string, Tagging?: string) =>
      client.send(new PutObjectCommand({ Bucket: 'siklus', Key, Body: Key, Tagging }));
    await put('a-dua-tag', 'hapus=ya&tim=x');
    await put('b-satu-tag', 'hapus=ya');
    await put('c-nilai-lain', 'hapus=tidak&tim=x');
    await put('d-tanpa-tag');
    await client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: 'siklus',
        LifecycleConfiguration: {
          Rules: [
            {
              ID: 'bertag',
              Status: 'Enabled',
              Filter: {
                And: {
                  Prefix: '',
                  Tags: [
                    { Key: 'hapus', Value: 'ya' },
                    { Key: 'tim', Value: 'x' },
                  ],
                },
              },
              Expiration: { Days: 1 },
            },
          ],
        },
      }),
    );
    clock.set(START + 2 * DAY_MS);
    await rt.runCron(CRON.hourly);
    const left = await client.send(new ListObjectsV2Command({ Bucket: 'siklus' }));
    expect((left.Contents ?? []).map((o) => o.Key)).toEqual([
      'b-satu-tag',
      'c-nilai-lain',
      'd-tanpa-tag',
    ]);
  });
});
