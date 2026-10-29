import { describe, expect, it } from 'vitest';
import {
  checksumOf,
  combineCrcs,
  compositeOf,
  fromBase64,
  toBase64,
  type ChecksumAlg,
} from '../../src/worker/lib/checksums';

const enc = (s: string) => new TextEncoder().encode(s);
const hex = (b64: string) =>
  [...fromBase64(b64)!].map((b) => b.toString(16).padStart(2, '0')).join('');

describe('upload checksums (ADR-076)', () => {
  it('match the standard check values', async () => {
    const nine = enc('123456789');
    expect(hex(await checksumOf('CRC32', nine))).toBe('cbf43926');
    expect(hex(await checksumOf('CRC32C', nine))).toBe('e3069283');
    expect(hex(await checksumOf('CRC64NVME', nine))).toBe('ae8b14860a799888');
    expect(hex(await checksumOf('SHA1', enc('abc')))).toBe(
      'a9993e364706816aba3e25717850c26c9cd0d89d',
    );
    expect(hex(await checksumOf('SHA256', enc('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    // What the AWS SDK sends for an empty body.
    expect(await checksumOf('CRC32', new Uint8Array(0))).toBe('AAAAAA==');
  });

  it('hash across odd chunk boundaries the same as in one go', async () => {
    const data = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7 + 3) & 0xff);
    for (const alg of ['CRC32', 'CRC32C', 'CRC64NVME', 'SHA1', 'SHA256'] as ChecksumAlg[]) {
      const { hasherFor } = await import('../../src/worker/lib/checksums');
      const h = hasherFor(alg);
      for (const [a, b] of [
        [0, 3],
        [3, 64],
        [64, 65],
        [65, 640],
        [640, 1000],
      ])
        await h.update(data.subarray(a, b));
      expect(toBase64(await h.digest())).toBe(await checksumOf(alg, data));
    }
  });

  it('combine the CRCs of parts into the whole and build composite values', async () => {
    const data = Uint8Array.from({ length: 3001 }, (_, i) => (i * 31 + 5) & 0xff);
    const cuts = [0, 1024, 2048, 3001];
    for (const alg of ['CRC32', 'CRC32C', 'CRC64NVME'] as ChecksumAlg[]) {
      const parts = [];
      for (let i = 0; i < 3; i++) {
        const piece = data.subarray(cuts[i], cuts[i + 1]);
        parts.push({ value: await checksumOf(alg, piece), size: piece.length });
      }
      expect(combineCrcs(alg, parts)).toBe(await checksumOf(alg, data));
    }
    const a = await checksumOf('SHA256', enc('a'));
    const b = await checksumOf('SHA256', enc('b'));
    const joined = new Uint8Array([...fromBase64(a)!, ...fromBase64(b)!]);
    expect(await compositeOf('SHA256', [a, b])).toBe(`${await checksumOf('SHA256', joined)}-2`);
  });
});
