// Collage layouts (ADR-067): boxes as fractions of the area inside the outer border, for 1 to 9
// photos, and the maths that turns them into pixels with spacing between boxes. No DOM here.

export interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  id: string;
  cells: Cell[];
}

export const MAX_PHOTOS = 9;

/** Rows from top to bottom, each split evenly: [2, 3] is two on top, three below. */
function rows(counts: number[], heights?: number[]): Cell[] {
  const hs = heights ?? counts.map(() => 1 / counts.length);
  let y = 0;
  const out: Cell[] = [];
  counts.forEach((n, r) => {
    for (let i = 0; i < n; i++) out.push({ x: i / n, y, w: 1 / n, h: hs[r]! });
    y += hs[r]!;
  });
  return out;
}

/** Columns from left to right, each split evenly. */
function cols(counts: number[], widths?: number[]): Cell[] {
  return rows(counts, widths).map((c) => ({ x: c.y, y: c.x, w: c.h, h: c.w }));
}

/** One big box on the left (`share` of the width) and the rest stacked on the right. */
function bigLeft(rest: number, share = 2 / 3): Cell[] {
  return [
    { x: 0, y: 0, w: share, h: 1 },
    ...Array.from({ length: rest }, (_, i) => ({
      x: share,
      y: i / rest,
      w: 1 - share,
      h: 1 / rest,
    })),
  ];
}

const flipX = (cells: Cell[]) => cells.map((c) => ({ ...c, x: 1 - c.x - c.w }));
const swapXY = (cells: Cell[]) => cells.map((c) => ({ x: c.y, y: c.x, w: c.h, h: c.w }));

const ALL: Layout[] = [
  { id: '1', cells: rows([1]) },

  { id: '2-cols', cells: cols([1, 1]) },
  { id: '2-rows', cells: rows([1, 1]) },
  { id: '2-big', cells: bigLeft(1) },
  { id: '2-big-top', cells: swapXY(bigLeft(1)) },

  { id: '3-cols', cells: cols([1, 1, 1]) },
  { id: '3-rows', cells: rows([1, 1, 1]) },
  { id: '3-big-left', cells: bigLeft(2, 0.6) },
  { id: '3-big-right', cells: flipX(bigLeft(2, 0.6)) },
  { id: '3-big-top', cells: rows([1, 2], [0.6, 0.4]) },
  { id: '3-big-bottom', cells: rows([2, 1], [0.4, 0.6]) },

  { id: '4-grid', cells: rows([2, 2]) },
  { id: '4-big-left', cells: bigLeft(3) },
  { id: '4-big-top', cells: rows([1, 3], [0.65, 0.35]) },
  { id: '4-cols', cells: cols([1, 1, 1, 1]) },
  { id: '4-rows', cells: rows([1, 1, 1, 1]) },
  { id: '4-mix', cells: rows([1, 2, 1], [0.35, 0.3, 0.35]) },

  { id: '5-2-3', cells: rows([2, 3]) },
  { id: '5-3-2', cells: rows([3, 2]) },
  {
    id: '5-big-left',
    cells: [
      { x: 0, y: 0, w: 0.5, h: 1 },
      ...rows([2, 2]).map((c) => ({ ...c, x: 0.5 + c.x / 2, w: c.w / 2 })),
    ],
  },
  { id: '5-big-top', cells: rows([1, 4], [0.6, 0.4]) },
  { id: '5-cols', cells: cols([2, 1, 2]) },

  { id: '6-2x3', cells: rows([2, 2, 2]) },
  { id: '6-3x2', cells: rows([3, 3]) },
  {
    id: '6-big',
    cells: [
      { x: 0, y: 0, w: 2 / 3, h: 2 / 3 },
      { x: 2 / 3, y: 0, w: 1 / 3, h: 1 / 3 },
      { x: 2 / 3, y: 1 / 3, w: 1 / 3, h: 1 / 3 },
      { x: 0, y: 2 / 3, w: 1 / 3, h: 1 / 3 },
      { x: 1 / 3, y: 2 / 3, w: 1 / 3, h: 1 / 3 },
      { x: 2 / 3, y: 2 / 3, w: 1 / 3, h: 1 / 3 },
    ],
  },
  { id: '6-1-2-3', cells: rows([1, 2, 3], [0.4, 0.3, 0.3]) },

  { id: '7-3-4', cells: rows([3, 4]) },
  {
    id: '7-big-left',
    cells: [
      { x: 0, y: 0, w: 0.5, h: 1 },
      ...rows([2, 2, 2]).map((c) => ({ ...c, x: 0.5 + c.x / 2, w: c.w / 2 })),
    ],
  },
  { id: '7-2-3-2', cells: rows([2, 3, 2]) },

  { id: '8-2x4', cells: rows([2, 2, 2, 2]) },
  { id: '8-4x2', cells: rows([4, 4]) },
  { id: '8-3-2-3', cells: rows([3, 2, 3]) },

  { id: '9-grid', cells: rows([3, 3, 3]) },
  { id: '9-big', cells: [{ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, ...ring()] },
  { id: '9-2-3-4', cells: rows([2, 3, 4]) },
];

/** The eight boxes around a middle box half the size (a frame of photos). */
function ring(): Cell[] {
  const q = 0.25;
  return [
    { x: 0, y: 0, w: q, h: q },
    { x: q, y: 0, w: 0.5, h: q },
    { x: 0.75, y: 0, w: q, h: q },
    { x: 0, y: q, w: q, h: 0.5 },
    { x: 0.75, y: q, w: q, h: 0.5 },
    { x: 0, y: 0.75, w: q, h: q },
    { x: q, y: 0.75, w: 0.5, h: q },
    { x: 0.75, y: 0.75, w: q, h: q },
  ];
}

export function layoutsFor(n: number): Layout[] {
  return ALL.filter((l) => l.cells.length === Math.max(1, Math.min(MAX_PHOTOS, n)));
}

export const layoutById = (id: string): Layout | undefined => ALL.find((l) => l.id === id);

/** A box in pixels. */
export interface PxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The boxes in pixels on a w×h canvas: `margin` around everything and `gap` between boxes (both
 * pixels). Only edges that touch another box give up half the gap.
 */
export function placeCells(
  cells: Cell[],
  w: number,
  h: number,
  gap: number,
  margin: number,
): PxRect[] {
  const iw = Math.max(1, w - 2 * margin);
  const ih = Math.max(1, h - 2 * margin);
  const e = 1e-6;
  return cells.map((c) => {
    const left = c.x > e ? gap / 2 : 0;
    const right = c.x + c.w < 1 - e ? gap / 2 : 0;
    const top = c.y > e ? gap / 2 : 0;
    const bottom = c.y + c.h < 1 - e ? gap / 2 : 0;
    return {
      x: margin + c.x * iw + left,
      y: margin + c.y * ih + top,
      w: Math.max(1, c.w * iw - left - right),
      h: Math.max(1, c.h * ih - top - bottom),
    };
  });
}

/** How a photo sits in its box: covering it, zoomed, and moved by dx, dy (−1…1 of what spills over). */
export interface Framing {
  zoom: number;
  dx: number;
  dy: number;
}

export const FRAMED: Framing = { zoom: 1, dx: 0, dy: 0 };

/** Where to draw an iw×ih photo so it covers `box` with this framing. */
export function coverRect(iw: number, ih: number, box: PxRect, f: Framing): PxRect {
  const s = Math.max(box.w / iw, box.h / ih) * Math.max(1, f.zoom);
  const w = iw * s;
  const h = ih * s;
  const ox = w - box.w;
  const oy = h - box.h;
  return {
    x: box.x - ox / 2 + (Math.max(-1, Math.min(1, f.dx)) * ox) / 2,
    y: box.y - oy / 2 + (Math.max(-1, Math.min(1, f.dy)) * oy) / 2,
    w,
    h,
  };
}
