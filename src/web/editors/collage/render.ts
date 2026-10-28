// Drawing a collage (ADR-067): background, each photo clipped to its (rounded) box, then text and
// stickers. The same code for the preview and the saved picture.
import { drawDecor, framePlace } from '../decor/draw';
import type { DecorItem } from '../decor/items';
import { FRAMED, coverRect, layoutById, placeCells, type Framing, type PxRect } from './layouts';

export interface Background {
  colour: string;
  /** Top-left to bottom-right; null for a plain colour. */
  gradient: [string, string] | null;
}

export interface CollageState {
  layout: string;
  /** Width over height. */
  ratio: number;
  /** 0…100 each. */
  spacing: number;
  margin: number;
  radius: number;
  background: Background;
  /** Which photo is in each box, by index into the photos. */
  order: number[];
  /** Per photo index. */
  framing: Record<number, Framing>;
  decor: DecorItem[];
}

export const RATIOS: Array<[string, number]> = [
  ['1:1', 1],
  ['4:5', 4 / 5],
  ['3:4', 3 / 4],
  ['2:3', 2 / 3],
  ['9:16', 9 / 16],
  ['16:9', 16 / 9],
  ['4:3', 4 / 3],
  ['3:2', 3 / 2],
];

export const GRADIENTS: Array<[string, string]> = [
  ['#fde68a', '#f472b6'],
  ['#a5f3fc', '#6366f1'],
  ['#bbf7d0', '#14b8a6'],
  ['#fecaca', '#f97316'],
  ['#e9d5ff', '#0ea5e9'],
  ['#1e293b', '#7c3aed'],
];

export const BACKGROUNDS = [
  '#ffffff',
  '#111111',
  '#f5efe0',
  '#fce7f3',
  '#dbeafe',
  '#dcfce7',
  '#fef9c3',
];

/** Pixels for the spacing, border and corners on a w×h canvas. */
export function sizes(s: CollageState, w: number, h: number) {
  const short = Math.min(w, h);
  return {
    gap: (s.spacing / 100) * short * 0.06,
    margin: (s.margin / 100) * short * 0.08,
  };
}

export function cellRects(s: CollageState, w: number, h: number): PxRect[] {
  const layout = layoutById(s.layout);
  if (!layout) return [];
  const { gap, margin } = sizes(s, w, h);
  return placeCells(layout.cells, w, h, gap, margin);
}

export function drawCollage(
  canvas: HTMLCanvasElement,
  s: CollageState,
  photos: ReadonlyArray<ImageBitmap | null>,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width: W, height: H } = canvas;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (s.background.gradient) {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, s.background.gradient[0]);
    g.addColorStop(1, s.background.gradient[1]);
    ctx.fillStyle = g;
  } else ctx.fillStyle = s.background.colour;
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingQuality = 'high';
  cellRects(s, W, H).forEach((box, i) => {
    const idx = s.order[i];
    const img = idx == null ? null : photos[idx];
    const r = (s.radius / 100) * Math.min(box.w, box.h) * 0.5;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(box.x, box.y, box.w, box.h, r);
    ctx.clip();
    if (img) {
      const d = coverRect(img.width, img.height, box, s.framing[idx!] ?? FRAMED);
      ctx.drawImage(img, d.x, d.y, d.w, d.h);
    } else {
      ctx.fillStyle = 'rgba(127,127,127,0.25)';
      ctx.fillRect(box.x, box.y, box.w, box.h);
    }
    ctx.restore();
  });
  ctx.restore();
  drawDecor(ctx, s.decor, framePlace(W, H));
}
