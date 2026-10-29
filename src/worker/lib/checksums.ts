// The checksums S3 clients send with uploads (S8, ADR-076): CRC32, CRC32C, CRC64NVME, SHA-1, SHA-256,
// computed while the body streams. The CRCs are JavaScript (slice-by-8 for the 32-bit ones; there is
// no native CRC in Workers), the SHAs use the native crypto.DigestStream on Workers and plain JS
// elsewhere. Values travel as base64 of the big-endian digest, as in x-amz-checksum-*.
import { base64Encode } from './crypto';
import { Sha256 } from './sha256';

export type ChecksumAlg = 'CRC32' | 'CRC32C' | 'CRC64NVME' | 'SHA1' | 'SHA256';
export const CHECKSUM_ALGS: ChecksumAlg[] = ['CRC32', 'CRC32C', 'CRC64NVME', 'SHA1', 'SHA256'];

export const checksumHeader = (alg: ChecksumAlg) => `x-amz-checksum-${alg.toLowerCase()}`;

/** The algorithm a header or trailer name stands for ("x-amz-checksum-crc32" → CRC32). */
export function algOfHeader(name: string): ChecksumAlg | null {
  const m = /^x-amz-checksum-([a-z0-9]+)$/i.exec(name.trim());
  return m ? algOf(m[1]!) : null;
}

export function algOf(name: string): ChecksumAlg | null {
  const up = name.trim().toUpperCase();
  return (CHECKSUM_ALGS as string[]).includes(up) ? (up as ChecksumAlg) : null;
}

export const isCrc = (alg: ChecksumAlg) => alg.startsWith('CRC');

/** Digest length in bytes, to check a value the client sent. */
export const DIGEST_BYTES: Record<ChecksumAlg, number> = {
  CRC32: 4,
  CRC32C: 4,
  CRC64NVME: 8,
  SHA1: 20,
  SHA256: 32,
};

export const toBase64 = base64Encode;

export function fromBase64(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4) return null;
  try {
    const bin = atob(s);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

// ── CRC-32 / CRC-32C, slice-by-8 ──

function crc32Tables(poly: number): Uint32Array {
  const t = new Uint32Array(256 * 8);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? poly ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  for (let n = 0; n < 256; n++) {
    let c = t[n]!;
    for (let s = 1; s < 8; s++) {
      c = t[c & 0xff]! ^ (c >>> 8);
      t[s * 256 + n] = c >>> 0;
    }
  }
  return t;
}

let crc32T: Uint32Array | null = null;
let crc32cT: Uint32Array | null = null;

function crc32Update(t: Uint32Array, crc: number, d: Uint8Array): number {
  let c = crc;
  let i = 0;
  const n = d.length;
  for (; i + 8 <= n; i += 8) {
    const a = (c ^ (d[i]! | (d[i + 1]! << 8) | (d[i + 2]! << 16) | (d[i + 3]! << 24))) >>> 0;
    c =
      t[1792 + (a & 0xff)]! ^
      t[1536 + ((a >>> 8) & 0xff)]! ^
      t[1280 + ((a >>> 16) & 0xff)]! ^
      t[1024 + (a >>> 24)]! ^
      t[768 + d[i + 4]!]! ^
      t[512 + d[i + 5]!]! ^
      t[256 + d[i + 6]!]! ^
      t[d[i + 7]!]!;
  }
  for (; i < n; i++) c = t[(c ^ d[i]!) & 0xff]! ^ (c >>> 8);
  return c >>> 0;
}

// ── CRC-64/NVME (reflected 0x9A6C9329AC4BC9B5), as two 32-bit halves ──

const POLY64 = 0x9a6c9329ac4bc9b5n;
let crc64Hi: Uint32Array | null = null;
let crc64Lo: Uint32Array | null = null;

function crc64Tables(): void {
  crc64Hi = new Uint32Array(256);
  crc64Lo = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = BigInt(n);
    for (let k = 0; k < 8; k++) c = c & 1n ? POLY64 ^ (c >> 1n) : c >> 1n;
    crc64Hi[n] = Number(c >> 32n);
    crc64Lo[n] = Number(c & 0xffffffffn);
  }
}

export interface Hasher {
  update(chunk: Uint8Array): void | Promise<void>;
  /** The big-endian digest, once everything went through. */
  digest(): Promise<Uint8Array>;
}

const be32 = (v: number) =>
  new Uint8Array([v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);

function crc32Hasher(castagnoli: boolean): Hasher {
  const t = castagnoli
    ? (crc32cT ??= crc32Tables(0x82f63b78))
    : (crc32T ??= crc32Tables(0xedb88320));
  let c = 0xffffffff;
  return {
    update: (d) => void (c = crc32Update(t, c, d)),
    digest: async () => be32((c ^ 0xffffffff) >>> 0),
  };
}

function crc64Hasher(): Hasher {
  if (!crc64Hi) crc64Tables();
  const hi = crc64Hi!;
  const lo = crc64Lo!;
  let h = 0xffffffff;
  let l = 0xffffffff;
  return {
    update(d) {
      for (let i = 0; i < d.length; i++) {
        const x = (l ^ d[i]!) & 0xff;
        l = (((l >>> 8) | (h << 24)) ^ lo[x]!) >>> 0;
        h = ((h >>> 8) ^ hi[x]!) >>> 0;
      }
    },
    digest: async () => {
      const out = new Uint8Array(8);
      out.set(be32((h ^ 0xffffffff) >>> 0), 0);
      out.set(be32((l ^ 0xffffffff) >>> 0), 4);
      return out;
    },
  };
}

// ── SHA-1 (JS fallback; Workers use DigestStream) ──

class Sha1 {
  private h = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
  private buf = new Uint8Array(64);
  private used = 0;
  private bytes = 0;
  private w = new Uint32Array(80);

  update(d: Uint8Array): void {
    this.bytes += d.length;
    let i = 0;
    if (this.used) {
      const take = Math.min(64 - this.used, d.length);
      this.buf.set(d.subarray(0, take), this.used);
      this.used += take;
      i = take;
      if (this.used < 64) return;
      this.block(this.buf, 0);
      this.used = 0;
    }
    for (; i + 64 <= d.length; i += 64) this.block(d, i);
    if (i < d.length) {
      this.buf.set(d.subarray(i), 0);
      this.used = d.length - i;
    }
  }

  private block(d: Uint8Array, at: number): void {
    const w = this.w;
    for (let j = 0; j < 16; j++)
      w[j] =
        (d[at + 4 * j]! << 24) |
        (d[at + 4 * j + 1]! << 16) |
        (d[at + 4 * j + 2]! << 8) |
        d[at + 4 * j + 3]!;
    for (let j = 16; j < 80; j++) {
      const x = w[j - 3]! ^ w[j - 8]! ^ w[j - 14]! ^ w[j - 16]!;
      w[j] = (x << 1) | (x >>> 31);
    }
    let [a, b, c, e, f] = [this.h[0]!, this.h[1]!, this.h[2]!, this.h[3]!, this.h[4]!];
    for (let j = 0; j < 80; j++) {
      const k = j < 20 ? 0x5a827999 : j < 40 ? 0x6ed9eba1 : j < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const fn =
        j < 20 ? (b & c) | (~b & e) : j < 40 || j >= 60 ? b ^ c ^ e : (b & c) | (b & e) | (c & e);
      const t = (((a << 5) | (a >>> 27)) + fn + f + k + w[j]!) >>> 0;
      f = e;
      e = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = t;
    }
    this.h[0] = this.h[0]! + a;
    this.h[1] = this.h[1]! + b;
    this.h[2] = this.h[2]! + c;
    this.h[3] = this.h[3]! + e;
    this.h[4] = this.h[4]! + f;
  }

  digest(): Uint8Array {
    const bits = this.bytes * 8;
    const pad = new Uint8Array((this.used < 56 ? 56 : 120) - this.used + 8);
    pad[0] = 0x80;
    const hi = Math.floor(bits / 2 ** 32);
    pad.set(be32(hi >>> 0), pad.length - 8);
    pad.set(be32(bits >>> 0), pad.length - 4);
    const bytes = this.bytes;
    this.update(pad);
    this.bytes = bytes;
    const out = new Uint8Array(20);
    for (let j = 0; j < 5; j++) out.set(be32(this.h[j]!), j * 4);
    return out;
  }
}

type DigestStreamCtor = new (alg: string) => WritableStream<Uint8Array> & {
  digest: Promise<ArrayBuffer>;
};

function shaHasher(alg: 'SHA-1' | 'SHA-256'): Hasher {
  const DS = (crypto as unknown as { DigestStream?: DigestStreamCtor }).DigestStream;
  if (DS) {
    const ds = new DS(alg);
    const w = ds.getWriter();
    return {
      update: (d) => w.write(d),
      digest: async () => {
        await w.close();
        return new Uint8Array(await ds.digest);
      },
    };
  }
  if (alg === 'SHA-1') {
    const s = new Sha1();
    return { update: (d) => s.update(d), digest: async () => s.digest() };
  }
  const s = new Sha256();
  return {
    update: (d) => void s.update(d),
    digest: async () => Uint8Array.from(s.hex().match(/../g)!, (h) => parseInt(h, 16)),
  };
}

export function hasherFor(alg: ChecksumAlg): Hasher {
  switch (alg) {
    case 'CRC32':
      return crc32Hasher(false);
    case 'CRC32C':
      return crc32Hasher(true);
    case 'CRC64NVME':
      return crc64Hasher();
    case 'SHA1':
      return shaHasher('SHA-1');
    case 'SHA256':
      return shaHasher('SHA-256');
  }
}

export async function checksumOf(alg: ChecksumAlg, data: Uint8Array): Promise<string> {
  const h = hasherFor(alg);
  await h.update(data);
  return toBase64(await h.digest());
}

/** Passes a body through unchanged while hashing it. */
export function checksumStream(alg: ChecksumAlg): {
  stream: TransformStream<Uint8Array, Uint8Array>;
  value: () => Promise<string>;
} {
  const h = hasherFor(alg);
  let done: Promise<string> | null = null;
  return {
    stream: new TransformStream({
      async transform(chunk, controller) {
        await h.update(chunk);
        controller.enqueue(chunk);
      },
    }),
    value: () => (done ??= h.digest().then(toBase64)),
  };
}

// ── combining CRCs of consecutive pieces (a FULL_OBJECT checksum of a multipart upload) ──

const POLYS: Partial<Record<ChecksumAlg, [bigint, number]>> = {
  CRC32: [0xedb88320n, 32],
  CRC32C: [0x82f63b78n, 32],
  CRC64NVME: [POLY64, 64],
};

function gf2Times(mat: bigint[], vec: bigint): bigint {
  let sum = 0n;
  for (let i = 0; vec; i++, vec >>= 1n) if (vec & 1n) sum ^= mat[i]!;
  return sum;
}

const gf2Square = (mat: bigint[]) => mat.map((row) => gf2Times(mat, row));

/** zlib's crc32_combine, for any reflected CRC whose init and final XOR are all ones. */
function combine(alg: ChecksumAlg, crc1: bigint, crc2: bigint, len2: number): bigint {
  const [poly, width] = POLYS[alg]!;
  if (len2 <= 0) return crc1;
  let odd: bigint[] = [poly];
  for (let n = 1, row = 1n; n < width; n++, row <<= 1n) odd.push(row);
  let even = gf2Square(odd); // two zero bits
  odd = gf2Square(even); // four zero bits
  let len = BigInt(len2);
  do {
    even = gf2Square(odd);
    if (len & 1n) crc1 = gf2Times(even, crc1);
    len >>= 1n;
    if (!len) break;
    odd = gf2Square(even);
    if (len & 1n) crc1 = gf2Times(odd, crc1);
    len >>= 1n;
  } while (len);
  return crc1 ^ crc2;
}

const toBig = (b: Uint8Array) => b.reduce((n, x) => (n << 8n) | BigInt(x), 0n);
function fromBig(v: bigint, bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = bytes - 1; i >= 0; i--, v >>= 8n) out[i] = Number(v & 0xffn);
  return out;
}

/** The CRC of the whole object from its parts' CRCs (base64) and sizes. */
export function combineCrcs(
  alg: ChecksumAlg,
  parts: Array<{ value: string; size: number }>,
): string {
  const bytes = DIGEST_BYTES[alg];
  let crc: bigint | null = null;
  for (const p of parts) {
    const v = toBig(fromBase64(p.value)!);
    crc = crc === null ? v : combine(alg, crc, v, p.size);
  }
  return toBase64(fromBig(crc ?? 0n, bytes));
}

/** A COMPOSITE checksum: the checksum of the parts' checksums, then "-<parts>". */
export async function compositeOf(alg: ChecksumAlg, parts: string[]): Promise<string> {
  const raw = parts.map((p) => fromBase64(p)!);
  const all = new Uint8Array(raw.reduce((n, r) => n + r.length, 0));
  let o = 0;
  for (const r of raw) {
    all.set(r, o);
    o += r.length;
  }
  return `${await checksumOf(alg, all)}-${parts.length}`;
}
