import { createHash } from 'node:crypto';
import { crc32 as zlibCrc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { Crc32 } from '../../src/worker/lib/crc32';
import { bytesToBase62, isUlid, randomBase62, ulid } from '../../src/worker/lib/ids';
import { contentDisposition, etagMatches, parseRange } from '../../src/worker/lib/http';
import { nameKey, nameWithSuffix, sanitizeName } from '../../src/worker/lib/names';
import { Sha256 } from '../../src/worker/lib/sha256';
import { sniffMime } from '../../src/worker/lib/sniff';
import { hmacBase62, timingSafeEqual } from '../../src/worker/lib/crypto';

describe('ids', () => {
  it('generates sortable, well-formed ULIDs', () => {
    const a = ulid(1_700_000_000_000);
    const b = ulid(1_700_000_000_001);
    expect(isUlid(a)).toBe(true);
    expect(a < b).toBe(true);
    expect(new Set(Array.from({ length: 1000 }, () => ulid())).size).toBe(1000);
  });

  it('produces base62 of the requested length', () => {
    const s = randomBase62(64);
    expect(s).toMatch(/^[0-9A-Za-z]{64}$/);
    expect(bytesToBase62(new Uint8Array([0, 0, 1]))).toBe('1');
  });

  it('derives fixed-length HMAC signatures', async () => {
    const sig = await hmacBase62('secret', 'r64', 32);
    expect(sig).toMatch(/^[0-9A-Za-z]{32}$/);
    expect(await hmacBase62('secret', 'r64', 32)).toBe(sig);
    expect(timingSafeEqual(sig, sig)).toBe(true);
    expect(timingSafeEqual(sig, sig.slice(0, 31) + 'x')).toBe(false);
  });
});

describe('names', () => {
  it('strips control characters and separators, normalizes NFC', () => {
    expect(sanitizeName('  a/b\\c\u0000.txt ')).toBe('abc.txt');
    expect(sanitizeName('Café.txt')).toBe('Café.txt');
    expect(sanitizeName('laporan...')).toBe('laporan');
  });

  it('defuses Windows reserved names', () => {
    expect(sanitizeName('CON')).toBe('CON_');
    expect(sanitizeName('nul.txt')).toBe('nul_.txt');
    expect(sanitizeName('console.log')).toBe('console.log');
  });

  it('rejects empty, dot names and >255 bytes', () => {
    for (const bad of ['', '   ', '.', '..', '/']) expect(() => sanitizeName(bad)).toThrow();
    expect(() => sanitizeName('é'.repeat(128))).toThrow();
    expect(sanitizeName('a'.repeat(255))).toHaveLength(255);
  });

  it('builds keys and suffixes', () => {
    expect(nameKey('FOTO.JPG')).toBe('foto.jpg');
    expect(nameWithSuffix('foto.jpg', 1)).toBe('foto (1).jpg');
    expect(nameWithSuffix('.env', 2)).toBe('.env (2)');
    expect(nameWithSuffix('arsip.tar.zst', 3)).toBe('arsip.tar (3).zst');
  });
});

describe('http', () => {
  it('parses ranges', () => {
    expect(parseRange(null, 100)).toEqual({ kind: 'none' });
    expect(parseRange('bytes=0-9', 100)).toEqual({ kind: 'single', start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ kind: 'single', start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ kind: 'single', start: 90, end: 99 });
    expect(parseRange('bytes=50-500', 100)).toEqual({ kind: 'single', start: 50, end: 99 });
    expect(parseRange('bytes=100-', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=0-1,5-6', 100)).toEqual({ kind: 'multi' });
    expect(parseRange('bytes=5-1', 100)).toEqual({ kind: 'none' });
    expect(parseRange('items=0-1', 100)).toEqual({ kind: 'none' });
  });

  it('formats Content-Disposition per RFC 6266/5987', () => {
    expect(contentDisposition('Laporan Q1.pdf')).toBe(
      `attachment; filename="Laporan Q1.pdf"; filename*=UTF-8''Laporan%20Q1.pdf`,
    );
    const h = contentDisposition('foto "liburan" 🌴.jpg');
    expect(h).toContain('filename="foto _liburan_ __.jpg"');
    expect(h).toContain(`filename*=UTF-8''foto%20%22liburan%22%20%F0%9F%8C%B4.jpg`);
  });

  it('matches ETags', () => {
    expect(etagMatches('"abc"', '"abc"')).toBe(true);
    expect(etagMatches('W/"abc", "def"', '"abc"')).toBe(true);
    expect(etagMatches('"x"', '"abc"')).toBe(false);
  });
});

describe('hashing', () => {
  it('incremental SHA-256 matches node:crypto across chunk boundaries', () => {
    const data = new Uint8Array(200_003).map((_, i) => (i * 31) & 0xff);
    const expected = createHash('sha256').update(data).digest('hex');
    for (const chunk of [1, 63, 64, 65, 4096, 200_003]) {
      const h = new Sha256();
      for (let i = 0; i < data.length; i += chunk) h.update(data.subarray(i, i + chunk));
      expect(h.hex(), `chunk ${chunk}`).toBe(expected);
    }
    expect(new Sha256().hex()).toBe(createHash('sha256').digest('hex'));
  });

  it('CRC32 matches zlib', () => {
    const data = new TextEncoder().encode('Zeiko Cloud Storage');
    const c = new Crc32().update(data.subarray(0, 5)).update(data.subarray(5)).digest();
    expect(c).toBe(zlibCrc32(data));
  });

  it('sniffs common types', () => {
    expect(sniffMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      'image/png',
    );
    expect(sniffMime(new TextEncoder().encode('%PDF-1.7'))).toBe('application/pdf');
    expect(sniffMime(new TextEncoder().encode('hello'))).toBeNull();
  });
});

describe('demo seed', () => {
  it('uses valid ULIDs (download tokens reject anything else)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../dev/seed-demo.ts', import.meta.url), 'utf8');
    const ids = [...src.matchAll(/id: '([^']+)'/g)].map((m) => m[1]!);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(isUlid(id)).toBe(true);
  });
});
