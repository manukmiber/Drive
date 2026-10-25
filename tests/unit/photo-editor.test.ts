// Photo editor maths (ADR-050): colour pipeline and crop/turn/flip geometry.
import { describe, expect, it } from 'vitest';
import { NO_ADJUST, applyPipeline, combined, pipeline } from '../../src/web/editors/photo/adjust';
import {
  fitRatio,
  flipRect,
  outputSize,
  turnOrientation,
  turnRect,
  type Rect,
} from '../../src/web/editors/photo/geometry';

const px = (...rgb: number[]) => new Uint8ClampedArray([...rgb, 255]);

describe('photo colours', () => {
  it('changes nothing by default', () => {
    expect(pipeline(NO_ADJUST, 'none')).toBeNull();
  });

  it('keeps black and white under brightness, and greys stay grey without warmth', () => {
    const p = pipeline({ ...NO_ADJUST, brightness: 50 }, 'none')!;
    const d = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 100, 100, 100, 7]);
    applyPipeline(d, p);
    expect([...d.slice(0, 8)]).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
    expect(d[8]).toBeGreaterThan(100);
    expect(d[8]).toBe(d[9]);
    expect(d[11]).toBe(7); // alpha untouched
  });

  it('black & white has no colour left; warmth tips red over blue', () => {
    const bw = px(200, 40, 90);
    applyPipeline(bw, pipeline(NO_ADJUST, 'bw')!);
    expect(Math.abs(bw[0]! - bw[1]!)).toBeLessThanOrEqual(1);
    expect(Math.abs(bw[1]! - bw[2]!)).toBeLessThanOrEqual(1);
    const warm = px(128, 128, 128);
    applyPipeline(warm, pipeline({ ...NO_ADJUST, warmth: 100 }, 'none')!);
    expect(warm[0]).toBeGreaterThan(warm[2]!);
  });

  it('adds the filter to the sliders, within −100…100', () => {
    expect(combined({ ...NO_ADJUST, saturation: -50 }, 'bw').saturation).toBe(-100);
    expect(combined({ ...NO_ADJUST, warmth: 90 }, 'warm').warmth).toBe(100);
  });
});

describe('photo geometry', () => {
  const r: Rect = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };

  it('turns the crop with the photo, four turns are none', () => {
    const close = (a: Rect, b: Rect) =>
      (['x', 'y', 'w', 'h'] as const).forEach((k) => expect(a[k]).toBeCloseTo(b[k], 9));
    close(turnRect(r, 1), { x: 1 - 0.2 - 0.4, y: 0.1, w: 0.4, h: 0.3 });
    let t = r;
    for (let i = 0; i < 4; i++) t = turnRect(t, 1);
    close(t, r);
    close(turnRect(turnRect(r, 1), -1), r);
  });

  it('flips the crop, and swaps the flips when turning', () => {
    expect(flipRect(r, 'h').x).toBeCloseTo(0.6);
    expect(flipRect(r, 'v').y).toBeCloseTo(0.4);
    expect(turnOrientation({ turn: 270, flipH: true, flipV: false }, 1)).toEqual({
      turn: 0,
      flipH: false,
      flipV: true,
    });
  });

  it('fits a ratio inside the crop, centred', () => {
    // 400×300 photo, whole crop, square → 300×300 in the middle.
    const sq = fitRatio({ x: 0, y: 0, w: 1, h: 1 }, 1, 400, 300);
    expect(sq.w * 400).toBeCloseTo(300);
    expect(sq.h * 300).toBeCloseTo(300);
    expect(sq.x).toBeCloseTo(0.125);
  });

  it('caps the output size', () => {
    expect(outputSize(4000, 3000, 90, { x: 0, y: 0, w: 0.5, h: 1 }, 1)).toEqual({
      w: 1500,
      h: 4000,
    });
    expect(outputSize(4000, 3000, 0, { x: 0, y: 0, w: 1, h: 1 }, 0.5)).toEqual({
      w: 2000,
      h: 1500,
    });
    const big = outputSize(12000, 9000, 0, { x: 0, y: 0, w: 1, h: 1 }, 1);
    expect(big.w * big.h).toBeLessThanOrEqual(16_777_216);
    expect(Math.max(big.w, big.h)).toBeLessThanOrEqual(8192);
  });
});

describe('dragging the crop', () => {
  it('keeps the opposite corner, and the ratio when asked', async () => {
    const { dragCorner } = await import('../../src/web/editors/photo/geometry');
    const start = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
    const free = dragCorner(start, 'se', 0.1, -0.1, null, 400, 300);
    expect(free.x).toBeCloseTo(0.2);
    expect(free.w).toBeCloseTo(0.5);
    expect(free.h).toBeCloseTo(0.3);
    const sq = dragCorner(start, 'nw', -0.1, 0, 1, 400, 300);
    expect(sq.x + sq.w).toBeCloseTo(0.6);
    expect(sq.y + sq.h).toBeCloseTo(0.6);
    expect(sq.w * 400).toBeCloseTo(sq.h * 300); // square in pixels
    const out = dragCorner(start, 'se', 5, 5, 1, 400, 300);
    expect(out.x + out.w).toBeLessThanOrEqual(1 + 1e-9);
    expect(out.y + out.h).toBeLessThanOrEqual(1 + 1e-9);
  });
});
