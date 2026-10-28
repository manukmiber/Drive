// Restricted Zeiko S3 access keys (ADR-071): buckets, a prefix, read/write and an end date, through
// the real AWS SDK; presigned URLs follow the same rules; old keys keep full access.
import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutBucketCorsCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { describe, expect, it } from 'vitest';
import { S3_ORIGIN, s3Client, s3Setup, type S3Setup } from '../helpers/s3';
import { signIn } from '../helpers/session';

const text = async (body: unknown) =>
  (body as { transformToString(): Promise<string> }).transformToString();

async function denied(p: Promise<unknown>, code = 'AccessDenied', status = 403) {
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

interface Scope {
  buckets?: string[] | null;
  prefix?: string | null;
  access?: 'rw' | 'r' | 'w';
  expiresAt?: number | null;
}

/** A second key of the same account with this scope, and a client signing with it. */
async function scopedKey(s: S3Setup, scope: Scope, label = 'terbatas') {
  const res = await s.user.req('POST', '/api/s3/keys', { label, ...scope });
  if (res.status !== 201) throw new Error(`key: ${res.status} ${await res.text()}`);
  const key = ((await res.json()) as { key: { id: string; secret: string } & Scope }).key;
  return { key, client: s3Client(s.rt, key) };
}

/** Two buckets with a file under foto/ and one under dokumen/ in each. */
async function seeded() {
  const s = await s3Setup();
  for (const Bucket of ['satu', 'dua']) {
    await s.client.send(new CreateBucketCommand({ Bucket }));
    await s.client.send(new PutObjectCommand({ Bucket, Key: 'foto/a.jpg', Body: `${Bucket}-a` }));
    await s.client.send(
      new PutObjectCommand({ Bucket, Key: 'dokumen/b.txt', Body: `${Bucket}-b` }),
    );
  }
  return s;
}

describe('Zeiko S3 restricted keys', () => {
  it('a key made without a scope has full access, and the key list says what each may do', async () => {
    const s = await seeded();
    await s.client.send(new CreateBucketCommand({ Bucket: 'tiga' }));
    await s.client.send(new DeleteBucketCommand({ Bucket: 'tiga' }));
    await scopedKey(s, { buckets: ['satu'], access: 'r' }, 'baca');
    const overview = (await (await s.user.req('GET', '/api/s3')).json()) as {
      keys: Array<{ label: string } & Scope>;
    };
    expect(overview.keys.map((k) => [k.label, k.buckets, k.prefix, k.access, k.expiresAt])).toEqual(
      [
        ['laptop', null, null, 'rw', null],
        ['baca', ['satu'], null, 'r', null],
      ],
    );
  });

  it('a bucket-limited key sees and uses only its buckets, and manages none', async () => {
    const s = await seeded();
    const { client } = await scopedKey(s, { buckets: ['satu'] });
    const listed = await client.send(new ListBucketsCommand({}));
    expect(listed.Buckets?.map((b) => b.Name)).toEqual(['satu']);
    await client.send(new HeadBucketCommand({ Bucket: 'satu' }));
    const got = await client.send(new GetObjectCommand({ Bucket: 'satu', Key: 'foto/a.jpg' }));
    expect(await text(got.Body)).toBe('satu-a');
    await client.send(new PutObjectCommand({ Bucket: 'satu', Key: 'baru.txt', Body: 'x' }));
    await denied(client.send(new GetObjectCommand({ Bucket: 'dua', Key: 'foto/a.jpg' })));
    await denied(client.send(new ListObjectsV2Command({ Bucket: 'dua' })));
    await denied(client.send(new PutObjectCommand({ Bucket: 'dua', Key: 'x', Body: 'x' })));
    // Out-of-scope and missing buckets answer the same.
    await denied(client.send(new ListObjectsV2Command({ Bucket: 'tidak-ada' })));
    await denied(client.send(new CreateBucketCommand({ Bucket: 'empat' })));
    await denied(client.send(new DeleteBucketCommand({ Bucket: 'satu' })));
    await denied(
      client.send(
        new PutBucketCorsCommand({
          Bucket: 'satu',
          CORSConfiguration: {
            CORSRules: [{ AllowedOrigins: ['*'], AllowedMethods: ['GET'] }],
          },
        }),
      ),
    );
    // Copying needs reading the source and writing the target, both in scope.
    await client.send(
      new CopyObjectCommand({ Bucket: 'satu', Key: 'salin.jpg', CopySource: 'satu/foto/a.jpg' }),
    );
    await denied(
      client.send(
        new CopyObjectCommand({ Bucket: 'satu', Key: 'curi.jpg', CopySource: 'dua/foto/a.jpg' }),
      ),
    );
  });

  it('read-only and write-only keys do only that', async () => {
    const s = await seeded();
    const reader = (await scopedKey(s, { access: 'r' }, 'baca')).client;
    expect(
      await text(
        (await reader.send(new GetObjectCommand({ Bucket: 'dua', Key: 'foto/a.jpg' }))).Body,
      ),
    ).toBe('dua-a');
    expect((await reader.send(new ListObjectsV2Command({ Bucket: 'dua' }))).KeyCount).toBe(2);
    await denied(reader.send(new PutObjectCommand({ Bucket: 'dua', Key: 'x', Body: 'x' })));
    await denied(reader.send(new DeleteObjectCommand({ Bucket: 'dua', Key: 'foto/a.jpg' })));
    await denied(reader.send(new CreateBucketCommand({ Bucket: 'lima' })));
    await denied(
      reader.send(
        new CopyObjectCommand({ Bucket: 'dua', Key: 'salin.jpg', CopySource: 'dua/foto/a.jpg' }),
      ),
    );

    const writer = (await scopedKey(s, { access: 'w' }, 'tulis')).client;
    await writer.send(new PutObjectCommand({ Bucket: 'dua', Key: 'log/1.txt', Body: 'masuk' }));
    await denied(writer.send(new GetObjectCommand({ Bucket: 'dua', Key: 'log/1.txt' })));
    await denied(writer.send(new ListObjectsV2Command({ Bucket: 'dua' })));
    await writer.send(new DeleteObjectCommand({ Bucket: 'dua', Key: 'log/1.txt' }));
    // A write-only key can't copy out of a bucket either: copying reads the source.
    await denied(
      writer.send(
        new CopyObjectCommand({ Bucket: 'dua', Key: 'bocor.jpg', CopySource: 'dua/foto/a.jpg' }),
      ),
    );
  });

  it('a prefix key reads, writes, lists and deletes only under its prefix', async () => {
    const s = await seeded();
    const { client } = await scopedKey(s, { prefix: 'foto/' });
    expect(
      await text(
        (await client.send(new GetObjectCommand({ Bucket: 'satu', Key: 'foto/a.jpg' }))).Body,
      ),
    ).toBe('satu-a');
    await denied(client.send(new GetObjectCommand({ Bucket: 'satu', Key: 'dokumen/b.txt' })));
    await client.send(new PutObjectCommand({ Bucket: 'satu', Key: 'foto/c.jpg', Body: 'c' }));
    await denied(client.send(new PutObjectCommand({ Bucket: 'satu', Key: 'c.jpg', Body: 'c' })));
    const listed = await client.send(new ListObjectsV2Command({ Bucket: 'satu', Prefix: 'foto/' }));
    expect(listed.Contents?.map((c) => c.Key)).toEqual(['foto/a.jpg', 'foto/c.jpg']);
    await denied(client.send(new ListObjectsV2Command({ Bucket: 'satu' })));
    await denied(client.send(new ListObjectsV2Command({ Bucket: 'satu', Prefix: 'fo' })));
    // Batch delete: the key outside the prefix is refused on its own and stays.
    const del = await client.send(
      new DeleteObjectsCommand({
        Bucket: 'satu',
        Delete: { Objects: [{ Key: 'foto/c.jpg' }, { Key: 'dokumen/b.txt' }] },
      }),
    );
    expect(del.Deleted?.map((d) => d.Key)).toEqual(['foto/c.jpg']);
    expect(del.Errors?.map((e) => [e.Key, e.Code])).toEqual([['dokumen/b.txt', 'AccessDenied']]);
    const still = await s.client.send(
      new GetObjectCommand({ Bucket: 'satu', Key: 'dokumen/b.txt' }),
    );
    expect(await text(still.Body)).toBe('satu-b');
    await denied(client.send(new CreateBucketCommand({ Bucket: 'enam' })));
  });

  it('presigned URLs follow the key scope, and an expired key stops working', async () => {
    const s = await seeded();
    const { key, client } = await scopedKey(s, {
      buckets: ['satu'],
      access: 'r',
      expiresAt: Date.now() + 3_600_000,
    });
    const ok = await getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: 'satu', Key: 'foto/a.jpg' }),
      { expiresIn: 60 },
    );
    expect((await s.rt.fetch(ok)).status).toBe(200);
    const other = await getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: 'dua', Key: 'foto/a.jpg' }),
      { expiresIn: 60 },
    );
    expect((await s.rt.fetch(other)).status).toBe(403);
    const put = await getSignedUrl(client, new PutObjectCommand({ Bucket: 'satu', Key: 'p.txt' }), {
      expiresIn: 60,
    });
    expect(
      (
        await s.rt.fetch(
          new Request(put, { method: 'PUT', body: 'x', headers: { 'content-length': '1' } }),
        )
      ).status,
    ).toBe(403);

    // The end date has passed (written straight to the row, as time passing would).
    s.rt.d1.sqlite
      .prepare('UPDATE s3_keys SET expires_at = ? WHERE id = ?')
      .run(Date.now() - 1000, key.id);
    const { forgetKey } = await import('../../src/worker/services/s3');
    forgetKey(key.id);
    await denied(
      client.send(new GetObjectCommand({ Bucket: 'satu', Key: 'foto/a.jpg' })),
      'InvalidAccessKeyId',
      403,
    );
  });

  it('refuses scopes that name other people’s buckets or a date in the past', async () => {
    const s = await seeded();
    const stranger = await signIn(s.rt, 'orang-lain@zeiko.test');
    void stranger;
    const res = (scope: Scope) => s.user.req('POST', '/api/s3/keys', { label: 'x', ...scope });
    expect([403, 404]).toContain((await res({ buckets: ['bukan-punyaku'] })).status);
    expect((await res({ buckets: [] })).status).toBe(400);
    expect((await res({ expiresAt: Date.now() - 1 })).status).toBe(400);
    expect((await res({ prefix: '/awal' })).status).toBe(400);
    expect((await res({ access: 'x' as 'r' })).status).toBe(400);
  });

  it('a key of account A never reaches account B’s bucket, whatever its scope says', async () => {
    const a = await seeded();
    const b = await s3Setup({ rt: a.rt, email: 'pemilik-b@zeiko.test' });
    await b.client.send(new CreateBucketCommand({ Bucket: 'milik-b' }));
    await b.client.send(new PutObjectCommand({ Bucket: 'milik-b', Key: 'rahasia', Body: 'b' }));
    // A can't name B's bucket in a key...
    expect([403, 404]).toContain(
      (await a.user.req('POST', '/api/s3/keys', { label: 'x', buckets: ['milik-b'] })).status,
    );
    // ...and A's full key is still refused there.
    await denied(a.client.send(new GetObjectCommand({ Bucket: 'milik-b', Key: 'rahasia' })));
    void S3_ORIGIN;
  });

  it('links on /s3 are signed with a key that may read the object, not just the newest', async () => {
    const s = await seeded();
    // The newest key is write-only for another bucket: the link must still work.
    await scopedKey(s, { buckets: ['dua'], access: 'w' }, 'unggah');
    const res = await s.user.req('POST', '/api/s3/buckets/satu/objects/link', {
      key: 'foto/a.jpg',
      expiresInSeconds: 600,
    });
    expect(res.status).toBe(200);
    const link = (await res.json()) as { url: string; keyId: string };
    expect(link.keyId).toBe(s.key.id);
    expect((await s.rt.fetch(new Request(link.url))).status).toBe(200);

    // With only a key limited to dokumen/ left, a photo can't be linked, a document can.
    await s.user.req('DELETE', `/api/s3/keys/${s.key.id}`);
    const docs = await scopedKey(s, { prefix: 'dokumen/', access: 'r' }, 'dok');
    expect(
      (await s.user.req('POST', '/api/s3/buckets/satu/objects/link', { key: 'foto/a.jpg' })).status,
    ).toBe(409);
    const doc = await s.user.req('POST', '/api/s3/buckets/satu/objects/link', {
      key: 'dokumen/b.txt',
    });
    expect(((await doc.json()) as { keyId: string }).keyId).toBe(docs.key.id);
  });
});
