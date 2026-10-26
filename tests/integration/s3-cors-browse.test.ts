// Zeiko S3 CORS (with the real AWS SDK, and a browser's preflight) and the /s3 page's own view of a
// bucket: list, link, upload, delete (ADR-055).
import {
  CreateBucketCommand,
  DeleteBucketCorsCommand,
  GetBucketCorsCommand,
  GetObjectCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { invalidateConfigMemo } from '../../src/worker/services/config';
import { parseAuth, parseQuery, presignUrl, verifySignature } from '../../src/worker/lib/s3-sigv4';
import { matchCors, parseCorsXml, validateCors } from '../../src/worker/services/s3-cors';
import { signIn } from '../helpers/session';
import { s3Client, s3Setup, S3_ORIGIN } from '../helpers/s3';

async function sdkError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { name?: string; Code?: string };
    return err.Code ?? err.name ?? 'unknown';
  }
  return 'none';
}

const preflight = (
  rt: Awaited<ReturnType<typeof s3Setup>>['rt'],
  path: string,
  origin: string,
  method: string,
  headers?: string,
) =>
  rt.fetch(
    new Request(`${S3_ORIGIN}${path}`, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': method,
        ...(headers ? { 'access-control-request-headers': headers } : {}),
      },
    }),
  );

describe('Zeiko S3 CORS (ADR-055)', () => {
  it('stores rules with PutBucketCors and answers preflights and real requests by them', async () => {
    const { rt, client } = await s3Setup();
    await client.send(new CreateBucketCommand({ Bucket: 'web-app' }));
    expect(await sdkError(client.send(new GetBucketCorsCommand({ Bucket: 'web-app' })))).toBe(
      'NoSuchCORSConfiguration',
    );
    // Before any rule: browsers are refused.
    const none = await preflight(rt, '/web-app/a.txt', 'https://app.example.com', 'GET');
    expect(none.status).toBe(403);
    expect(await none.text()).toContain('<Code>CORSResponse</Code>');

    await client.send(
      new PutBucketCorsCommand({
        Bucket: 'web-app',
        CORSConfiguration: {
          CORSRules: [
            {
              ID: 'app',
              AllowedOrigins: ['https://app.example.com', 'https://*.preview.example.com'],
              AllowedMethods: ['GET', 'PUT', 'HEAD'],
              AllowedHeaders: ['content-type', 'x-amz-*'],
              ExposeHeaders: ['ETag'],
              MaxAgeSeconds: 600,
            },
            { AllowedOrigins: ['*'], AllowedMethods: ['GET'] },
          ],
        },
      }),
    );
    const got = await client.send(new GetBucketCorsCommand({ Bucket: 'web-app' }));
    expect(got.CORSRules?.[0]).toMatchObject({
      ID: 'app',
      AllowedOrigins: ['https://app.example.com', 'https://*.preview.example.com'],
      AllowedMethods: ['GET', 'PUT', 'HEAD'],
      ExposeHeaders: ['ETag'],
      MaxAgeSeconds: 600,
    });

    const ok = await preflight(
      rt,
      '/web-app/foto/a.jpg',
      'https://pr-12.preview.example.com',
      'PUT',
      'Content-Type, X-Amz-Date',
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://pr-12.preview.example.com');
    expect(ok.headers.get('access-control-allow-methods')).toBe('GET, PUT, HEAD');
    expect(ok.headers.get('access-control-allow-headers')).toBe('content-type, x-amz-date');
    expect(ok.headers.get('access-control-max-age')).toBe('600');
    expect(ok.headers.get('access-control-allow-credentials')).toBe('true');

    // A header no rule allows; a method only the first rule has, from another site.
    expect(
      (await preflight(rt, '/web-app/a', 'https://app.example.com', 'PUT', 'x-secret')).status,
    ).toBe(403);
    expect((await preflight(rt, '/web-app/a', 'https://evil.example', 'PUT')).status).toBe(403);
    // Anyone may GET (second rule): the wildcard answers "*", without credentials.
    const any = await preflight(rt, '/web-app/a', 'https://evil.example', 'GET');
    expect(any.headers.get('access-control-allow-origin')).toBe('*');
    expect(any.headers.get('access-control-allow-credentials')).toBeNull();

    // A real (signed) request from the allowed site carries the headers too, errors included.
    await client.send(new PutObjectCommand({ Bucket: 'web-app', Key: 'a.txt', Body: 'hai' }));
    const missing = await rt.fetch(
      new Request(`${S3_ORIGIN}/web-app/nope.txt`, {
        headers: { origin: 'https://app.example.com' },
      }),
    );
    expect(missing.status).toBe(403); // unsigned and private
    expect(missing.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    expect(missing.headers.get('access-control-expose-headers')).toBe('ETag');

    await client.send(new DeleteBucketCorsCommand({ Bucket: 'web-app' }));
    expect((await preflight(rt, '/web-app/a', 'https://app.example.com', 'GET')).status).toBe(403);
  });

  it("refuses bad rules and other people's buckets", async () => {
    const owner = await s3Setup();
    await owner.client.send(new CreateBucketCommand({ Bucket: 'punya-saya' }));
    expect(
      await sdkError(
        owner.client.send(
          new PutBucketCorsCommand({
            Bucket: 'punya-saya',
            CORSConfiguration: {
              CORSRules: [{ AllowedOrigins: ['*'], AllowedMethods: ['PATCH'] }],
            },
          }),
        ),
      ),
    ).toBe('InvalidRequest');
    const other = await s3Setup({ rt: owner.rt, email: 'tetangga@zeiko.test' });
    expect(
      await sdkError(
        other.client.send(
          new PutBucketCorsCommand({
            Bucket: 'punya-saya',
            CORSConfiguration: { CORSRules: [{ AllowedOrigins: ['*'], AllowedMethods: ['GET'] }] },
          }),
        ),
      ),
    ).toBe('AccessDenied');
    const res = await other.user.req('PUT', '/api/s3/buckets/punya-saya/cors', {
      rules: [{ allowedOrigins: ['*'], allowedMethods: ['GET'] }],
    });
    expect([403, 404]).toContain(res.status);
  });

  it('matches like Amazon: first rule, one wildcard, case-insensitive headers', () => {
    expect(() => validateCors([])).toThrow();
    expect(() =>
      validateCors([
        {
          allowedOrigins: ['https://*.*.x'],
          allowedMethods: ['GET'],
          allowedHeaders: [],
          exposeHeaders: [],
        },
      ]),
    ).toThrow(/wildcard/);
    const rules = parseCorsXml(
      `<CORSConfiguration><CORSRule><AllowedOrigin>https://a.test</AllowedOrigin><AllowedMethod>get</AllowedMethod><AllowedHeader>X-Up-*</AllowedHeader><MaxAgeSeconds>5</MaxAgeSeconds></CORSRule></CORSConfiguration>`,
    );
    expect(rules[0]).toMatchObject({ allowedMethods: ['GET'], maxAgeSeconds: 5 });
    expect(matchCors(rules, 'https://a.test', 'GET', ['x-up-id'])).toBe(rules[0]);
    expect(matchCors(rules, 'https://a.test', 'GET', ['x-down'])).toBeNull();
    expect(matchCors(rules, 'https://A.test', 'GET')).toBeNull(); // origins are exact
    expect(() => parseCorsXml('<nope/>')).toThrow();
  });
});

describe('the /s3 page browses a bucket (ADR-055)', () => {
  it('lists one folder level, uploads, links and deletes', async () => {
    const { rt, client, user, key } = await s3Setup();
    await client.send(new CreateBucketCommand({ Bucket: 'arsip' }));
    for (const k of ['a.txt', 'foto/1.jpg', 'foto/2.jpg', 'foto/2024/x.jpg'])
      await client.send(new PutObjectCommand({ Bucket: 'arsip', Key: k, Body: `isi ${k}` }));

    const list = async (prefix = '') =>
      (await (
        await user.req('GET', `/api/s3/buckets/arsip/objects?prefix=${encodeURIComponent(prefix)}`)
      ).json()) as { prefixes: string[]; objects: Array<{ key: string; size: number }> };
    expect(await list()).toMatchObject({
      prefixes: ['foto/'],
      objects: [{ key: 'a.txt', size: 9 }],
    });
    const foto = await list('foto/');
    expect(foto.prefixes).toEqual(['foto/2024/']);
    expect(foto.objects.map((o) => o.key)).toEqual(['foto/1.jpg', 'foto/2.jpg']);

    // Upload through the app, then read it with the SDK.
    const body = new TextEncoder().encode('dari halaman /s3');
    const up = await user.req(
      'PUT',
      '/api/s3/buckets/arsip/objects?key=web%2Fhalo.txt',
      undefined,
      {
        body,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(body.length),
          'x-object-content-type': 'text/plain',
        },
      },
    );
    expect(up.status).toBe(201);
    const read = await client.send(new GetObjectCommand({ Bucket: 'arsip', Key: 'web/halo.txt' }));
    expect(await read.Body!.transformToString()).toBe('dari halaman /s3');
    expect(read.ContentType).toBe('text/plain');
    // An empty "folder".
    const folder = await user.req('PUT', '/api/s3/buckets/arsip/objects?key=kosong%2F', undefined, {
      body: new Uint8Array(0),
      headers: { 'content-type': 'application/octet-stream', 'content-length': '0' },
    });
    expect(folder.status).toBe(201);
    expect((await list()).prefixes).toEqual(['foto/', 'kosong/', 'web/']);
    expect((await list('kosong/')).objects).toEqual([]);

    // A presigned link that works with no session, as a download.
    const link = (await (
      await user.req('POST', '/api/s3/buckets/arsip/objects/link', {
        key: 'foto/2024/x.jpg',
        expiresInSeconds: 600,
      })
    ).json()) as { url: string; keyId: string };
    expect(link.url.startsWith(`${S3_ORIGIN}/arsip/foto/2024/x.jpg?`)).toBe(true);
    expect(link.keyId).toBe(key.id);
    const dl = await rt.fetch(new Request(link.url));
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe('isi foto/2024/x.jpg');
    expect(dl.headers.get('content-disposition')).toBe(
      `attachment; filename="x.jpg"; filename*=UTF-8''x.jpg`,
    );
    expect(
      (await user.req('POST', '/api/s3/buckets/arsip/objects/link', { key: 'tidak-ada' })).status,
    ).toBe(404);

    const del = await user.req('POST', '/api/s3/buckets/arsip/objects/delete', {
      keys: ['a.txt', 'foto/1.jpg'],
    });
    expect(await del.json()).toEqual({ deleted: 2 });
    expect((await list()).objects).toEqual([]);
    expect((await list('foto/')).objects.map((o) => o.key)).toEqual(['foto/2.jpg']);

    // No key left to sign with: a clear reason instead of a broken link.
    await user.req('DELETE', `/api/s3/keys/${key.id}`);
    const noKey = await user.req('POST', '/api/s3/buckets/arsip/objects/link', {
      key: 'foto/2.jpg',
    });
    expect(noKey.status).toBe(409);
    expect(
      ((await noKey.json()) as { error: { data: { reason: string } } }).error.data.reason,
    ).toBe('s3_no_key');
    void s3Client;
  });

  it('keeps to the owner, and to the size one request can carry', async () => {
    const { rt, client, user } = await s3Setup();
    await client.send(new CreateBucketCommand({ Bucket: 'pribadi' }));
    const stranger = await signIn(rt, 'orang-lain@zeiko.test');
    expect([403, 404]).toContain(
      (await stranger.req('GET', '/api/s3/buckets/pribadi/objects')).status,
    );
    const other = await s3Setup({ rt, email: 'akun-s3-lain@zeiko.test' });
    expect([403, 404]).toContain(
      (await other.user.req('GET', '/api/s3/buckets/pribadi/objects')).status,
    );
    expect(
      (await other.user.req('POST', '/api/s3/buckets/pribadi/objects/delete', { keys: ['x'] }))
        .status,
    ).toBe(403);

    rt.d1.sqlite
      .prepare(
        `INSERT INTO app_config (key, value_json, updated_by, updated_at)
         VALUES ('s3_web_upload_max_bytes', '4', 'test', 0)`,
      )
      .run();
    await rt.env.CONFIG_KV.delete('config:v1');
    invalidateConfigMemo(rt.env);
    const big = await user.req('PUT', '/api/s3/buckets/pribadi/objects?key=besar.bin', undefined, {
      body: new Uint8Array(5),
      headers: { 'content-type': 'application/octet-stream', 'content-length': '5' },
    });
    expect(big.status).toBe(413);
  });

  it('signs presigned URLs the S3 API accepts, and they expire', async () => {
    const url = new URL('https://s3.zeiko.test/foto/a b+c.jpg');
    url.searchParams.set('response-content-disposition', 'attachment; filename="a b.jpg"');
    const now = Date.parse('2026-10-26T10:00:00Z');
    const signed = new URL(
      await presignUrl({
        method: 'GET',
        url,
        accessKeyId: 'ZKTESTTESTTESTTESTTE',
        secret: 'rahasia',
        region: 'auto',
        now,
        expiresSeconds: 60,
      }),
    );
    const pairs = parseQuery(signed.search);
    const auth = parseAuth(new Headers(), pairs)!;
    expect(auth.expires).toBe(60);
    await expect(
      verifySignature('GET', signed, pairs, new Headers(), auth, 'rahasia', now + 1000),
    ).resolves.toBeTruthy();
    await expect(
      verifySignature('GET', signed, pairs, new Headers(), auth, 'rahasia', now + 61_000),
    ).rejects.toMatchObject({ code: 'AccessDenied' });
    await expect(
      verifySignature('GET', signed, pairs, new Headers(), auth, 'salah', now + 1000),
    ).rejects.toMatchObject({ code: 'SignatureDoesNotMatch' });
  });
});
