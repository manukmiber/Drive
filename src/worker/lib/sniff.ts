// Minimal magic-byte sniffing so stored MIME types do not trust the client (SPEC §14.4).
const SIGS: Array<{ mime: string; bytes: number[]; offset?: number }> = [
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { mime: 'application/zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { mime: 'application/x-7z-compressed', bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  { mime: 'application/x-rar-compressed', bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07] },
  { mime: 'application/gzip', bytes: [0x1f, 0x8b] },
  { mime: 'application/zstd', bytes: [0x28, 0xb5, 0x2f, 0xfd] },
  { mime: 'application/x-msdownload', bytes: [0x4d, 0x5a] },
  { mime: 'application/x-elf', bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { mime: 'audio/mpeg', bytes: [0x49, 0x44, 0x33] },
  { mime: 'audio/ogg', bytes: [0x4f, 0x67, 0x67, 0x53] },
  { mime: 'audio/flac', bytes: [0x66, 0x4c, 0x61, 0x43] },
  { mime: 'video/webm', bytes: [0x1a, 0x45, 0xdf, 0xa3] },
  // JPEG XL: the ISOBMFF-style container, or a bare codestream (ADR-067).
  {
    mime: 'image/jxl',
    bytes: [0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a],
  },
  { mime: 'image/jxl', bytes: [0xff, 0x0a] },
];

export function sniffMime(head: Uint8Array): string | null {
  for (const sig of SIGS) {
    const off = sig.offset ?? 0;
    if (head.length < off + sig.bytes.length) continue;
    if (sig.bytes.every((b, i) => head[off + i] === b)) return sig.mime;
  }
  const ascii = (start: number, len: number) =>
    String.fromCharCode(...head.subarray(start, start + len));
  if (head.length >= 12 && ascii(0, 4) === 'RIFF') {
    const kind = ascii(8, 4);
    if (kind === 'WEBP') return 'image/webp';
    if (kind === 'WAVE') return 'audio/wav';
    if (kind === 'AVI ') return 'video/x-msvideo';
  }
  if (head.length >= 12 && ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4);
    if (brand.startsWith('avif') || brand === 'avis') return 'image/avif';
    if (brand.startsWith('heic') || brand === 'heix' || brand === 'mif1') return 'image/heic';
    if (brand.startsWith('M4A')) return 'audio/mp4';
    if (brand === 'qt  ') return 'video/quicktime';
    return 'video/mp4';
  }
  return null;
}
