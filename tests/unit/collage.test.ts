// Collage layouts (ADR-067): every layout fills its area exactly, spacing sits only between boxes,
// and a photo always covers its box however it is zoomed or moved.
import { describe, expect, it } from 'vitest';
import {
  MAX_PHOTOS,
  coverRect,
  layoutById,
  layoutsFor,
  placeCells,
} from '../../src/web/editors/collage/layouts';

describe('collage layouts', () => {
  it('has layouts for 1 to 9 photos, each with that many boxes', () => {
    for (let n = 1; n <= MAX_PHOTOS; n++) {
      const list = layoutsFor(n);
      expect(list.length).toBeGreaterThan(0);
      for (const l of list) expect(l.cells).toHaveLength(n);
    }
    expect(layoutsFor(0)[0]!.cells).toHaveLength(1);
    expect(layoutsFor(20)[0]!.cells).toHaveLength(MAX_PHOTOS);
  });

  it('every layout covers its area once: inside, no overlaps, nothing left', () => {
    for (let n = 1; n <= MAX_PHOTOS; n++)
      for (const l of layoutsFor(n)) {
        const area = l.cells.reduce((s, c) => s + c.w * c.h, 0);
        expect(area, l.id).toBeCloseTo(1, 6);
        for (const c of l.cells) {
          expect(c.x, l.id).toBeGreaterThanOrEqual(-1e-9);
          expect(c.y, l.id).toBeGreaterThanOrEqual(-1e-9);
          expect(c.x + c.w, l.id).toBeLessThanOrEqual(1 + 1e-9);
          expect(c.y + c.h, l.id).toBeLessThanOrEqual(1 + 1e-9);
        }
        l.cells.forEach((a, i) =>
          l.cells.slice(i + 1).forEach((b) => {
            const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
            const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
            expect(ox > 1e-9 && oy > 1e-9, `${l.id} overlaps`).toBe(false);
          }),
        );
      }
  });

  it('puts the spacing between boxes and the border around them', () => {
    const cells = layoutById('2-cols')!.cells;
    const [a, b] = placeCells(cells, 1000, 500, 20, 30);
    expect(a).toEqual({ x: 30, y: 30, w: 460, h: 440 });
    expect(b!.x - (a!.x + a!.w)).toBeCloseTo(20, 6);
    expect(b!.x + b!.w).toBeCloseTo(970, 6);
  });

  it('a photo always covers its box, zoomed or moved', () => {
    const box = { x: 10, y: 20, w: 300, h: 200 };
    for (const zoom of [1, 2.5])
      for (const dx of [-1, 0, 1])
        for (const dy of [-1, 0.5, 1]) {
          const r = coverRect(4000, 3000, box, { zoom, dx, dy });
          expect(r.x).toBeLessThanOrEqual(box.x + 1e-6);
          expect(r.y).toBeLessThanOrEqual(box.y + 1e-6);
          expect(r.x + r.w).toBeGreaterThanOrEqual(box.x + box.w - 1e-6);
          expect(r.y + r.h).toBeGreaterThanOrEqual(box.y + box.h - 1e-6);
          expect(r.w / r.h).toBeCloseTo(4 / 3, 6);
        }
    // Moved all the way right: the photo's left edge meets the box's.
    expect(coverRect(400, 400, box, { zoom: 1, dx: 1, dy: 0 }).x).toBeCloseTo(box.x, 6);
  });
});
