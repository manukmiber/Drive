// A QR code as a PNG, for email (ADR-043): mail clients show neither SVG nor data: URIs, so the QRIS
// in an ad's payment email is a plain image Drive serves. Encoded with the `qrcode` package's matrix
// and written as an 8-bit greyscale PNG, compressed with the Web's own `CompressionStream`.
import QRCode from 'qrcode';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function zlib(raw: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** `text` as a QR (error correction M), `scale` pixels a module, a 4-module quiet zone. */
export async function qrPng(text: string, scale = 8): Promise<Uint8Array> {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const margin = 4;
  const side = (modules.size + margin * 2) * scale;
  const raw = new Uint8Array(side * (side + 1));
  for (let y = 0; y < side; y++) {
    const row = y * (side + 1);
    raw[row] = 0; // filter: none
    const my = Math.floor(y / scale) - margin;
    for (let x = 0; x < side; x++) {
      const mx = Math.floor(x / scale) - margin;
      const dark =
        mx >= 0 && my >= 0 && mx < modules.size && my < modules.size && modules.get(my, mx);
      raw[row + 1 + x] = dark ? 0 : 255;
    }
  }
  const header = new Uint8Array(13);
  const h = new DataView(header.buffer);
  h.setUint32(0, side);
  h.setUint32(4, side);
  header.set([8, 0, 0, 0, 0], 8); // 8-bit greyscale, deflate, no interlace
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', await zlib(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
