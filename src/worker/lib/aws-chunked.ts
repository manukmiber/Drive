// `Content-Encoding: aws-chunked` bodies (Zeiko S3, ADR-044). Recent AWS SDKs send uploads this way:
//   <hex size>[;chunk-signature=<sig>]\r\n<data>\r\n … 0[;chunk-signature=<sig>]\r\n[<trailers>\r\n]\r\n
// Signed chunks (STREAMING-AWS4-HMAC-SHA256-PAYLOAD*) are checked one by one against the chain that
// starts at the request's signature, so a chunk is passed on only once its signature is right.
// Unsigned ones (STREAMING-UNSIGNED-PAYLOAD-TRAILER) stream straight through. Trailing checksums
// (x-amz-checksum-*) are kept but not checked: TLS already protects the bytes in flight.
import { S3Error } from './s3-errors';
import { chunkSignature, sha256HexOf, type VerifiedSignature } from './s3-sigv4';
import { Sha256 } from './sha256';
import { toHex } from './crypto';

const MAX_LINE = 4096;

function indexOfCrlf(buf: Uint8Array, from: number): number {
  for (let i = from; i + 1 < buf.length; i++) if (buf[i] === 13 && buf[i + 1] === 10) return i;
  return -1;
}

function concat(parts: Uint8Array[], total?: number): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(total ?? parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const latin1 = new TextDecoder('latin1');

export interface AwsChunkedOptions {
  /** Set for STREAMING-AWS4-HMAC-SHA256-PAYLOAD(-TRAILER): every chunk must carry its signature. */
  signed?: Pick<VerifiedSignature, 'signingKey' | 'scope' | 'amzDate' | 'signature'>;
  /** Largest signed chunk we buffer to check its signature. */
  maxChunkBytes?: number;
}

export interface AwsChunkedDecoder {
  stream: TransformStream<Uint8Array, Uint8Array>;
  /** Trailing headers (lowercase names), once the body is read. */
  readonly trailers: Record<string, string>;
  /** Why decoding failed, if it did (the platform may report a different error upstream). */
  failure: S3Error | null;
}

export function awsChunkedDecoder(opts: AwsChunkedOptions = {}): AwsChunkedDecoder {
  const maxChunk = opts.maxChunkBytes ?? 16 * 1024 * 1024;
  const trailers: Record<string, string> = {};
  let state: 'size' | 'data' | 'crlf' | 'trailer' | 'done' = 'size';
  let leftover: Uint8Array = new Uint8Array(0);
  let remaining = 0;
  let declaredSig = '';
  let previousSig = opts.signed?.signature ?? '';
  let parts: Uint8Array[] = [];
  let partsLen = 0;
  const self: AwsChunkedDecoder = {
    trailers,
    failure: null,
    stream: null as unknown as TransformStream<Uint8Array, Uint8Array>,
  };
  const fail = (
    m: string,
    code: 'IncompleteBody' | 'SignatureDoesNotMatch' | 'InvalidRequest' = 'IncompleteBody',
  ) => {
    self.failure = new S3Error(code, m);
    return self.failure;
  };

  async function verifyChunk(data: Uint8Array): Promise<void> {
    const signed = opts.signed!;
    const expected = await chunkSignature(signed, previousSig, await sha256HexOf(data));
    if (expected !== declaredSig)
      throw fail('A chunk signature does not match.', 'SignatureDoesNotMatch');
    previousSig = declaredSig;
  }

  async function feed(input: Uint8Array, out: TransformStreamDefaultController<Uint8Array>) {
    const data = leftover.length ? concat([leftover, input]) : input;
    leftover = new Uint8Array(0);
    let i = 0;
    while (i < data.length) {
      if (state === 'size' || state === 'trailer') {
        const end = indexOfCrlf(data, i);
        if (end === -1) {
          if (data.length - i > MAX_LINE)
            throw fail('A chunk header is too long.', 'InvalidRequest');
          leftover = data.slice(i);
          return;
        }
        const line = latin1.decode(data.subarray(i, end));
        i = end + 2;
        if (state === 'trailer') {
          if (line === '') {
            state = 'done';
            continue;
          }
          const colon = line.indexOf(':');
          if (colon > 0)
            trailers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
          continue;
        }
        const [hex, ...exts] = line.split(';');
        if (!hex || !/^[0-9a-fA-F]{1,16}$/.test(hex.trim()))
          throw fail('A chunk size is malformed.', 'InvalidRequest');
        const size = parseInt(hex.trim(), 16);
        if (opts.signed) {
          const ext = exts.find((e) => e.trim().startsWith('chunk-signature='));
          declaredSig = ext?.trim().slice('chunk-signature='.length) ?? '';
          if (!/^[0-9a-f]{64}$/.test(declaredSig))
            throw fail('A chunk signature is missing.', 'SignatureDoesNotMatch');
          if (size > maxChunk) throw fail('A signed chunk is too large.', 'InvalidRequest');
        }
        if (size === 0) {
          if (opts.signed) await verifyChunk(new Uint8Array(0));
          state = 'trailer';
          continue;
        }
        remaining = size;
        parts = [];
        partsLen = 0;
        state = 'data';
        continue;
      }
      if (state === 'data') {
        const take = Math.min(remaining, data.length - i);
        const slice = data.subarray(i, i + take);
        i += take;
        remaining -= take;
        if (opts.signed) {
          parts.push(slice);
          partsLen += take;
        } else out.enqueue(slice);
        if (remaining === 0) state = 'crlf';
        continue;
      }
      if (state === 'crlf') {
        if (data.length - i < 2) {
          leftover = data.slice(i);
          return;
        }
        if (data[i] !== 13 || data[i + 1] !== 10)
          throw fail('A chunk is not followed by CRLF.', 'InvalidRequest');
        i += 2;
        if (opts.signed) {
          const chunk = concat(parts, partsLen);
          parts = [];
          await verifyChunk(chunk);
          out.enqueue(chunk);
        }
        state = 'size';
        continue;
      }
      // done: whatever follows the final blank line is ignored.
      i = data.length;
    }
  }

  self.stream = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      try {
        await feed(chunk, controller);
      } catch (e) {
        throw self.failure ?? e;
      }
    },
    flush() {
      // Some clients end right after the last chunk's header without the closing blank line.
      if (state === 'done' || (state === 'trailer' && leftover.length === 0)) return;
      throw fail('The request body ended early.');
    },
  });
  return self;
}

export interface PayloadHasher {
  readonly stream: TransformStream<Uint8Array, Uint8Array>;
  /** Hex SHA-256 of everything that went through, once the stream is done. */
  digest(): Promise<string>;
}

/** SHA-256 of a body while it streams: native DigestStream on Workers, plain JS elsewhere. */
export function payloadHasher(): PayloadHasher {
  const DS = (
    crypto as unknown as {
      DigestStream?: new (
        alg: string,
      ) => WritableStream<Uint8Array> & { digest: Promise<ArrayBuffer> };
    }
  ).DigestStream;
  if (DS) {
    const ds = new DS('SHA-256');
    const w = ds.getWriter();
    return {
      stream: new TransformStream({
        async transform(chunk, controller) {
          await w.write(chunk);
          controller.enqueue(chunk);
        },
        async flush() {
          await w.close();
        },
      }),
      digest: async () => toHex(new Uint8Array(await ds.digest)),
    };
  }
  const sha = new Sha256();
  return {
    stream: new TransformStream({
      transform(chunk, controller) {
        sha.update(chunk);
        controller.enqueue(chunk);
      },
    }),
    digest: async () => sha.hex(),
  };
}
