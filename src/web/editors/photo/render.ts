// Drawing the edited photo on a canvas: the same code for the preview (a smaller copy) and the
// saved file (the full photo), so what is shown is what is saved (ADR-050, ADR-052).
import { encodeImage, extForType, type ImageType } from '../codecs/image';
import { drawDecor, type Place } from '../decor/draw';
import { applyPipeline, pipeline, resolve } from './adjust';
import {
  blurred,
  glow,
  glowSigma,
  grain,
  heal,
  lensBlur,
  lensSigma,
  redact,
  sharpen,
  structure,
  structureSigma,
  vignette,
} from './effects';
import { apply, matScale, outputSize, photoMatrix, type Mat, type Rect } from './geometry';
import type { Frame, PhotoState, Stroke } from './state';

export type OutType = ImageType;

/** Where text, stickers and shapes go on a canvas drawn with `m` (ADR-067). */
export function photoPlace(m: Mat, srcW: number, srcH: number): Place {
  return {
    at: (x, y) => apply(m, x * srcW, y * srcH),
    unit: Math.min(srcW, srcH) * matScale(m),
  };
}

/** Lines drawn on the photo: smooth curves through the points, in photo fractions. */
function drawStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[], place: Place) {
  for (const s of strokes) {
    const pts: Array<[number, number]> = [];
    for (let i = 0; i + 1 < s.points.length; i += 2)
      pts.push(place.at(s.points[i]!, s.points[i + 1]!));
    if (!pts.length) continue;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = s.pen === 'neon' ? '#ffffff' : s.color;
    ctx.lineWidth = Math.max(1, s.width * place.unit);
    if (s.pen === 'marker') {
      ctx.globalAlpha = 0.5;
      ctx.globalCompositeOperation = 'multiply';
    }
    if (s.pen === 'neon') {
      ctx.shadowColor = s.color;
      ctx.shadowBlur = ctx.lineWidth * 1.6;
    }
    ctx.beginPath();
    ctx.moveTo(pts[0]![0], pts[0]![1]);
    if (pts.length === 1) ctx.lineTo(pts[0]![0] + 0.01, pts[0]![1]);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i]![0] + pts[i + 1]![0]) / 2;
      const my = (pts[i]![1] + pts[i + 1]![1]) / 2;
      ctx.quadraticCurveTo(pts[i]![0], pts[i]![1], mx, my);
    }
    if (pts.length > 1) ctx.lineTo(pts.at(-1)![0], pts.at(-1)![1]);
    ctx.stroke();
    if (s.pen === 'neon') {
      // A second, thinner pass in the colour itself: the bright core of the tube.
      ctx.shadowBlur = 0;
      ctx.lineWidth *= 0.45;
      ctx.stroke();
    }
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
    st.redact.length ||
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
    // Before the colours, so nothing of what is covered can be brought back by them.
    for (const box of st.redact) {
      const corners = [
        apply(m, box.x * img.width, box.y * img.height),
        apply(m, (box.x + box.w) * img.width, (box.y + box.h) * img.height),
        apply(m, box.x * img.width, (box.y + box.h) * img.height),
        apply(m, (box.x + box.w) * img.width, box.y * img.height),
      ];
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => c[1]);
      redact(
        im,
        { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) },
        box.mode,
        box.strength,
      );
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
  const place = photoPlace(m, img.width, img.height);
  drawStrokes(ctx, st.strokes, place);
  drawDecor(ctx, st.decor, place);
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
