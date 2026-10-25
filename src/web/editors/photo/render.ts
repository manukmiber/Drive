// Drawing the edited photo on a canvas: the same code for the preview (a smaller copy) and the
// saved file (the full photo), so what is shown is what is saved (ADR-050).
import { NO_ADJUST, applyPipeline, pipeline, type Adjust, type FilterId } from './adjust';
import { FULL, outputSize, turnedSize, type Orientation, type Rect } from './geometry';

export interface PhotoState {
  o: Orientation;
  crop: Rect;
  adjust: Adjust;
  filter: FilterId;
  /** Of the cropped size, 0…1. */
  scale: number;
}

export const START: PhotoState = {
  o: { turn: 0, flipH: false, flipV: false },
  crop: FULL,
  adjust: NO_ADJUST,
  filter: 'none',
  scale: 1,
};

export type OutType = 'image/jpeg' | 'image/png' | 'image/webp';

/** Draws `crop` of the turned and flipped image into the whole canvas, colours applied. */
export function drawPhoto(
  canvas: HTMLCanvasElement,
  img: ImageBitmap,
  st: Pick<PhotoState, 'o' | 'adjust' | 'filter'>,
  crop: Rect,
  background: string | null = null,
): void {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  const { w: OW, h: OH } = turnedSize(img.width, img.height, st.o.turn);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.scale(canvas.width / (crop.w * OW), canvas.height / (crop.h * OH));
  ctx.translate(-crop.x * OW, -crop.y * OH);
  ctx.translate(OW / 2, OH / 2);
  // Flips are as seen, after the turn: in canvas order they come first.
  ctx.scale(st.o.flipH ? -1 : 1, st.o.flipV ? -1 : 1);
  ctx.rotate((st.o.turn * Math.PI) / 180);
  ctx.drawImage(img, -img.width / 2, -img.height / 2);
  ctx.restore();
  const p = pipeline(st.adjust, st.filter);
  if (p) {
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    applyPipeline(data.data, p);
    ctx.putImageData(data, 0, 0);
  }
}

function toBlob(canvas: HTMLCanvasElement, type: OutType, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), type, quality),
  );
}

/** The saved photo. Browsers that can't write WebP give PNG; that is kept and reported. */
export async function exportPhoto(
  img: ImageBitmap,
  st: PhotoState,
  type: OutType,
  quality: number,
): Promise<Blob> {
  const size = outputSize(img.width, img.height, st.o.turn, st.crop, st.scale);
  const canvas = document.createElement('canvas');
  canvas.width = size.w;
  canvas.height = size.h;
  // JPEG has no transparency: white, not black, behind it.
  drawPhoto(canvas, img, st, st.crop, type === 'image/jpeg' ? '#ffffff' : null);
  const blob = await toBlob(canvas, type, quality);
  canvas.width = canvas.height = 0;
  return blob;
}

/** A smaller copy for the preview and the filter thumbnails (long side `max`). */
export async function scaled(img: ImageBitmap, max: number): Promise<ImageBitmap> {
  const s = Math.min(1, max / Math.max(img.width, img.height));
  if (s === 1) return img;
  return createImageBitmap(img, {
    resizeWidth: Math.max(1, Math.round(img.width * s)),
    resizeHeight: Math.max(1, Math.round(img.height * s)),
    resizeQuality: 'high',
  });
}

export const extFor = (type: string) =>
  type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';

export function defaultType(mime: string, name: string): OutType {
  if (mime === 'image/png' || /\.png$/i.test(name)) return 'image/png';
  if (mime === 'image/webp' || /\.webp$/i.test(name)) return 'image/webp';
  return 'image/jpeg';
}
