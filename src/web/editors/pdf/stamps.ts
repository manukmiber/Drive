// Pictures put on PDF pages (ADR-050): signatures drawn, typed or photographed, text and dates.
// Each becomes a trimmed PNG. Signatures can be remembered on this device only (localStorage).

export interface StampImage {
  png: Uint8Array;
  /** For showing it (a data: URL). */
  url: string;
  /** Height ÷ width in pixels. */
  ratio: number;
}

/** The smallest canvas around what is not transparent. */
function trim(src: HTMLCanvasElement, pad = 4): HTMLCanvasElement | null {
  const ctx = src.getContext('2d', { willReadFrequently: true })!;
  const { width: w, height: h } = src;
  const data = ctx.getImageData(0, 0, w, h).data;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3]! > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  if (x1 < 0) return null;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(w - 1, x1 + pad);
  y1 = Math.min(h - 1, y1 + pad);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext('2d')!.drawImage(src, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

export function fromDataUrl(url: string): StampImage | null {
  const m = /^data:image\/png;base64,(.+)$/.exec(url);
  if (!m) return null;
  const bin = atob(m[1]!);
  const png = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  // Width and height are bytes 16–23 of a PNG (the IHDR chunk).
  const view = new DataView(png.buffer);
  const w = view.getUint32(16);
  const h = view.getUint32(20);
  return w && h ? { png, url, ratio: h / w } : null;
}

/** Null when nothing was drawn. */
export function fromCanvas(canvas: HTMLCanvasElement): StampImage | null {
  const t = trim(canvas);
  return t ? fromDataUrl(t.toDataURL('image/png')) : null;
}

export const INK = { black: '#111827', blue: '#1d3fbf' } as const;
export type Ink = keyof typeof INK;

/** Text as a picture (any script works, unlike the PDF's standard fonts). */
export function textStamp(text: string, ink: Ink, script = false): StampImage | null {
  const size = 96;
  const font = script
    ? `italic ${size}px "Segoe Script", "Brush Script MT", "Snell Roundhand", "URW Chancery L", cursive`
    : `${size * 0.6}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 40;
  c.width = Math.min(4000, w);
  c.height = size * 1.6;
  ctx.font = font;
  ctx.fillStyle = INK[ink];
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 20, c.height / 2);
  return fromCanvas(c);
}

/** A photo of a signature on paper: near-white becomes transparent, the ink takes `ink`. */
export async function photoStamp(file: Blob, ink: Ink): Promise<StampImage | null> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const s = Math.min(1, 1200 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * s));
  c.height = Math.max(1, Math.round(bmp.height * s));
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const hex = INK[ink];
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
    // Paper (light) fades out; ink (dark) stays, smoothly in between.
    const a = Math.max(0, Math.min(1, (200 - lum) / 80));
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
    d[i + 3] = Math.round(a * (d[i + 3]! / 255) * 255);
  }
  ctx.putImageData(img, 0, 0);
  return fromCanvas(c);
}

const KEY = 'zk_signatures';
const MAX_SAVED = 4;

export function savedSignatures(): StampImage[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    if (!Array.isArray(list)) return [];
    return list.flatMap((u) => (typeof u === 'string' ? (fromDataUrl(u) ?? []) : []));
  } catch {
    return [];
  }
}

export function rememberSignature(s: StampImage): void {
  try {
    const urls = [
      s.url,
      ...savedSignatures()
        .map((x) => x.url)
        .filter((u) => u !== s.url),
    ];
    localStorage.setItem(KEY, JSON.stringify(urls.slice(0, MAX_SAVED)));
  } catch {
    // Private mode or full storage: it just isn't remembered.
  }
}

export function forgetSignature(url: string): void {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify(
        savedSignatures()
          .map((x) => x.url)
          .filter((u) => u !== url),
      ),
    );
  } catch {
    // As above.
  }
}
