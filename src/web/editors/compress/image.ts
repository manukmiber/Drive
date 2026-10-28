// Photos in the local compressor (ADR-067): decode (JPEG XL too), make the long side at most
// `maxSide`, and write the chosen format. Writing again drops the location and camera data.
import { decodeImage, encodeImage, extForType, type ImageType } from '../codecs/image';

export interface ImageSettings {
  type: ImageType;
  /** 0…1. */
  quality: number;
  lossless: boolean;
  /** Long side in pixels; 0 = as it is. Never made bigger. */
  maxSide: number;
  /** JPEG XL 1…9; AVIF uses 10 − effort as its speed. */
  effort: number;
  /** Keep the original when the result isn't smaller. */
  keepIfBigger: boolean;
}

export const DEFAULT_IMAGE: ImageSettings = {
  type: 'image/webp',
  quality: 0.8,
  lossless: false,
  maxSide: 0,
  effort: 4,
  keepIfBigger: true,
};

export async function imageInfo(blob: Blob, name: string) {
  const bmp = await decodeImage(blob, name);
  const out = { width: bmp.width, height: bmp.height };
  bmp.close();
  return out;
}

export async function compressImage(
  blob: Blob,
  name: string,
  s: ImageSettings,
): Promise<{ blob: Blob; ext: string; same: boolean }> {
  const bmp = await decodeImage(blob, name);
  try {
    const k = s.maxSide ? Math.min(1, s.maxSide / Math.max(bmp.width, bmp.height)) : 1;
    const w = Math.max(1, Math.round(bmp.width * k));
    const h = Math.max(1, Math.round(bmp.height * k));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    // Formats without transparency get white behind it, not black.
    if (s.type === 'image/jpeg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
    }
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);
    const out = await encodeImage(canvas, s.type, {
      quality: s.quality,
      lossless: s.lossless,
      effort: s.type === 'image/avif' ? 10 - s.effort : s.effort,
    });
    canvas.width = canvas.height = 0;
    if (s.keepIfBigger && out.size >= blob.size) return { blob, ext: '', same: true };
    return { blob: out, ext: extForType(out.type || s.type), same: false };
  } finally {
    bmp.close();
  }
}
