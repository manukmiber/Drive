// Crop, turn and flip for the photo editor (ADR-050). The crop is a rectangle in fractions of the
// photo as it is turned and flipped now, so turning or flipping moves it along with the picture.

export type Turn = 0 | 90 | 180 | 270;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };

export interface Orientation {
  /** Clockwise. Applied first, then the flips (as seen). */
  turn: Turn;
  flipH: boolean;
  flipV: boolean;
}

/** Size of the photo once turned. */
export function turnedSize(w: number, h: number, turn: Turn): { w: number; h: number } {
  return turn % 180 ? { w: h, h: w } : { w, h };
}

/** The crop after turning the photo 90° clockwise (dir 1) or anticlockwise (−1). */
export function turnRect(r: Rect, dir: 1 | -1): Rect {
  return dir === 1
    ? { x: 1 - r.y - r.h, y: r.x, w: r.h, h: r.w }
    : { x: r.y, y: 1 - r.x - r.w, w: r.h, h: r.w };
}

export function flipRect(r: Rect, axis: 'h' | 'v'): Rect {
  return axis === 'h' ? { ...r, x: 1 - r.x - r.w } : { ...r, y: 1 - r.y - r.h };
}

/**
 * Turning the photo after a flip: a horizontal flip then a quarter turn shows the same as the turn
 * then a vertical flip, so the flags swap.
 */
export function turnOrientation(o: Orientation, dir: 1 | -1): Orientation {
  const turn = ((((o.turn + dir * 90) % 360) + 360) % 360) as Turn;
  return { turn, flipH: o.flipV, flipV: o.flipH };
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Keeps a rectangle inside the photo and at least `min` (fraction) wide and tall. */
export function clampRect(r: Rect, min = 0.02): Rect {
  const w = Math.max(min, Math.min(1, r.w));
  const h = Math.max(min, Math.min(1, r.h));
  return { x: clamp01(Math.min(r.x, 1 - w)), y: clamp01(Math.min(r.y, 1 - h)), w, h };
}

/**
 * The biggest rectangle with `ratio` (width ÷ height, in pixels) inside `r`, centred on it. The photo
 * is `pw` × `ph` pixels as shown.
 */
export function fitRatio(r: Rect, ratio: number, pw: number, ph: number): Rect {
  const wPx = r.w * pw;
  const hPx = r.h * ph;
  let w = wPx;
  let h = wPx / ratio;
  if (h > hPx) {
    h = hPx;
    w = hPx * ratio;
  }
  const nw = w / pw;
  const nh = h / ph;
  return clampRect({ x: r.x + (r.w - nw) / 2, y: r.y + (r.h - nh) / 2, w: nw, h: nh });
}

/** Output size in pixels: the crop of the turned photo, then scaled; long side at most `maxSide`. */
export function outputSize(
  srcW: number,
  srcH: number,
  turn: Turn,
  crop: Rect,
  scale: number,
  maxSide = 8192,
  maxArea = 16_777_216,
): { w: number; h: number } {
  const t = turnedSize(srcW, srcH, turn);
  let w = t.w * crop.w * scale;
  let h = t.h * crop.h * scale;
  const s = Math.min(1, maxSide / Math.max(w, h), Math.sqrt(maxArea / (w * h)));
  // Rounded down after a cap, so the cap holds.
  w = Math.max(1, s < 1 ? Math.floor(w * s) : Math.round(w));
  h = Math.max(1, s < 1 ? Math.floor(h * s) : Math.round(h));
  return { w, h };
}

export type Corner = 'nw' | 'ne' | 'sw' | 'se';

/**
 * Dragging a corner of the crop by (dx, dy) fractions; the opposite corner stays. With `ratio`
 * (width ÷ height in pixels of the `pw` × `ph` photo) the crop keeps that shape.
 */
export function dragCorner(
  start: Rect,
  corner: Corner,
  dx: number,
  dy: number,
  ratio: number | null,
  pw: number,
  ph: number,
  min = 0.05,
): Rect {
  const west = corner === 'nw' || corner === 'sw';
  const north = corner === 'nw' || corner === 'ne';
  const ax = west ? start.x + start.w : start.x;
  const ay = north ? start.y + start.h : start.y;
  const mx = clamp01((west ? start.x : start.x + start.w) + dx);
  const my = clamp01((north ? start.y : start.y + start.h) + dy);
  let w = Math.abs(mx - ax);
  let h = Math.abs(my - ay);
  const maxW = west ? ax : 1 - ax;
  const maxH = north ? ay : 1 - ay;
  if (ratio) {
    // Follow whichever way the corner moved most, then fit the room there is.
    const k = (ratio * ph) / pw; // w = h × k
    w = Math.max(w, h * k);
    h = w / k;
    const fit = Math.min(1, maxW / w, maxH / h);
    w *= fit;
    h *= fit;
    if (w < min || h < min) {
      const grow = Math.max(min / w, min / h);
      w *= grow;
      h *= grow;
    }
  } else {
    w = Math.max(min, Math.min(maxW, w));
    h = Math.max(min, Math.min(maxH, h));
  }
  return { x: west ? ax - w : ax, y: north ? ay - h : ay, w, h };
}
