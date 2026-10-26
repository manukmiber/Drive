// Photo editor maths (ADR-050, ADR-052): colours, curves, looks, effects and the geometry.
import { describe, expect, it } from 'vitest';
import {
  LINEAR,
  NO_CURVES,
  NO_TUNE,
  applyPipeline,
  autoTune,
  autoWhiteBalance,
  curveLut,
  pipeline,
  resolve,
  type Colour,
} from '../../src/web/editors/photo/adjust';
import {
  NO_LENS,
  NO_VIGNETTE,
  blurred,
  grain,
  heal,
  lensWeight,
  sharpen,
  structure,
  vignette,
  type Img,
} from '../../src/web/editors/photo/effects';
import {
  apply,
  coverScale,
  fitRatio,
  flipRect,
  invert,
  outputSize,
  photoMatrix,
  turnOrientation,
  turnRect,
  type Rect,
} from '../../src/web/editors/photo/geometry';
import { START } from '../../src/web/editors/photo/state';

const px = (...rgb: number[]) => new Uint8ClampedArray([...rgb, 255]);
const colour = (p: Partial<Colour> = {}): Colour => ({ ...START, ...p });
const run = (d: Uint8ClampedArray, c: Colour) => {
  const p = pipeline(resolve(c));
  if (p) applyPipeline(d, p);
  return d;
};

/** A w × h picture of one colour. */
function flat(w: number, h: number, v = 128): Img {
  const data = new Uint8ClampedArray(w * h * 4).fill(v);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { data, width: w, height: h };
}
const at = (img: Img, x: number, y: number) => img.data[(y * img.width + x) * 4]!;

describe('photo colours', () => {
  it('changes nothing by default', () => {
    expect(pipeline(resolve(START))).toBeNull();
  });

  it('keeps black and white under brightness, and greys stay grey without warmth', () => {
    const d = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 100, 100, 100, 7]);
    run(d, colour({ tune: { ...NO_TUNE, brightness: 50 } }));
    expect([...d.slice(0, 8)]).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
    expect(d[8]).toBeGreaterThan(100);
    expect(d[8]).toBe(d[9]);
    expect(d[11]).toBe(7); // alpha untouched
  });

  it('lifts shadows and pulls highlights down, leaving the ends', () => {
    const d = new Uint8ClampedArray([60, 60, 60, 255, 200, 200, 200, 255, 0, 0, 0, 255]);
    run(d, colour({ tune: { ...NO_TUNE, shadows: 80, highlights: -80 } }));
    expect(d[0]).toBeGreaterThan(60);
    expect(d[4]).toBeLessThan(200);
    expect(d[8]).toBe(0);
  });

  it('black & white has no colour left; warmth and temperature tip red over blue', () => {
    const bw = run(px(200, 40, 90), colour({ look: { id: 'bw', amount: 100 } }));
    expect(Math.abs(bw[0]! - bw[1]!)).toBeLessThanOrEqual(1);
    expect(Math.abs(bw[1]! - bw[2]!)).toBeLessThanOrEqual(1);
    const warm = run(px(128, 128, 128), colour({ tune: { ...NO_TUNE, warmth: 100 } }));
    expect(warm[0]).toBeGreaterThan(warm[2]!);
    const hot = run(px(128, 128, 128), colour({ wb: { temperature: 60, tint: 0 } }));
    expect(hot[0]).toBeGreaterThan(hot[2]!);
    const magenta = run(px(128, 128, 128), colour({ wb: { temperature: 0, tint: 60 } }));
    expect(magenta[1]).toBeLessThan(128);
  });

  it('a look at strength 0 is no look; it adds to the sliders within −100…100', () => {
    expect(pipeline(resolve(colour({ look: { id: 'drama', amount: 0 } })))).toBeNull();
    const r = resolve(
      colour({ tune: { ...NO_TUNE, saturation: -50 }, look: { id: 'bw', amount: 100 } }),
    );
    expect(r.tune.saturation).toBe(-100);
    expect(resolve(colour({ look: { id: 'drama', amount: 50 } })).detail.structure).toBe(30);
  });

  it('draws curves through their points, smoothly and without overshoot', () => {
    const id = curveLut(LINEAR);
    expect([id[0], id[128], id[255]]).toEqual([0, 128, 255]);
    const up = curveLut([
      [0, 0],
      [0.5, 0.75],
      [1, 1],
    ]);
    expect(up[128]! / 255).toBeCloseTo(0.75, 1);
    for (let v = 1; v < 256; v++) expect(up[v]!).toBeGreaterThanOrEqual(up[v - 1]!);
    expect(Math.max(...up)).toBeLessThanOrEqual(255);
    const d = run(
      px(128, 128, 128),
      colour({
        curves: {
          ...NO_CURVES,
          r: [
            [0, 0],
            [0.5, 0.75],
            [1, 1],
          ],
        },
      }),
    );
    expect(d[0]).toBeGreaterThan(170);
    expect(d[1]).toBe(128);
  });

  it('auto makes a dark photo brighter, and a blue one warmer', () => {
    const dark = flat(20, 20, 40).data;
    expect(autoTune(dark).brightness).toBeGreaterThan(0);
    const blue = flat(20, 20, 0).data;
    for (let i = 0; i < blue.length; i += 4) {
      blue[i] = 90;
      blue[i + 1] = 110;
      blue[i + 2] = 170;
    }
    expect(autoWhiteBalance(blue).temperature).toBeGreaterThan(0);
  });
});

describe('photo effects', () => {
  it('a blur leaves a flat picture flat, and spreads a bright point', () => {
    const img = flat(40, 30);
    expect(blurred(img, 6).every((v, i) => v === img.data[i])).toBe(true);
    const dot = flat(41, 41, 0);
    dot.data.set([255, 255, 255], (20 * 41 + 20) * 4);
    const soft = blurred(dot, 2);
    expect(soft[(20 * 41 + 20) * 4]!).toBeLessThan(255);
    expect(soft[(20 * 41 + 22) * 4]!).toBeGreaterThan(0);
  });

  it('structure and sharpening change edges, not flat areas', () => {
    const img = flat(30, 30);
    structure(img, blurred(img, 3), 80);
    sharpen(img, 80);
    expect(img.data.every((v, i) => (i % 4 === 3 ? v === 255 : v === 128))).toBe(true);
    const edge = flat(30, 30, 100);
    for (let y = 0; y < 30; y++)
      for (let x = 15; x < 30; x++) edge.data.fill(160, (y * 30 + x) * 4, (y * 30 + x) * 4 + 3);
    sharpen(edge, 100);
    expect(at(edge, 14, 15)).toBeLessThan(100);
    expect(at(edge, 15, 15)).toBeGreaterThan(160);
  });

  it('a vignette darkens the corners and leaves the middle', () => {
    const img = flat(60, 40, 200);
    vignette(img, { ...NO_VIGNETTE, amount: 80 });
    expect(at(img, 30, 20)).toBe(200);
    expect(at(img, 0, 0)).toBeLessThan(120);
  });

  it('grain is the same every time and keeps the brightness', () => {
    const a = flat(50, 50);
    const b = flat(50, 50);
    grain(a, 60);
    grain(b, 60);
    expect(a.data).toEqual(b.data);
    let sum = 0;
    for (let i = 0; i < a.data.length; i += 4) sum += a.data[i]!;
    expect(sum / 2500).toBeCloseTo(128, -1);
  });

  it('heals a spot with what is around it', () => {
    const img = flat(80, 80, 150);
    for (let y = 36; y < 44; y++)
      for (let x = 36; x < 44; x++) img.data.fill(10, (y * 80 + x) * 4, (y * 80 + x) * 4 + 3);
    heal(img, 40, 40, 6);
    expect(Math.abs(at(img, 40, 40) - 150)).toBeLessThan(6);
    expect(at(img, 5, 5)).toBe(150);
  });

  it('the lens blur is sharp in the middle and blurred far from it', () => {
    const lens = { ...NO_LENS, shape: 'radial' as const };
    expect(lensWeight(lens, 0.5, 0.5, 400, 300)).toBe(0);
    expect(lensWeight(lens, 0, 0, 400, 300)).toBe(1);
    const band = { ...NO_LENS, shape: 'linear' as const };
    expect(lensWeight(band, 0, 0.5, 400, 300)).toBe(0); // along the band
    expect(lensWeight(band, 0.5, 0, 400, 300)).toBeGreaterThan(0.5);
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

describe('photo matrix', () => {
  const close = (a: readonly number[], b: readonly number[]) =>
    a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 6));

  it('maps the photo onto the canvas: corners, turns, and back again', () => {
    const plain = photoMatrix(400, 300, START.o, 0, { x: 0, y: 0, w: 1, h: 1 }, 200, 150);
    close(apply(plain, 400, 300), [200, 150]);
    const turned = photoMatrix(
      400,
      300,
      { turn: 90, flipH: false, flipV: false },
      0,
      { x: 0, y: 0, w: 1, h: 1 },
      300,
      400,
    );
    // A quarter turn clockwise: the top-left corner goes to the top-right.
    close(apply(turned, 0, 0), [300, 0]);
    const crop = photoMatrix(400, 300, START.o, 0, { x: 0.5, y: 0, w: 0.5, h: 1 }, 200, 300);
    close(apply(crop, 200, 0), [0, 0]);
    close(apply(invert(crop), ...apply(crop, 123, 45)), [123, 45]);
  });

  it('straightening grows the photo just enough to fill its frame', () => {
    expect(coverScale(400, 300, 0)).toBe(1);
    const m = photoMatrix(400, 300, START.o, 12, { x: 0, y: 0, w: 1, h: 1 }, 400, 300);
    const back = invert(m);
    for (const [x, y] of [
      [0, 0],
      [400, 0],
      [0, 300],
      [400, 300],
    ] as const) {
      const [u, v] = apply(back, x, y);
      expect(u).toBeGreaterThanOrEqual(-1e-6);
      expect(v).toBeGreaterThanOrEqual(-1e-6);
      expect(u).toBeLessThanOrEqual(400 + 1e-6);
      expect(v).toBeLessThanOrEqual(300 + 1e-6);
    }
  });
});
