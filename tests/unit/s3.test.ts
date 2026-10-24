// Zeiko S3 building blocks (ADR-044), checked against independent implementations: the AWS SDK's own
// SigV4 signer, and a chunk-signature chain computed here with node:crypto.
import { createHash, createHmac } from 'node:crypto';
import { SignatureV4 } from '@smithy/signature-v4';
import { describe, expect, it } from 'vitest';
import { awsChunkedDecoder } from '../../src/worker/lib/aws-chunked';
import {
  canonicalUri,
  parseAuth,
  parseQuery,
  signingKey,
  verifySignature,
} from '../../src/worker/lib/s3-sigv4';
import { decodeXmlText, xmlDoc, xmlElements, xmlText } from '../../src/worker/lib/s3-xml';
import { prefixEnd } from '../../src/worker/services/s3-objects';
import { validBucketName } from '../../src/worker/services/s3';

const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

class Sha256 {
  private h = createHash('sha256');
  constructor(private key?: unknown) {
    if (key) this.h = createHmac('sha256', Buffer.from(key as Uint8Array)) as never;
  }
  update(d: string | Uint8Array) {
    this.h.update(d);
  }
  async digest() {
    return new Uint8Array(this.h.digest());
  }
}

async function sdkSign(req: {
  method: string;
  path: string;
  query?: Record<string, string>;
  headers: Record<string, string>;
  body?: string;
}) {
  const signer = new SignatureV4({
    credentials: { accessKeyId: 'ZKTESTTESTTESTTESTTE', secretAccessKey: SECRET },
    region: 'auto',
    service: 's3',
    sha256: Sha256 as never,
    uriEscapePath: false,
  });
  return signer.sign(
    {
      method: req.method,
      protocol: 'https:',
      hostname: 's3.zeiko.test',
      path: req.path,
      query: req.query ?? {},
      headers: { host: 's3.zeiko.test', ...req.headers },
      body: req.body,
    },
    { signingDate: new Date('2026-10-24T10:00:00Z') },
  );
}

function toRequest(signed: Awaited<ReturnType<typeof sdkSign>>) {
  const qs = new URLSearchParams(signed.query as Record<string, string>)
    .toString()
    .replace(/\+/g, '%20');
  const url = new URL(`https://s3.zeiko.test${signed.path}${qs ? `?${qs}` : ''}`);
  return { url, headers: new Headers(signed.headers as Record<string, string>) };
}

const NOW = Date.parse('2026-10-24T10:02:00Z');

describe('SigV4 against the AWS SDK signer', () => {
  it.each<{
    name: string;
    method: string;
    path: string;
    query?: Record<string, string>;
    body?: string;
  }>([
    {
      name: 'list with a delimiter',
      method: 'GET',
      path: '/foto',
      query: { 'list-type': '2', delimiter: '/', prefix: 'a b/c+d' },
    },
    {
      name: 'a key with spaces, plus and unicode',
      method: 'GET',
      path: '/foto/liburan bali/hari+1 (pagi) — ü.jpg',
    },
    {
      name: 'a sub-resource without a value',
      method: 'POST',
      path: '/foto/x.bin',
      query: { uploads: '' },
    },
    { name: 'a body with its hash', method: 'PUT', path: '/foto/a.txt', body: 'halo' },
  ])('verifies $name', async (c) => {
    const headers: Record<string, string> = { 'x-amz-meta-kota': '  Malang   Kota ' };
    if (c.body !== undefined)
      headers['x-amz-content-sha256'] = createHash('sha256').update(c.body).digest('hex');
    else headers['x-amz-content-sha256'] = 'UNSIGNED-PAYLOAD';
    const signed = await sdkSign({
      method: c.method,
      // How the S3 client escapes key paths (encodeURIComponent plus !'()*).
      path: c.path
        .split('/')
        .map((s) =>
          encodeURIComponent(s).replace(
            /[!'()*]/g,
            (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
          ),
        )
        .join('/'),
      ...(c.query ? { query: c.query } : {}),
      headers,
      ...(c.body !== undefined ? { body: c.body } : {}),
    });
    const { url, headers: h } = toRequest(signed);
    const pairs = parseQuery(url.search);
    const auth = parseAuth(h, pairs)!;
    expect(auth.kind).toBe('header');
    await expect(verifySignature(c.method, url, pairs, h, auth, SECRET, NOW)).resolves.toBeTruthy();
    await expect(
      verifySignature(c.method, url, pairs, h, auth, `${SECRET}x`, NOW),
    ).rejects.toMatchObject({
      code: 'SignatureDoesNotMatch',
    });
    await expect(
      verifySignature(c.method, url, pairs, h, auth, SECRET, NOW + 20 * 60_000),
    ).rejects.toMatchObject({
      code: 'RequestTimeTooSkewed',
    });
  });

  it('verifies presigned URLs and their expiry', async () => {
    const signer = new SignatureV4({
      credentials: { accessKeyId: 'ZKTESTTESTTESTTESTTE', secretAccessKey: SECRET },
      region: 'auto',
      service: 's3',
      sha256: Sha256 as never,
      uriEscapePath: false,
    });
    const pre = await signer.presign(
      // The S3 presigner always signs UNSIGNED-PAYLOAD (hoisted into the query as X-Amz-Content-Sha256).
      {
        method: 'GET',
        protocol: 'https:',
        hostname: 's3.zeiko.test',
        path: '/foto/a%20b.jpg',
        query: {},
        headers: { host: 's3.zeiko.test', 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
      },
      { signingDate: new Date('2026-10-24T10:00:00Z'), expiresIn: 300 },
    );
    const { url, headers } = toRequest(pre);
    const pairs = parseQuery(url.search);
    const auth = parseAuth(new Headers(), pairs)!;
    expect(auth.kind).toBe('query');
    await expect(
      verifySignature('GET', url, pairs, headers, auth, SECRET, NOW),
    ).resolves.toBeTruthy();
    await expect(
      verifySignature('GET', url, pairs, headers, auth, SECRET, Date.parse('2026-10-24T10:06:00Z')),
    ).rejects.toMatchObject({ code: 'AccessDenied' });
  });

  it('refuses other schemes and malformed credentials', () => {
    expect(() => parseAuth(new Headers({ authorization: 'AWS AKID:sig' }), [])).toThrow(
      /Signature Version 4/,
    );
    expect(() =>
      parseAuth(
        new Headers({
          authorization: `AWS4-HMAC-SHA256 Credential=K/2026/auto/s3/aws4_request, SignedHeaders=host, Signature=${'a'.repeat(64)}`,
          'x-amz-date': '20261024T000000Z',
          'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
        }),
        [],
      ),
    ).toThrow(/credential/);
    expect(parseAuth(new Headers(), [])).toBeNull();
  });

  it('encodes the canonical URI once, keeping slashes', () => {
    expect(canonicalUri('/b/a%20b/c%2Bd/%C3%BC')).toBe('/b/a%20b/c%2Bd/%C3%BC');
    expect(canonicalUri('/b/(x)!*')).toBe('/b/%28x%29%21%2A');
  });
});

describe('aws-chunked bodies', () => {
  async function chunked(chunks: Buffer[], signed: boolean, trailer?: string) {
    const date = '20261024';
    const amzDate = '20261024T100000Z';
    const scope = `${date}/auto/s3/aws4_request`;
    const key = Buffer.from(await signingKey(SECRET, date, 'auto'));
    const seed = 'a'.repeat(64);
    let prev = seed;
    const sig = (data: Buffer) => {
      const s = createHmac('sha256', key)
        .update(
          `AWS4-HMAC-SHA256-PAYLOAD\n${amzDate}\n${scope}\n${prev}\n${createHash('sha256').update('').digest('hex')}\n${createHash('sha256').update(data).digest('hex')}`,
        )
        .digest('hex');
      prev = s;
      return s;
    };
    const parts: Buffer[] = [];
    for (const c of [...chunks, Buffer.alloc(0)]) {
      const ext = signed ? `;chunk-signature=${sig(c)}` : '';
      parts.push(Buffer.from(`${c.length.toString(16)}${ext}\r\n`));
      if (c.length) parts.push(c, Buffer.from('\r\n'));
    }
    if (trailer) parts.push(Buffer.from(`${trailer}\r\n`));
    parts.push(Buffer.from('\r\n'));
    const wire = Buffer.concat(parts);
    return {
      wire,
      verified: {
        signingKey: key.buffer.slice(key.byteOffset, key.byteOffset + key.length) as ArrayBuffer,
        scope,
        amzDate,
        signature: seed,
      },
    };
  }

  async function decode(wire: Buffer, opts: Parameters<typeof awsChunkedDecoder>[0], pieces = 7) {
    const d = awsChunkedDecoder(opts);
    const size = Math.ceil(wire.length / pieces);
    const input = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < wire.length; i += size)
          c.enqueue(new Uint8Array(wire.subarray(i, i + size)));
        c.close();
      },
    });
    const out = Buffer.from(await new Response(input.pipeThrough(d.stream)).arrayBuffer());
    return { out, trailers: d.trailers };
  }

  it('checks every chunk signature and passes the data through', async () => {
    const data = [Buffer.alloc(65_536, 'a'), Buffer.alloc(1024, 'b')];
    const { wire, verified } = await chunked(data, true);
    const { out } = await decode(wire, { signed: verified });
    expect(out.equals(Buffer.concat(data))).toBe(true);
  });

  it('refuses a body whose bytes were changed', async () => {
    const { wire, verified } = await chunked([Buffer.alloc(1000, 'a')], true);
    const bad = Buffer.from(wire);
    bad[bad.indexOf('aaaa')] = 0x62;
    await expect(decode(bad, { signed: verified })).rejects.toMatchObject({
      code: 'SignatureDoesNotMatch',
    });
  });

  it('reads unsigned chunks with a trailing checksum', async () => {
    const { wire } = await chunked(
      [Buffer.from('halo '), Buffer.from('dunia')],
      false,
      'x-amz-checksum-crc32:AAAAAA==',
    );
    const { out, trailers } = await decode(wire, {}, 3);
    expect(out.toString()).toBe('halo dunia');
    expect(trailers).toEqual({ 'x-amz-checksum-crc32': 'AAAAAA==' });
  });

  it('notices a body that ends early', async () => {
    const { wire } = await chunked([Buffer.alloc(100, 'a')], false);
    await expect(decode(wire.subarray(0, 50), {})).rejects.toMatchObject({
      code: 'IncompleteBody',
    });
  });
});

describe('S3 helpers', () => {
  it('finds the end of a prefix in UTF-8 order', () => {
    expect(prefixEnd('docs/')).toBe('docs0');
    expect(prefixEnd('a')).toBe('b');
    expect(prefixEnd('퟿')).toBe('');
    expect(prefixEnd(String.fromCodePoint(0x10ffff))).toBeNull();
  });

  it('follows the bucket naming rules', () => {
    for (const ok of ['foto', 'my-bucket.01', 'abc']) expect(validBucketName(ok)).toBe(true);
    for (const bad of [
      'ab',
      'Foto',
      '-a-',
      'a..b',
      '192.168.1.1',
      'xn--abc',
      'a_b',
      'x'.repeat(64),
    ])
      expect(validBucketName(bad)).toBe(false);
  });

  it('builds and reads the XML S3 uses', () => {
    const xml = xmlDoc('DeleteResult', { Deleted: [{ Key: 'a&b' }, { Key: '<c>' }], Error: [] });
    expect(xml).toContain(
      '<Deleted><Key>a&amp;b</Key></Deleted><Deleted><Key>&lt;c&gt;</Key></Deleted>',
    );
    const body =
      '<Delete xmlns="x"><Quiet>true</Quiet><Object><Key>a&amp;b</Key></Object><Object><Key>&#x00FC;</Key></Object></Delete>';
    expect(xmlElements(body, 'Object').map((o) => xmlText(o, 'Key'))).toEqual(['a&b', 'ü']);
    expect(xmlText(body, 'Quiet')).toBe('true');
    expect(decodeXmlText('<![CDATA[<x>]]>')).toBe('<x>');
  });
});
