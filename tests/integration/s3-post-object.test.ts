// PostObject (S8 part 4, ADR-076): HTML form uploads with a SigV4 policy made by the AWS SDK's
// createPresignedPost, the conditions Amazon checks, the answers it gives, and forms that are wrong.
import {
  CreateBucketCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/worker/adapters/clock';
import { makeRuntime } from '../helpers/runtime';
import { OPS_KEY, S3_ORIGIN, s3Client, s3Setup, usage } from '../helpers/s3';
import type { DevRuntime } from '../../dev/env';

const enc = new TextEncoder();

function form(
  fields: Record<string, string>,
  file: { name: string; type: string; data: Uint8Array } | null,
  end = '\r\n',
): { body: Uint8Array; type: string } {
  const b = `----zeiko${Math.random().toString(36).slice(2)}`;
  const parts: Uint8Array[] = [];
  for (const [k, v] of Object.entries(fields))
    parts.push(enc.encode(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  if (file) {
    parts.push(
      enc.encode(
        `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`,
      ),
      file.data,
      enc.encode(`\r\n--${b}--${end}`),
    );
  } else parts.push(enc.encode(`--${b}--\r\n`));
  const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    body.set(p, o);
    o += p.length;
  }
  return { body, type: `multipart/form-data; boundary=${b}` };
}

function post(rt: DevRuntime, url: string, f: { body: Uint8Array; type: string }) {
  return rt.fetch(
    new Request(url, {
      method: 'POST',
      headers: {
        'content-type': f.type,
        'content-length': String(f.body.length),
        origin: 'https://web.example',
      },
      body: f.body,
    }),
  );
}

const file = (text: string, name = 'foto.jpg', type = 'image/jpeg') => ({
  name,
  type,
  data: enc.encode(text),
});

describe('PostObject (S8, ADR-076)', () => {
  it('uploads through a presigned POST: ${filename}, conditions, metadata, tags, 201 XML', async () => {
    const { rt, client, user } = await s3Setup();
    await client.send(new CreateBucketCommand({ Bucket: 'formulir' }));
    const { url, fields } = await createPresignedPost(client, {
      Bucket: 'formulir',
      Key: 'unggahan/${filename}',
      Conditions: [
        ['starts-with', '$key', 'unggahan/'],
        ['starts-with', '$Content-Type', 'image/'],
        ['content-length-range', 1, 1000],
        { success_action_status: '201' },
        ['starts-with', '$x-amz-meta-asal', ''],
        [
          'eq',
          '$tagging',
          '<Tagging><TagSet><Tag><Key>dari</Key><Value>form</Value></Tag></TagSet></Tagging>',
        ],
      ],
      Fields: { success_action_status: '201' },
      Expires: 600,
    });
    expect(url).toBe(`${S3_ORIGIN}/formulir`);
    const res = await post(
      rt,
      url,
      form(
        {
          ...fields,
          'Content-Type': 'image/jpeg',
          'x-amz-meta-asal': 'situs',
          tagging:
            '<Tagging><TagSet><Tag><Key>dari</Key><Value>form</Value></Tag></TagSet></Tagging>',
        },
        file('isi foto'),
      ),
    );
    expect(res.status, await res.clone().text()).toBe(201);
    const xml = await res.text();
    expect(xml).toContain('<Key>unggahan/foto.jpg</Key>');
    expect(xml).toContain('<Bucket>formulir</Bucket>');
    expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]{32}"$/);

    const got = await client.send(
      new GetObjectCommand({ Bucket: 'formulir', Key: 'unggahan/foto.jpg' }),
    );
    expect(await got.Body!.transformToString()).toBe('isi foto');
    expect(got.ContentType).toBe('image/jpeg');
    expect(got.Metadata).toEqual({ asal: 'situs' });
    const tags = await client.send(
      new GetObjectTaggingCommand({ Bucket: 'formulir', Key: 'unggahan/foto.jpg' }),
    );
    expect(tags.TagSet).toEqual([{ Key: 'dari', Value: 'form' }]);
    expect(usage(rt, user.userId)).toEqual({ used: 8, reserved: 0 });
  });

  it('answers 204 by default, the status asked for, or a redirect with bucket, key and ETag', async () => {
    const { rt, client } = await s3Setup();
    await client.send(new CreateBucketCommand({ Bucket: 'jawaban' }));
    const plain = await createPresignedPost(client, {
      Bucket: 'jawaban',
      Key: 'a.txt',
      Expires: 600,
    });
    const r1 = await post(rt, plain.url, form(plain.fields, file('a', 'a.txt', 'text/plain')));
    expect(r1.status).toBe(204);
    expect(r1.headers.get('location')).toBe(`${S3_ORIGIN}/jawaban/a.txt`);

    const ok = await createPresignedPost(client, {
      Bucket: 'jawaban',
      Key: 'b.txt',
      Fields: { success_action_status: '200' },
      Expires: 600,
    });
    expect((await post(rt, ok.url, form(ok.fields, file('b')))).status).toBe(200);

    const back = await createPresignedPost(client, {
      Bucket: 'jawaban',
      Key: 'c.txt',
      Fields: { success_action_redirect: 'https://situs.example/selesai?x=1' },
      Expires: 600,
    });
    const r3 = await post(rt, back.url, form(back.fields, file('c')));
    expect(r3.status).toBe(303);
    const to = new URL(r3.headers.get('location')!);
    expect(to.origin + to.pathname).toBe('https://situs.example/selesai');
    expect(Object.fromEntries(to.searchParams)).toMatchObject({
      x: '1',
      bucket: 'jawaban',
      key: 'c.txt',
    });
    expect(to.searchParams.get('etag')).toMatch(/^"[0-9a-f]{32}"$/);
  });

  it('refuses what the policy does not allow', async () => {
    const START = Date.now();
    const clock = new FakeClock(START);
    const rt = await makeRuntime({ vars: { ZEIKO_OPS_TOKEN: OPS_KEY, S3_ORIGIN }, clock });
    const { client, user } = await s3Setup({ rt });
    await client.send(new CreateBucketCommand({ Bucket: 'ketat' }));
    const p = await createPresignedPost(client, {
      Bucket: 'ketat',
      Key: 'masuk/x.txt',
      Conditions: [
        ['starts-with', '$key', 'masuk/'],
        ['content-length-range', 2, 10],
      ],
      Expires: 60,
    });
    const code = async (res: Response) => [
      res.status,
      /<Code>(\w+)<\/Code>/.exec(await res.text())?.[1],
    ];
    expect(
      await code(await post(rt, p.url, form({ ...p.fields, key: 'lain/x.txt' }, file('isi')))),
    ).toEqual([403, 'AccessDenied']);
    expect(await code(await post(rt, p.url, form(p.fields, file('terlalu panjang'))))).toEqual([
      400,
      'EntityTooLarge',
    ]);
    expect(await code(await post(rt, p.url, form(p.fields, file('x'))))).toEqual([
      400,
      'EntityTooSmall',
    ]);
    expect(
      await code(await post(rt, p.url, form({ ...p.fields, 'x-amz-meta-lain': '1' }, file('isi')))),
    ).toEqual([403, 'AccessDenied']);
    const forged = btoa(atob(p.fields.Policy!).replace('masuk/', 'mana-saja/'));
    expect(
      await code(await post(rt, p.url, form({ ...p.fields, Policy: forged }, file('isi')))),
    ).toEqual([403, 'SignatureDoesNotMatch']);
    const { Policy: _p, 'X-Amz-Signature': _s, ...unsigned } = p.fields;
    expect(await code(await post(rt, p.url, form(unsigned, file('isi'))))).toEqual([
      403,
      'AccessDenied',
    ]);
    expect(await code(await post(rt, p.url, form(p.fields, null)))).toEqual([
      400,
      'InvalidArgument',
    ]);
    // A form whose file isn't followed by the closing boundary.
    expect(await code(await post(rt, p.url, form(p.fields, file('isi-isi'), '')))).toEqual([
      400,
      'MalformedPOSTRequest',
    ]);
    clock.set(START + 2 * 60_000);
    expect(await code(await post(rt, p.url, form(p.fields, file('isi'))))).toEqual([
      403,
      'AccessDenied',
    ]);
    // Nothing got in, nothing is held.
    expect(usage(rt, user.userId)).toEqual({ used: 0, reserved: 0 });
    expect(await rt.r2.list({ prefix: `s3/` }).then((l) => l.objects.length)).toBe(0);
  });

  it("keeps to the key's scope, the bill, and the owner's buckets", async () => {
    const s = await s3Setup();
    await s.client.send(new CreateBucketCommand({ Bucket: 'milik-s' }));
    const made = await s.user.req('POST', '/api/s3/keys', { label: 'baca', access: 'r' });
    const ro = s3Client(s.rt, ((await made.json()) as { key: { id: string; secret: string } }).key);
    const byReader = await createPresignedPost(ro, { Bucket: 'milik-s', Key: 'a', Expires: 600 });
    expect((await post(s.rt, byReader.url, form(byReader.fields, file('a')))).status).toBe(403);

    const other = await s3Setup({ rt: s.rt, email: 'tetangga-post@zeiko.test' });
    const intoTheirs = await createPresignedPost(other.client, {
      Bucket: 'milik-s',
      Key: 'a',
      Expires: 600,
    });
    expect((await post(s.rt, intoTheirs.url, form(intoTheirs.fields, file('a')))).status).toBe(403);

    s.rt.d1.sqlite
      .prepare(`UPDATE s3_accounts SET billing_state = 'readonly' WHERE user_id = ?`)
      .run(s.user.userId);
    const unpaid = await createPresignedPost(s.client, {
      Bucket: 'milik-s',
      Key: 'b',
      Expires: 600,
    });
    const res = await post(s.rt, unpaid.url, form(unpaid.fields, file('b')));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('<Code>AccountProblem</Code>');
    expect(
      await s.client
        .send(new HeadObjectCommand({ Bucket: 'milik-s', Key: 'b' }))
        .catch((e: { name: string }) => e.name),
    ).toBe('NotFound');
  });
});
