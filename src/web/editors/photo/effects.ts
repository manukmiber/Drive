// Pixel effects for the photo editor (ADR-052): structure, sharpening, glow, lens blur, vignette,
// grain and healing. Plain arrays, no DOM, so all of it runs (and is tested) without a canvas. Sizes
// are fractions of the picture, so the preview (a smaller copy) looks like the saved photo.

export interface Img {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** One box-blur pass of radius `r` along rows (or columns), RGB only; alpha is copied. */
function boxPass(
  src: Uint8ClampedArray,
  dst: Uint8ClampedArray,
  w: number,
  h: number,
  r: number,
  rows: boolean,
) {
  const len = rows ? w : h;
  const lines = rows ? h : w;
  const step = rows ? 4 : w * 4;
  const div = 2 * r + 1;
  for (let line = 0; line < lines; line++) {
    const base = rows ? line * w * 4 : line * 4;
    for (let c = 0; c < 4; c++) {
      if (c === 3) {
        for (let i = 0; i < len; i++) dst[base + i * step + 3] = src[base + i * step + 3]!;
        continue;
      }
      // Edges repeat the first and last pixel.
      let sum = src[base + c]! * (r + 1);
      for (let i = 1; i <= r; i++) sum += src[base + Math.min(len - 1, i) * step + c]!;
      for (let i = 0; i < len; i++) {
        dst[base + i * step + c] = sum / div;
        const add = Math.min(len - 1, i + r + 1);
        const drop = Math.max(0, i - r);
        sum += src[base + add * step + c]! - src[base + drop * step + c]!;
      }
    }
  }
}

/** Three box blurs, close to a Gaussian of `sigma` pixels. */
export function boxBlur(img: Img, sigma: number): Uint8ClampedArray {
  const { width: w, height: h } = img;
  const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
  const a = img.data.slice();
  const b = new Uint8ClampedArray(a.length);
  for (let pass = 0; pass < 3; pass++) {
    boxPass(a, b, w, h, r, true);
    boxPass(b, a, w, h, r, false);
  }
  return a;
}

/** A blurred copy, the full size. Big blurs are made on a smaller copy and scaled back up. */
export function blurred(img: Img, sigma: number): Uint8ClampedArray {
  const { width: w, height: h } = img;
  const k = Math.max(1, Math.floor(sigma / 3));
  if (k === 1) return boxBlur(img, sigma);
  const sw = Math.ceil(w / k);
  const sh = Math.ceil(h / k);
  const small = new Uint8ClampedArray(sw * sh * 4);
  for (let y = 0; y < sh; y++)
    for (let x = 0; x < sw; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let yy = y * k; yy < Math.min(h, y * k + k); yy++)
        for (let xx = x * k; xx < Math.min(w, x * k + k); xx++) {
          const i = (yy * w + xx) * 4;
          r += img.data[i]!;
          g += img.data[i + 1]!;
          b += img.data[i + 2]!;
          a += img.data[i + 3]!;
          n++;
        }
      const o = (y * sw + x) * 4;
      small[o] = r / n;
      small[o + 1] = g / n;
      small[o + 2] = b / n;
      small[o + 3] = a / n;
    }
  const soft = boxBlur({ data: small, width: sw, height: sh }, sigma / k);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) / k - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) / k - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const tx = fx - x0;
      const o = (y * w + x) * 4;
      const i00 = (y0 * sw + x0) * 4;
      const i01 = (y0 * sw + x1) * 4;
      const i10 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      for (let c = 0; c < 4; c++) {
        const top = soft[i00 + c]! + (soft[i01 + c]! - soft[i00 + c]!) * tx;
        const bot = soft[i10 + c]! + (soft[i11 + c]! - soft[i10 + c]!) * tx;
        out[o + c] = top + (bot - top) * ty;
      }
    }
  }
  return out;
}

const lum = (d: Uint8ClampedArray, i: number) =>
  0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;

/** How big the blur behind "structure" is: about 0.4% of the diagonal. */
export const structureSigma = (w: number, h: number) => Math.max(1.5, Math.hypot(w, h) * 0.004);

/**
 * Structure: brightness detail against the blurred copy, made stronger (or, below 0, softer).
 * Mid-tones get most of it, so blacks and whites don't get halos. Colour stays.
 */
export function structure(img: Img, soft: Uint8ClampedArray, amount: number): void {
  const d = img.data;
  const k = (amount / 100) * (amount > 0 ? 2.2 : 0.9);
  for (let i = 0; i < d.length; i += 4) {
    const L = lum(d, i);
    // Big differences (strong edges) are squeezed, so texture grows without halos round edges.
    const raw = L - lum(soft, i);
    const detail = raw / (1 + Math.abs(raw) / 24);
    const mid = 1 - Math.abs(L / 127.5 - 1) ** 2;
    const add = detail * k * (0.35 + 0.65 * mid);
    d[i] = d[i]! + add;
    d[i + 1] = d[i + 1]! + add;
    d[i + 2] = d[i + 2]! + add;
  }
}

/** Sharpening: brightness only (no colour fringes), against its 3×3 neighbours. */
export function sharpen(img: Img, amount: number): void {
  const { data: d, width: w, height: h } = img;
  const L = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) L[p] = lum(d, p * 4);
  const k = (amount / 100) * 1.6;
  for (let y = 0; y < h; y++) {
    const up = Math.max(0, y - 1) * w;
    const down = Math.min(h - 1, y + 1) * w;
    for (let x = 0; x < w; x++) {
      const left = Math.max(0, x - 1);
      const right = Math.min(w - 1, x + 1);
      const p = y * w + x;
      const around =
        (L[up + left]! +
          L[up + x]! +
          L[up + right]! +
          L[y * w + left]! +
          L[y * w + right]! +
          L[down + left]! +
          L[down + x]! +
          L[down + right]!) /
        8;
      const add = (L[p]! - around) * k;
      const i = p * 4;
      d[i] = d[i]! + add;
      d[i + 1] = d[i + 1]! + add;
      d[i + 2] = d[i + 2]! + add;
    }
  }
}

export const glowSigma = (w: number, h: number) => Math.max(2, Math.hypot(w, h) * 0.02);

/** Glow: the blurred copy laid over it as light ("screen"), soft and bright. */
export function glow(img: Img, soft: Uint8ClampedArray, amount: number): void {
  const d = img.data;
  const k = (amount / 100) * 0.75;
  for (let i = 0; i < d.length; i += 4)
    for (let c = 0; c < 3; c++) {
      const a = d[i + c]!;
      const screen = 255 - ((255 - a) * (255 - soft[i + c]!)) / 255;
      d[i + c] = a + (screen - a) * k;
    }
}

export interface LensBlur {
  shape: 'off' | 'radial' | 'linear';
  /** The sharp middle, fractions of the picture. */
  x: number;
  y: number;
  /** 0…100: how big the sharp part is. */
  size: number;
  /** 0…100: how slowly sharp turns blurred. */
  fade: number;
  /** 0…100. */
  strength: number;
  /** Of the sharp band (linear), degrees. */
  angle: number;
}

export const NO_LENS: LensBlur = {
  shape: 'off',
  x: 0.5,
  y: 0.5,
  size: 35,
  fade: 50,
  strength: 60,
  angle: 0,
};

export const lensSigma = (w: number, h: number, strength: number) =>
  Math.max(1, Math.hypot(w, h) * 0.012 * (strength / 100));

/** How blurred the point (u, v) (fractions) of a w × h picture is, 0 (sharp) … 1. */
export function lensWeight(lens: LensBlur, u: number, v: number, w: number, h: number): number {
  // Distances in short sides of the picture.
  const inner = 0.05 + (lens.size / 100) * 0.6;
  const width = 0.02 + (lens.fade / 100) * 0.6;
  const short = Math.min(w, h);
  const dx = ((u - lens.x) * w) / short;
  const dy = ((v - lens.y) * h) / short;
  let dist: number;
  if (lens.shape === 'linear') {
    const a = (lens.angle * Math.PI) / 180;
    dist = Math.abs(-Math.sin(a) * dx + Math.cos(a) * dy);
  } else dist = Math.hypot(dx, dy);
  const t = Math.max(0, Math.min(1, (dist - inner / 2) / width));
  return t * t * (3 - 2 * t);
}

export function lensBlur(img: Img, soft: Uint8ClampedArray, lens: LensBlur): void {
  const { data: d, width: w, height: h } = img;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const k = lensWeight(lens, (x + 0.5) / w, (y + 0.5) / h, w, h);
      if (!k) continue;
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) d[i + c] = d[i + c]! + (soft[i + c]! - d[i + c]!) * k;
    }
}

export interface Vignette {
  /** −100 (lighter edges) … 100 (darker edges). */
  amount: number;
  /** 0…100: how big the untouched middle is. */
  size: number;
  /** The middle, fractions of the picture. */
  x: number;
  y: number;
}

export const NO_VIGNETTE: Vignette = { amount: 0, size: 50, x: 0.5, y: 0.5 };

export function vignette(img: Img, v: Vignette, amount = v.amount): void {
  const { data: d, width: w, height: h } = img;
  const inner = 0.15 + (v.size / 100) * 0.7;
  const k = amount / 100;
  const half = Math.hypot(w, h) / 2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dist = Math.hypot(x + 0.5 - v.x * w, y + 0.5 - v.y * h) / half;
      const t = Math.max(0, Math.min(1, (dist - inner) / (1.25 - inner)));
      const e = t * t * (3 - 2 * t);
      if (!e) continue;
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const a = d[i + c]!;
        d[i + c] = k > 0 ? a * (1 - 0.85 * k * e) : a + (255 - a) * -k * e * 0.85;
      }
    }
}

/** Film grain: grey noise, the same every time for the same picture (so the preview doesn't flicker). */
export function grain(img: Img, amount: number): void {
  const { data: d, width: w, height: h } = img;
  const cell = Math.max(1, Math.round(Math.min(w, h) / 1100));
  const k = (amount / 100) * 46;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      // A small integer hash of the cell, two of them summed: roughly bell-shaped.
      let s = (Math.floor(x / cell) * 374761393 + Math.floor(y / cell) * 668265263) | 0;
      s = Math.imul(s ^ (s >>> 13), 1274126177);
      const n1 = ((s ^ (s >>> 16)) & 0xffff) / 0xffff;
      s = Math.imul(s ^ 0x5bd1e995, 1540483477);
      const n2 = ((s ^ (s >>> 15)) & 0xffff) / 0xffff;
      const n = (n1 + n2 - 1) * k;
      const i = (y * w + x) * 4;
      // Less in the blacks and whites, like film.
      const L = lum(d, i) / 255;
      const add = n * (0.4 + 2.4 * L * (1 - L));
      d[i] = d[i]! + add;
      d[i + 1] = d[i + 1]! + add;
      d[i + 2] = d[i + 2]! + add;
    }
}

/**
 * Healing a spot of radius `r` at (cx, cy): the patch nearby whose surroundings look most like the
 * spot's is copied over it, its brightness matched to the spot's edge and its rim blended in.
 */
export function heal(img: Img, cx: number, cy: number, r: number): void {
  const { data: d, width: w, height: h } = img;
  r = Math.max(2, r);
  const ring = r * 1.35;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h;
  // Points on the rim around the spot, compared between the spot and each candidate.
  const rim: Array<[number, number]> = [];
  const count = Math.max(16, Math.round(ring * 2));
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    for (const f of [1.08, 1.3]) rim.push([Math.cos(a) * r * f, Math.sin(a) * r * f]);
  }
  const at = (x: number, y: number, c: number) =>
    d[
      (Math.round(Math.min(h - 1, Math.max(0, y))) * w +
        Math.round(Math.min(w - 1, Math.max(0, x)))) *
        4 +
        c
    ]!;
  let best: { x: number; y: number; cost: number } | null = null;
  for (const dist of [2.2, 2.8, 3.6, 4.6])
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2 + dist;
      const sx = cx + Math.cos(a) * r * dist;
      const sy = cy + Math.sin(a) * r * dist;
      if (!inside(sx - ring, sy - ring) || !inside(sx + ring, sy + ring)) continue;
      let cost = 0;
      for (const [ox, oy] of rim)
        for (let c = 0; c < 3; c++) {
          const e = at(cx + ox, cy + oy, c) - at(sx + ox, sy + oy, c);
          cost += e * e;
        }
      // Nearer patches are a little better: they are usually the same surface.
      cost *= 1 + dist * 0.04;
      if (!best || cost < best.cost) best = { x: sx, y: sy, cost };
    }
  if (!best) return;
  // Brightness and colour of the two rims, to shift the patch to the spot's.
  const shift = [0, 0, 0];
  for (const [ox, oy] of rim)
    for (let c = 0; c < 3; c++)
      shift[c]! += at(cx + ox, cy + oy, c) - at(best.x + ox, best.y + oy, c);
  for (let c = 0; c < 3; c++) shift[c]! /= rim.length;
  const x0 = Math.max(0, Math.floor(cx - ring));
  const x1 = Math.min(w - 1, Math.ceil(cx + ring));
  const y0 = Math.max(0, Math.floor(cy - ring));
  const y1 = Math.min(h - 1, Math.ceil(cy + ring));
  const dx = Math.round(best.x - cx);
  const dy = Math.round(best.y - cy);
  const src = d.slice();
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const dist = Math.hypot(x - cx, y - cy);
      if (dist > ring) continue;
      // Fully replaced inside the spot, fading out across the rim.
      const t = dist <= r ? 1 : 1 - (dist - r) / (ring - r);
      const k = t * t * (3 - 2 * t);
      const i = (y * w + x) * 4;
      const j =
        (Math.min(h - 1, Math.max(0, y + dy)) * w + Math.min(w - 1, Math.max(0, x + dx))) * 4;
      for (let c = 0; c < 3; c++)
        d[i + c] = src[i + c]! + (src[j + c]! + shift[c]! - src[i + c]!) * k;
    }
}

export type RedactMode = 'pixelate' | 'blur' | 'black';

/**
 * Covers a box of the picture for good (ADR-067): blocks of their average colour, a heavy blur, or
 * black. `strength` 0…100 sets the block or blur size against the box's short side.
 */
export function redact(
  img: Img,
  box: { x0: number; y0: number; x1: number; y1: number },
  mode: RedactMode,
  strength: number,
): void {
  const { width: w, height: h, data } = img;
  const x0 = Math.max(0, Math.floor(Math.min(box.x0, box.x1)));
  const y0 = Math.max(0, Math.floor(Math.min(box.y0, box.y1)));
  const x1 = Math.min(w, Math.ceil(Math.max(box.x0, box.x1)));
  const y1 = Math.min(h, Math.ceil(Math.max(box.y0, box.y1)));
  const bw = x1 - x0;
  const bh = y1 - y0;
  if (bw <= 0 || bh <= 0) return;
  if (mode === 'black') {
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = 0;
      }
    return;
  }
  const short = Math.min(bw, bh);
  if (mode === 'pixelate') {
    // At least 4 px a block and at most a third of the box: enough that nothing can be read.
    const block = Math.max(4, Math.round(short * (0.06 + 0.27 * (strength / 100))));
    for (let by = y0; by < y1; by += block)
      for (let bx = x0; bx < x1; bx += block) {
        const ex = Math.min(x1, bx + block);
        const ey = Math.min(y1, by + block);
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let y = by; y < ey; y++)
          for (let x = bx; x < ex; x++) {
            const i = (y * w + x) * 4;
            r += data[i]!;
            g += data[i + 1]!;
            b += data[i + 2]!;
            n++;
          }
        for (let y = by; y < ey; y++)
          for (let x = bx; x < ex; x++) {
            const i = (y * w + x) * 4;
            data[i] = r / n;
            data[i + 1] = g / n;
            data[i + 2] = b / n;
          }
      }
    return;
  }
  const part = new Uint8ClampedArray(bw * bh * 4);
  for (let y = 0; y < bh; y++)
    part.set(data.subarray(((y0 + y) * w + x0) * 4, ((y0 + y) * w + x1) * 4), y * bw * 4);
  const soft = blurred(
    { data: part, width: bw, height: bh },
    Math.max(2, short * (0.05 + 0.2 * (strength / 100))),
  );
  for (let y = 0; y < bh; y++)
    data.set(soft.subarray(y * bw * 4, (y + 1) * bw * 4), ((y0 + y) * w + x0) * 4);
}
