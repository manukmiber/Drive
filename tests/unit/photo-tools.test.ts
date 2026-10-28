// The photo editor's newer tools (ADR-067): colour grading wheels, selective colour, covering
// boxes, and the decoration data shared with the collage and the video editor.
import { describe, expect, it } from 'vitest';
import {
  bringForward,
  graphemes,
  makeItem,
  snapAngle,
  STICKERS,
} from '../../src/web/editors/decor/items';
import {
  NO_GRADE,
  NO_HSL,
  applyPipeline,
  gradeChannel,
  pipeline,
  resolve,
  wheelRgb,
  type Colour,
} from '../../src/web/editors/photo/adjust';
import { redact, type Img } from '../../src/web/editors/photo/effects';
import { START } from '../../src/web/editors/photo/state';

const colour = (p: Partial<Colour> = {}): Colour => ({ ...START, ...p });
const run = (rgb: number[], c: Colour) => {
  const d = new Uint8ClampedArray([...rgb, 255]);
  const p = pipeline(resolve(c));
  if (p) applyPipeline(d, p);
  return [d[0]!, d[1]!, d[2]!];
};

describe('colour wheels', () => {
  it('a wheel pushes towards its colour, adding up to nothing', () => {
    const [r, g, b] = wheelRgb({ hue: 240, amount: 100, lum: 0 });
    expect(b).toBeCloseTo(1, 5);
    expect(r + g + b).toBeCloseTo(0, 5);
    expect(wheelRgb({ hue: 0, amount: 0, lum: 50 })).toEqual([0, 0, 0]);
  });

  it('no grade is no change', () => {
    expect(pipeline(resolve(colour({ grade: NO_GRADE })))).toBeNull();
    for (const x of [0, 0.3, 1]) expect(gradeChannel(x, 0, NO_GRADE)).toBeCloseTo(x, 6);
  });

  it('blue shadows tint the darks more than the lights', () => {
    const c = colour({ grade: { ...NO_GRADE, shadows: { hue: 240, amount: 80, lum: 0 } } });
    const dark = run([30, 30, 30], c);
    const light = run([230, 230, 230], c);
    expect(dark[2]! - dark[0]!).toBeGreaterThan(light[2]! - light[0]!);
    expect(dark[2]).toBeGreaterThan(30);
  });

  it('lighter midtones lift the grey and leave black and white', () => {
    const c = colour({ grade: { ...NO_GRADE, midtones: { hue: 0, amount: 0, lum: 50 } } });
    expect(run([128, 128, 128], c)[0]).toBeGreaterThan(140);
    expect(run([0, 0, 0], c)).toEqual([0, 0, 0]);
    expect(run([255, 255, 255], c)).toEqual([255, 255, 255]);
  });
});

describe('selective colour', () => {
  const hsl = (band: keyof typeof NO_HSL, v: { h?: number; s?: number; l?: number }) => ({
    ...NO_HSL,
    [band]: { h: 0, s: 0, l: 0, ...v },
  });

  it('takes the colour out of reds only; greys and blues stay', () => {
    const c = colour({ hsl: hsl('red', { s: -100 }) });
    const red = run([200, 40, 40], c);
    expect(Math.max(...red) - Math.min(...red)).toBeLessThan(20);
    expect(run([120, 120, 120], c)).toEqual([120, 120, 120]);
    const blue = run([40, 60, 200], c);
    expect(blue[2]! - blue[0]!).toBeGreaterThan(150);
  });

  it("turning red's hue moves it towards orange", () => {
    const c = colour({ hsl: hsl('red', { h: 100 }) });
    const [r, g] = run([200, 30, 30], c);
    expect(g).toBeGreaterThan(50);
    expect(r).toBeGreaterThan(150);
  });
});

describe('covering a box', () => {
  function noisy(w: number, h: number): Img {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = data[i + 1] = data[i + 2] = (i * 37) % 256;
      data[i + 3] = 255;
    }
    return { data, width: w, height: h };
  }
  const px = (img: Img, x: number, y: number) => img.data[(y * img.width + x) * 4]!;

  it('black is black inside, untouched outside', () => {
    const img = noisy(40, 40);
    const before = px(img, 0, 0);
    redact(img, { x0: 10, y0: 10, x1: 30, y1: 30 }, 'black', 50);
    expect(px(img, 15, 15)).toBe(0);
    expect(px(img, 0, 0)).toBe(before);
  });

  it('pixelate makes blocks of one colour', () => {
    const img = noisy(60, 60);
    redact(img, { x0: 0, y0: 0, x1: 60, y1: 60 }, 'pixelate', 100);
    expect(px(img, 1, 1)).toBe(px(img, 2, 3));
    expect(px(img, 0, 0)).toBe(px(img, 4, 4));
  });

  it('blur evens the box out', () => {
    const img = noisy(60, 60);
    const spread = () => {
      const v = [];
      for (let x = 20; x < 40; x++) v.push(px(img, x, 30));
      return Math.max(...v) - Math.min(...v);
    };
    const before = spread();
    redact(img, { x0: 10, y0: 10, x1: 50, y1: 50 }, 'blur', 80);
    expect(spread()).toBeLessThan(before / 3);
  });
});

describe('decorations', () => {
  it("new items start in the middle with their kind's size", () => {
    expect(makeItem('a', 'text')).toMatchObject({
      kind: 'text',
      x: 0.5,
      y: 0.5,
      size: 0.08,
      font: 'sans',
    });
    expect(makeItem('b', 'sticker', { emoji: '🎉' })).toMatchObject({ emoji: '🎉', size: 0.2 });
    expect(makeItem('c', 'shape', { shape: 'star' })).toMatchObject({ shape: 'star', fill: true });
  });

  it('moves an item up or down the pile, not past the ends', () => {
    const items = ['a', 'b', 'c'].map((id) => makeItem(id, 'sticker'));
    expect(bringForward(items, 'a', 1).map((i) => i.id)).toEqual(['b', 'a', 'c']);
    expect(bringForward(items, 'c', 1)).toBe(items);
    expect(bringForward(items, 'a', -1)).toBe(items);
  });

  it('snaps turns near right angles', () => {
    expect(snapAngle(2)).toBe(0);
    expect(snapAngle(88)).toBe(90);
    expect(snapAngle(-93)).toBe(-90);
    expect(snapAngle(181)).toBe(180);
    expect(snapAngle(45)).toBe(45);
    expect(snapAngle(370)).toBe(10);
    expect(snapAngle(362)).toBe(0);
  });

  it('keeps emoji whole', () => {
    expect(graphemes('❤️✌️🏍️')).toEqual(['❤️', '✌️', '🏍️']);
    for (const list of Object.values(STICKERS))
      for (const e of list) expect(e.length).toBeGreaterThan(0);
    expect(STICKERS.love).toContain('❤️');
  });
});
