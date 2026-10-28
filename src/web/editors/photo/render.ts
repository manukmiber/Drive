// Drawing the edited photo on a canvas: the same code for the preview (a smaller copy) and the
// saved file (the full photo), so what is shown is what is saved (ADR-050, ADR-052).
import { encodeImage, extForType, type ImageType } from '../codecs/image';
import { applyPipeline, pipeline, resolve } from './adjust';
import {
  blurred,
  glow,
  glowSigma,
  grain,
  heal,
  lensBlur,
  lensSigma,
  sharpen,
  structure,
  structureSigma,
  vignette,
} from './effects';
import { apply, matScale, outputSize, photoMatrix, type Mat, type Rect } from './geometry';
import type { Frame, PhotoState, TextMark } from './state';

export type OutType = ImageType;

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

let measurer: CanvasRenderingContext2D | null = null;

/** Where a text sits on a canvas drawn with `m`: its middle, box and font size, in canvas pixels. */
export function textLayout(t: TextMark, m: Mat, srcW: number, srcH: number) {
  const [x, y] = apply(m, t.x * srcW, t.y * srcH);
  const px = Math.max(1, t.size * Math.min(srcW, srcH) * matScale(m));
  measurer ??= document.createElement('canvas').getContext('2d');
  const font = `${t.style === 'plain' ? 500 : 800} ${px}px ${FONT}`;
  const lines = t.text.split('\n');
  let w = px;
  if (measurer) {
    measurer.font = font;
    w = Math.max(...lines.map((l) => measurer!.measureText(l).width), px * 0.5);
  }
  const pad = t.style === 'box' ? px * 0.45 : px * 0.1;
  return { x, y, px, font, lines, w: w + pad * 2, h: lines.length * px * 1.2 + pad * 1.2 };
}

/** Black or white, whichever reads on `hex`. */
export function onColour(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const lum = 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  return lum > 150 ? '#111111' : '#ffffff';
}

function drawTexts(
  ctx: CanvasRenderingContext2D,
  st: PhotoState,
  m: Mat,
  srcW: number,
  srcH: number,
) {
  for (const t of st.texts) {
    if (!t.text.trim()) continue;
    const l = textLayout(t, m, srcW, srcH);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = l.font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lh = l.px * 1.2;
    const top = l.y - (l.lines.length * lh) / 2 + lh / 2;
    let ink = t.color;
    if (t.style === 'box') {
      ctx.fillStyle = t.color;
      ctx.beginPath();
      ctx.roundRect(l.x - l.w / 2, l.y - l.h / 2, l.w, l.h, l.px * 0.3);
      ctx.fill();
      ink = onColour(t.color);
    } else if (t.style === 'outline') {
      ctx.lineWidth = l.px * 0.14;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = onColour(t.color);
      l.lines.forEach((line, i) => ctx.strokeText(line, l.x, top + i * lh));
    } else {
      ctx.shadowColor = 'rgba(0,0,0,0.35)';
      ctx.shadowBlur = l.px * 0.12;
    }
    ctx.fillStyle = ink;
    l.lines.forEach((line, i) => ctx.fillText(line, l.x, top + i * lh));
    ctx.restore();
  }
}

function drawFrame(ctx: CanvasRenderingContext2D, f: Frame, W: number, H: number) {
  if (f.style === 'none') return;
  const short = Math.min(W, H);
  const k = f.width / 100;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = f.color;
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  if (f.style === 'round') {
    const b = short * (0.006 + 0.02 * k);
    ctx.roundRect(b, b, W - 2 * b, H - 2 * b, short * (0.04 + 0.14 * k));
  } else {
    const side = short * (f.style === 'thin' ? 0.008 + 0.025 * k : 0.03 + 0.07 * k);
    const bottom = f.style === 'polaroid' ? side * 3.2 : side;
    ctx.rect(side, side, W - 2 * side, H - side - bottom);
  }
  ctx.fill('evenodd');
  ctx.restore();
}

/** Draws `view` of the edited photo into the whole canvas: geometry, colour, effects, text, frame. */
export function drawPhoto(
  canvas: HTMLCanvasElement,
  img: ImageBitmap,
  st: PhotoState,
  view: Rect,
  background: string | null = null,
): void {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  const { width: W, height: H } = canvas;
  const m = photoMatrix(img.width, img.height, st.o, st.angle, view, W, H);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(...m);
  ctx.drawImage(img, 0, 0);
  ctx.restore();

  const r = resolve(st);
  const p = pipeline(r);
  const lens = st.lens.shape !== 'off' && st.lens.strength > 0;
  if (
    st.heal.length ||
    p ||
    r.detail.structure ||
    r.detail.sharpen ||
    r.effects.glow ||
    r.effects.grain ||
    r.vignette ||
    lens
  ) {
    const data = ctx.getImageData(0, 0, W, H);
    const im = { data: data.data, width: W, height: H };
    const s = matScale(m) * Math.min(img.width, img.height);
    for (const spot of st.heal) {
      const [x, y] = apply(m, spot.x * img.width, spot.y * img.height);
      heal(im, x, y, spot.r * s);
    }
    if (p) applyPipeline(im.data, p);
    if (r.detail.structure) structure(im, blurred(im, structureSigma(W, H)), r.detail.structure);
    if (r.detail.sharpen) sharpen(im, r.detail.sharpen);
    if (r.effects.glow) glow(im, blurred(im, glowSigma(W, H)), r.effects.glow);
    if (lens) lensBlur(im, blurred(im, lensSigma(W, H, st.lens.strength)), st.lens);
    if (r.vignette) vignette(im, st.vignette, r.vignette);
    if (r.effects.grain) grain(im, r.effects.grain);
    ctx.putImageData(data, 0, 0);
  }
  drawTexts(ctx, st, m, img.width, img.height);
  drawFrame(ctx, st.frame, W, H);
}

/**
 * The saved photo. Browsers that can't write WebP give PNG; that is kept and reported. JPEG XL and
 * AVIF come from WebAssembly encoders where the browser has none (ADR-067).
 */
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
  const blob = await encodeImage(canvas, type, { quality });
  canvas.width = canvas.height = 0;
  return blob;
}

/** A smaller copy for the preview and the looks' thumbnails (long side `max`). */
export async function scaled(img: ImageBitmap, max: number): Promise<ImageBitmap> {
  const s = Math.min(1, max / Math.max(img.width, img.height));
  if (s === 1) return img;
  return createImageBitmap(img, {
    resizeWidth: Math.max(1, Math.round(img.width * s)),
    resizeHeight: Math.max(1, Math.round(img.height * s)),
    resizeQuality: 'high',
  });
}

export const extFor = extForType;

export function defaultType(mime: string, name: string): OutType {
  if (mime === 'image/png' || /\.png$/i.test(name)) return 'image/png';
  if (mime === 'image/webp' || /\.webp$/i.test(name)) return 'image/webp';
  if (mime === 'image/avif' || /\.avif$/i.test(name)) return 'image/avif';
  if (mime === 'image/jxl' || /\.jxl$/i.test(name)) return 'image/jxl';
  return 'image/jpeg';
}
