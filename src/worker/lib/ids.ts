// ULID (ADR-009): 48-bit ms timestamp + 80 bits of CSPRNG randomness, Crockford base32.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function ulid(now: number = Date.now()): string {
  let time = now;
  let ts = '';
  for (let i = 0; i < 10; i++) {
    ts = CROCKFORD[time % 32] + ts;
    time = Math.floor(time / 32);
  }
  const rand = crypto.getRandomValues(new Uint8Array(16));
  let r = '';
  for (const b of rand) r += CROCKFORD[b & 31];
  return ts + r;
}

/** Uniform random base62 string (rejection sampling, no modulo bias). */
export function randomBase62(length: number): string {
  let out = '';
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const b of bytes) {
      if (b < 248) out += BASE62[b % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

/** Deterministic base62 encoding of bytes (big-endian integer). */
export function bytesToBase62(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  if (n === 0n) return '0';
  let out = '';
  while (n > 0n) {
    out = BASE62[Number(n % 62n)] + out;
    n /= 62n;
  }
  return out;
}

export function isBase62(s: string, length?: number): boolean {
  if (length !== undefined && s.length !== length) return false;
  return /^[0-9A-Za-z]+$/.test(s);
}

export function isUlid(s: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(s);
}
