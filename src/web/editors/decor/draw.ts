// Drawing text, stickers and shapes (ADR-067) on a 2D canvas: the same code for what is shown and
// what is saved. Where an item goes comes from a Place, so the photo editor (whose items sit on the
// photo before crop and turn), the collage and the video (whose items sit on the output) share it.
import {
  FONT_STACK,
  type DecorItem,
  type ShapeId,
  type ShapeItem,
  type StickerItem,
  type TextItem,
} from './items';

export interface Place {
  /** An item's middle (fractions of its picture) → canvas pixels. */
  at(x: number, y: number): [number, number];
  /** Canvas pixels per size 1 (one short side of the picture). */
  unit: number;
}

/** Items that belong to the whole canvas. */
export const framePlace = (w: number, h: number): Place => ({
  at: (x, y) => [x * w, y * h],
  unit: Math.min(w, h),
});

/** Changes over time (the video's animations): all optional. */
export interface Anim {
  alpha?: number;
  scale?: number;
  /** Canvas pixels. */
  dx?: number;
  dy?: number;
  /** 0…1 of the text written so far. */
  reveal?: number;
}

/** An item's box on the canvas: middle, size and turn. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  angle: number;
}

const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';

let measurer: CanvasRenderingContext2D | null = null;
function measure(font: string, s: string): number {
  measurer ??= document.createElement('canvas').getContext('2d');
  if (!measurer) return s.length * 10;
  measurer.font = font;
  return measurer.measureText(s).width;
}

/** Black or white, whichever reads on `hex`. */
export function onColour(hex: string): string {
  const n = parseInt(hex.slice(1, 7), 16);
  const lum = 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  return lum > 150 ? '#111111' : '#ffffff';
}

function textMetrics(t: TextItem, px: number) {
  const weight = t.style === 'plain' ? 500 : t.font === 'display' ? 400 : 800;
  const font = `${weight} ${px}px ${FONT_STACK[t.font]}`;
  const lines = (t.text || ' ').split('\n');
  const widths = lines.map((l) => measure(font, l));
  const pad = t.style === 'box' ? px * 0.45 : px * 0.15;
  const lh = px * 1.2;
  return {
    font,
    lines,
    widths,
    pad,
    lh,
    w: Math.max(px * 0.5, ...widths) + pad * 2,
    h: lines.length * lh + pad * (t.style === 'box' ? 1.2 : 0.6),
  };
}

export function boxOf(item: DecorItem, place: Place): Box {
  const [x, y] = place.at(item.x, item.y);
  const px = Math.max(1, item.size * place.unit);
  if (item.kind === 'text') {
    const m = textMetrics(item, px);
    return { x, y, w: m.w, h: m.h, angle: item.rotation };
  }
  if (item.kind === 'sticker') return { x, y, w: px * 1.15, h: px * 1.15, angle: item.rotation };
  return { x, y, w: px * item.aspect, h: px, angle: item.rotation };
}

/** The shape's outline, centred on 0,0. */
export function shapePath(shape: ShapeId, w: number, h: number): Path2D {
  const p = new Path2D();
  const hw = w / 2;
  const hh = h / 2;
  const star = (points: number, inner: number) => {
    for (let i = 0; i < points * 2; i++) {
      const a = (i * Math.PI) / points - Math.PI / 2;
      const k = i % 2 ? inner : 1;
      const px = Math.cos(a) * hw * k;
      const py = Math.sin(a) * hh * k;
      if (i) p.lineTo(px, py);
      else p.moveTo(px, py);
    }
    p.closePath();
  };
  switch (shape) {
    case 'rect':
      p.rect(-hw, -hh, w, h);
      break;
    case 'round':
      p.roundRect(-hw, -hh, w, h, Math.min(w, h) * 0.2);
      break;
    case 'circle':
      p.ellipse(0, 0, hw, hh, 0, 0, Math.PI * 2);
      break;
    case 'triangle':
      p.moveTo(0, -hh);
      p.lineTo(hw, hh);
      p.lineTo(-hw, hh);
      p.closePath();
      break;
    case 'star':
      star(5, 0.45);
      break;
    case 'burst':
      star(12, 0.72);
      break;
    case 'heart': {
      const X = (v: number) => v * w;
      const Y = (v: number) => v * h;
      p.moveTo(0, Y(0.45));
      p.bezierCurveTo(X(-0.6), Y(0.05), X(-0.52), Y(-0.45), X(-0.25), Y(-0.47));
      p.bezierCurveTo(X(-0.1), Y(-0.48), 0, Y(-0.37), 0, Y(-0.26));
      p.bezierCurveTo(0, Y(-0.37), X(0.1), Y(-0.48), X(0.25), Y(-0.47));
      p.bezierCurveTo(X(0.52), Y(-0.45), X(0.6), Y(0.05), 0, Y(0.45));
      p.closePath();
      break;
    }
    case 'arrow': {
      const t = h * 0.18;
      const head = Math.min(w * 0.45, h * 0.9);
      p.moveTo(-hw, -t);
      p.lineTo(hw - head, -t);
      p.lineTo(hw - head, -hh);
      p.lineTo(hw, 0);
      p.lineTo(hw - head, hh);
      p.lineTo(hw - head, t);
      p.lineTo(-hw, t);
      p.closePath();
      break;
    }
    case 'line':
      p.moveTo(-hw, 0);
      p.lineTo(hw, 0);
      break;
    case 'bubble': {
      const body = h * 0.8;
      p.roundRect(-hw, -hh, w, body, Math.min(w, body) * 0.3);
      p.moveTo(-w * 0.22, -hh + body - 1);
      p.lineTo(-w * 0.3, hh);
      p.lineTo(-w * 0.05, -hh + body - 1);
      p.closePath();
      break;
    }
  }
  return p;
}

function drawText(ctx: CanvasRenderingContext2D, t: TextItem, px: number, reveal: number) {
  const m = textMetrics(t, px);
  let left = Math.round(reveal * [...t.text].length);
  const lines = m.lines.map((l) => {
    const chars = [...l];
    const shown = chars.slice(0, Math.max(0, left)).join('');
    left -= chars.length + 1;
    return shown;
  });
  ctx.font = m.font;
  ctx.textBaseline = 'middle';
  ctx.textAlign = t.align;
  const x = t.align === 'left' ? -m.w / 2 + m.pad : t.align === 'right' ? m.w / 2 - m.pad : 0;
  const top = -(m.lines.length * m.lh) / 2 + m.lh / 2;
  const each = (fn: (line: string, y: number) => void) =>
    lines.forEach((line, i) => line && fn(line, top + i * m.lh));
  let ink = t.color;
  switch (t.style) {
    case 'box':
      ctx.fillStyle = t.color;
      ctx.beginPath();
      ctx.roundRect(-m.w / 2, -m.h / 2, m.w, m.h, px * 0.3);
      ctx.fill();
      ink = onColour(t.color);
      break;
    case 'outline':
      ctx.lineWidth = px * 0.14;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = onColour(t.color);
      each((line, y) => ctx.strokeText(line, x, y));
      break;
    case 'shadow':
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowOffsetX = px * 0.06;
      ctx.shadowOffsetY = px * 0.06;
      break;
    case 'neon':
      ctx.shadowColor = t.color;
      ctx.shadowBlur = px * 0.45;
      ctx.fillStyle = t.color;
      each((line, y) => ctx.fillText(line, x, y));
      ink = '#ffffff';
      ctx.shadowBlur = px * 0.15;
      break;
    default:
      ctx.shadowColor = 'rgba(0,0,0,0.35)';
      ctx.shadowBlur = px * 0.12;
  }
  ctx.fillStyle = ink;
  each((line, y) => ctx.fillText(line, x, y));
}

function drawSticker(ctx: CanvasRenderingContext2D, s: StickerItem, px: number) {
  ctx.font = `${px}px ${EMOJI_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Emoji sit a little high in their line box.
  ctx.fillText(s.emoji, 0, px * 0.06);
}

function drawShape(ctx: CanvasRenderingContext2D, s: ShapeItem, px: number) {
  const w = px * s.aspect;
  const path = shapePath(s.shape, w, px);
  ctx.fillStyle = ctx.strokeStyle = s.color;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (s.shape === 'line') {
    ctx.lineWidth = Math.max(1, s.line * px * 2);
    ctx.stroke(path);
  } else if (s.fill) ctx.fill(path);
  else {
    ctx.lineWidth = Math.max(1, s.line * px);
    ctx.stroke(path);
  }
}

/** Draws `item` at its place, with `anim` on top. */
export function drawItem(
  ctx: CanvasRenderingContext2D,
  item: DecorItem,
  place: Place,
  anim: Anim = {},
): void {
  const alpha = item.opacity * (anim.alpha ?? 1);
  if (alpha <= 0) return;
  if (item.kind === 'text' && !item.text.trim()) return;
  const [x, y] = place.at(item.x, item.y);
  const px = Math.max(1, item.size * place.unit);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = alpha;
  ctx.translate(x + (anim.dx ?? 0), y + (anim.dy ?? 0));
  ctx.rotate((item.rotation * Math.PI) / 180);
  const k = anim.scale ?? 1;
  if (k !== 1) ctx.scale(k, k);
  if (item.kind === 'text') drawText(ctx, item, px, anim.reveal ?? 1);
  else if (item.kind === 'sticker') drawSticker(ctx, item, px);
  else drawShape(ctx, item, px);
  ctx.restore();
}

/** Draws every item in order (later ones on top); `anim` null hides an item. */
export function drawDecor(
  ctx: CanvasRenderingContext2D,
  items: readonly DecorItem[],
  place: Place,
  anim?: (item: DecorItem) => Anim | null,
): void {
  for (const it of items) {
    const a = anim ? anim(it) : {};
    if (a) drawItem(ctx, it, place, a);
  }
}
