// Pictures in and out of the editors (ADR-067). The browser decodes and encodes what it can (JPEG,
// PNG, WebP, often AVIF); JPEG XL both ways and AVIF where the browser can't write it go through
// WebAssembly codecs (jSquash, libjxl and libavif) that load only when a picture needs them.

import { jxlSignature } from './signature';

export type ImageType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/avif' | 'image/jxl';

export const IMAGE_TYPES: ImageType[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/jxl',
];

export const IMAGE_EXT: Record<ImageType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/jxl': 'jxl',
};

export const IMAGE_LABEL: Record<ImageType, string> = {
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
  'image/avif': 'AVIF',
  'image/jxl': 'JPEG XL',
};

/** Types without a quality setting. */
export const lossless = (type: ImageType) => type === 'image/png';

export const isJxlName = (mime: string | null, name: string) =>
  mime === 'image/jxl' || /\.jxl$/i.test(name);

async function isJxl(blob: Blob, name: string): Promise<boolean> {
  if (isJxlName(blob.type, name)) return true;
  return jxlSignature(new Uint8Array(await blob.slice(0, 12).arrayBuffer()));
}

/** JPEG XL → pixels, in WebAssembly. */
export async function decodeJxl(blob: Blob): Promise<ImageData> {
  const { default: decode } = await import('@jsquash/jxl/decode');
  return decode(await blob.arrayBuffer());
}

/**
 * Any picture the editors open, turned the way the camera meant. The browser first; JPEG XL that
 * it can't read is decoded here.
 */
export async function decodeImage(blob: Blob, name: string): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch (e) {
    if (!(await isJxl(blob, name))) throw e;
  }
  return createImageBitmap(await decodeJxl(blob));
}

/** A picture the browser can show: JPEG XL it can't read becomes PNG, the rest stays as it is. */
export async function displayable(blob: Blob, name: string): Promise<Blob> {
  if (!(await isJxl(blob, name)) || (await nativeJxl())) return blob;
  const data = await decodeJxl(blob);
  const c = document.createElement('canvas');
  c.width = data.width;
  c.height = data.height;
  c.getContext('2d')!.putImageData(data, 0, 0);
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/png'),
  );
}

let native: Promise<boolean> | null = null;
/** Does this browser show JPEG XL itself (Safari does)? A 1×1 picture tells. */
export function nativeJxl(): Promise<boolean> {
  native ??= new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.width === 1);
    img.onerror = () => resolve(false);
    img.src =
      'data:image/jxl;base64,/woAELATAEiAKAD0AFUPAACoUBll3ODlXM+XHzospm1cZ2irbQsAAADgAfwrSRQZxyapDpnAIUks4nEpAUQAcUrmsAkaINCVJAA=';
  });
  return native;
}

export interface EncodeOptions {
  /** 0…1; ignored for PNG and lossless. */
  quality: number;
  /** JPEG XL and WebP without loss (WebP only through the browser). */
  lossless?: boolean;
  /** JPEG XL 1…9, AVIF 0…10 (slower = smaller). Defaults are fast enough for a phone. */
  effort?: number;
}

function canvasBlob(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  type: string,
  quality: number,
): Promise<Blob> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), type, quality),
  );
}

function pixels(canvas: HTMLCanvasElement | OffscreenCanvas): ImageData {
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as
    CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error('canvas');
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * The canvas as a file of `type`. JPEG, PNG and WebP come from the browser (one that can't write
 * WebP gives PNG; the caller sees the type it got). AVIF comes from the browser when it can write
 * it, else from libavif; JPEG XL always from libjxl.
 */
export async function encodeImage(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  type: ImageType,
  o: EncodeOptions,
): Promise<Blob> {
  const q = Math.max(0, Math.min(1, o.quality));
  if (type === 'image/jxl') {
    const { default: encode } = await import('@jsquash/jxl/encode');
    const out = await encode(pixels(canvas), {
      quality: o.lossless ? 100 : Math.round(q * 100),
      lossless: Boolean(o.lossless),
      effort: o.effort ?? 4,
    });
    return new Blob([out], { type });
  }
  if (type === 'image/avif') {
    const own = await canvasBlob(canvas, type, q).catch(() => null);
    if (own?.type === type) return own;
    const { default: encode } = await import('@jsquash/avif/encode');
    const out = await encode(pixels(canvas), {
      quality: Math.round(q * 100),
      speed: o.effort ?? 8,
    });
    return new Blob([out], { type });
  }
  if (type === 'image/webp' && o.lossless) return canvasBlob(canvas, type, 1);
  return canvasBlob(canvas, type, q);
}

export const extForType = (type: string): string =>
  (IMAGE_EXT as Record<string, string>)[type] ?? 'jpg';
