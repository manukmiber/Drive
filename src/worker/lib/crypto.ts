// Web Crypto helpers shared by download tokens, share signatures and preview URLs.
import { bytesToBase62 } from './ids';

const enc = new TextEncoder();
const hmacKeys = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = hmacKeys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    hmacKeys.set(secret, key);
  }
  return key;
}

export async function hmacSha256(secret: string, data: string): Promise<Uint8Array> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data));
  return new Uint8Array(sig);
}

export async function hmacBase62(secret: string, data: string, length?: number): Promise<string> {
  const out = bytesToBase62(await hmacSha256(secret, data));
  return length === undefined ? out : out.padStart(length, '0').slice(0, length);
}

export async function hmacBase64Url(secret: string, data: string): Promise<string> {
  return base64UrlEncode(await hmacSha256(secret, data));
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return toHex(new Uint8Array(digest));
}

/** Constant-time string comparison (length leak only). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const aesKeys = new Map<string, Promise<CryptoKey>>();

/** AES-256-GCM key from a secret holding 32 bytes in base64 or base64url. */
function aesKey(material: string): Promise<CryptoKey> {
  let key = aesKeys.get(material);
  if (!key) {
    const raw = base64UrlDecode(material.trim().replace(/=+$/, ''));
    if (raw.length !== 32) throw new Error('encryption key must be 32 bytes (base64)');
    key = crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    aesKeys.set(material, key);
  }
  return key;
}

/** base64url(iv ‖ ciphertext) */
export async function aesGcmEncrypt(material: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      await aesKey(material),
      enc.encode(plaintext),
    ),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return base64UrlEncode(out);
}

export async function aesGcmDecrypt(material: string, sealed: string): Promise<string> {
  const bytes = base64UrlDecode(sealed);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.subarray(0, 12) },
    await aesKey(material),
    bytes.subarray(12),
  );
  return new TextDecoder().decode(pt);
}

/** Salted, rotating hash for IPs (SPEC §14.5): salt changes daily. */
export async function hashIp(secret: string, ip: string, day: string): Promise<string> {
  return (await hmacBase62(secret, `ip|${day}|${ip}`)).slice(0, 22);
}
