// Colour for the photo editor (ADR-050, ADR-052): Tune image, white balance, curves and the looks.
// Everything per channel goes into one lookup table per channel; then one 3×3 matrix (saturation,
// the look's own colour) and vibrance (ambiance). Done on pixels, not with canvas `filter` (Safari
// lacks it), so the preview and the saved photo are the same.

export interface Tune {
  /** −100…100 each; 0 changes nothing. */
  brightness: number;
  contrast: number;
  saturation: number;
  ambiance: number;
  highlights: number;
  shadows: number;
  warmth: number;
}

export const NO_TUNE: Tune = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  ambiance: 0,
  highlights: 0,
  shadows: 0,
  warmth: 0,
};

export interface WhiteBalance {
  /** −100 (bluer) … 100 (yellower). */
  temperature: number;
  /** −100 (greener) … 100 (more magenta). */
  tint: number;
}

export const NO_WB: WhiteBalance = { temperature: 0, tint: 0 };

/** x (in) and y (out), 0…1, x increasing; the first point is at x 0 and the last at x 1. */
export type CurvePoint = readonly [number, number];
export type Channel = 'rgb' | 'r' | 'g' | 'b';
export type Curves = Record<Channel, readonly CurvePoint[]>;

export const LINEAR: readonly CurvePoint[] = [
  [0, 0],
  [1, 1],
];
export const NO_CURVES: Curves = { rgb: LINEAR, r: LINEAR, g: LINEAR, b: LINEAR };

export const isLinear = (p: readonly CurvePoint[]) => p.every(([x, y]) => x === y);

/** Ready-made curves for the curve tool. */
export const CURVE_PRESETS = {
  linear: LINEAR,
  contrast: [
    [0, 0],
    [0.25, 0.2],
    [0.75, 0.8],
    [1, 1],
  ],
  strong: [
    [0, 0],
    [0.25, 0.14],
    [0.75, 0.88],
    [1, 1],
  ],
  brighter: [
    [0, 0],
    [0.45, 0.58],
    [1, 1],
  ],
  darker: [
    [0, 0],
    [0.55, 0.42],
    [1, 1],
  ],
  matte: [
    [0, 0.12],
    [0.3, 0.3],
    [0.75, 0.78],
    [1, 0.94],
  ],
} satisfies Record<string, readonly CurvePoint[]>;
export type CurvePreset = keyof typeof CURVE_PRESETS;

export interface Detail {
  /** −100 (smoother) … 100 (more texture). */
  structure: number;
  /** 0…100. */
  sharpen: number;
}
export const NO_DETAIL: Detail = { structure: 0, sharpen: 0 };

export interface Effects {
  /** 0…100 each. */
  glow: number;
  grain: number;
  /** Lifted blacks, softer whites. */
  fade: number;
}
export const NO_EFFECTS: Effects = { glow: 0, grain: 0, fade: 0 };

/** One colour wheel: which way the colour goes, how far, and lighter or darker. */
export interface Wheel {
  /** 0…360, degrees round the wheel (0 red, 120 green, 240 blue). */
  hue: number;
  /** 0…100. */
  amount: number;
  /** −100…100. */
  lum: number;
}

/** Colour grading (ADR-067): lift, gamma and gain, as the three wheels of a colourist. */
export interface Grade {
  shadows: Wheel;
  midtones: Wheel;
  highlights: Wheel;
}

const NO_WHEEL: Wheel = { hue: 0, amount: 0, lum: 0 };
export const NO_GRADE: Grade = { shadows: NO_WHEEL, midtones: NO_WHEEL, highlights: NO_WHEEL };
export const isNoGrade = (g: Grade) =>
  [g.shadows, g.midtones, g.highlights].every((w) => !w.amount && !w.lum);

export const HSL_BANDS = [
  'red',
  'orange',
  'yellow',
  'green',
  'aqua',
  'blue',
  'purple',
  'magenta',
] as const;
export type HslBand = (typeof HSL_BANDS)[number];
/** The middle of each band, degrees. */
export const HSL_CENTRES: Record<HslBand, number> = {
  red: 0,
  orange: 30,
  yellow: 60,
  green: 120,
  aqua: 180,
  blue: 240,
  purple: 270,
  magenta: 310,
};
/** Selective colour (ADR-067): per band, its hue moved, and more or less colour and light. −100…100 each. */
export type Hsl = Record<HslBand, { h: number; s: number; l: number }>;
const NO_BAND = { h: 0, s: 0, l: 0 };
export const NO_HSL = Object.fromEntries(HSL_BANDS.map((b) => [b, NO_BAND])) as Hsl;
export const isNoHsl = (h: Hsl) => HSL_BANDS.every((b) => !h[b].h && !h[b].s && !h[b].l);

export type LookId =
  | 'none'
  | 'pop'
  | 'bright'
  | 'morning'
  | 'fade'
  | 'film'
  | 'vintage'
  | 'drama'
  | 'hdr'
  | 'glow'
  | 'cool'
  | 'warm'
  | 'bw'
  | 'noir'
  | 'sepia';

interface Look {
  tune?: Partial<Tune>;
  wb?: Partial<WhiteBalance>;
  curve?: readonly CurvePoint[];
  matrix?: readonly number[];
  structure?: number;
  effects?: Partial<Effects>;
  vignette?: number;
}

const SEPIA = [0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131];
const SOFT_S: readonly CurvePoint[] = [
  [0, 0.04],
  [0.25, 0.22],
  [0.75, 0.8],
  [1, 0.97],
];

/** Each look at full strength; the strength slider scales all of it. */
export const LOOKS: Record<LookId, Look> = {
  none: {},
  pop: { tune: { contrast: 18, saturation: 25, ambiance: 20 }, structure: 15 },
  bright: { tune: { brightness: 22, shadows: 20, highlights: -10, saturation: 5 } },
  morning: {
    tune: { brightness: 10, warmth: 15, saturation: -10 },
    effects: { fade: 20, glow: 15 },
  },
  fade: { tune: { contrast: -15, saturation: -25 }, effects: { fade: 45 } },
  film: {
    tune: { warmth: 8, saturation: -10 },
    curve: SOFT_S,
    effects: { grain: 35, fade: 20 },
  },
  vintage: {
    tune: { saturation: -30, warmth: 25 },
    effects: { fade: 30, grain: 20 },
    vignette: 35,
  },
  drama: { tune: { contrast: 25, saturation: -35, shadows: -10 }, structure: 60, vignette: 25 },
  hdr: {
    tune: { shadows: 45, highlights: -45, saturation: 20, ambiance: 30 },
    structure: 70,
  },
  glow: { tune: { brightness: 5, contrast: 5 }, effects: { glow: 55 } },
  cool: { wb: { temperature: -30, tint: 5 }, tune: { saturation: 5 } },
  warm: { wb: { temperature: 30 }, tune: { saturation: 10 } },
  bw: { tune: { saturation: -100, contrast: 15 } },
  noir: {
    tune: { saturation: -100, contrast: 45, brightness: -10 },
    effects: { grain: 25 },
    vignette: 40,
  },
  sepia: { matrix: SEPIA, tune: { contrast: 5 } },
};

export interface Colour {
  tune: Tune;
  wb: WhiteBalance;
  curves: Curves;
  grade: Grade;
  hsl: Hsl;
  detail: Detail;
  effects: Effects;
  look: { id: LookId; amount: number };
  vignette: { amount: number };
}

const clamp = (v: number, lo = -100, hi = 100) => Math.max(lo, Math.min(hi, v));

function add<T extends object>(base: T, extra: Partial<T> | undefined, k: number, lo = -100): T {
  if (!extra) return base;
  const out = { ...base };
  for (const key of Object.keys(extra) as Array<keyof T>)
    out[key] = clamp((base[key] as number) + (extra[key] as number) * k, lo, 100) as T[keyof T];
  return out;
}

/** What the photo gets: the sliders with the look added at its strength. */
export function resolve(c: Colour) {
  const look = LOOKS[c.look.id];
  const k = c.look.amount / 100;
  return {
    tune: add(c.tune, look.tune, k),
    wb: add(c.wb, look.wb, k),
    curves: c.curves,
    grade: c.grade,
    hsl: c.hsl,
    lookCurve: look.curve && k ? look.curve : null,
    lookMatrix: look.matrix && k ? look.matrix : null,
    k,
    detail: { ...c.detail, structure: clamp(c.detail.structure + (look.structure ?? 0) * k) },
    effects: add(c.effects, look.effects, k, 0),
    vignette: clamp(c.vignette.amount + (look.vignette ?? 0) * k),
  };
}
export type Resolved = ReturnType<typeof resolve>;

/** The curve through the points, 256 values 0…255; monotone between points (Fritsch–Carlson). */
export function curveLut(points: readonly CurvePoint[]): Float32Array {
  const p = [...points].sort((a, b) => a[0] - b[0]);
  const n = p.length;
  const out = new Float32Array(256);
  if (n < 2) {
    for (let v = 0; v < 256; v++) out[v] = v;
    return out;
  }
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(Math.max(1e-6, p[i + 1]![0] - p[i]![0]));
    slope.push((p[i + 1]![1] - p[i]![1]) / dx[i]!);
  }
  const m: number[] = [slope[0]!];
  for (let i = 1; i < n - 1; i++)
    m.push(slope[i - 1]! * slope[i]! <= 0 ? 0 : (slope[i - 1]! + slope[i]!) / 2);
  m.push(slope[n - 2]!);
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      m[i] = m[i + 1] = 0;
      continue;
    }
    const a = m[i]! / slope[i]!;
    const b = m[i + 1]! / slope[i]!;
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * slope[i]!;
      m[i + 1] = t * b * slope[i]!;
    }
  }
  let seg = 0;
  for (let v = 0; v < 256; v++) {
    const x = v / 255;
    let y: number;
    if (x <= p[0]![0]) y = p[0]![1];
    else if (x >= p[n - 1]![0]) y = p[n - 1]![1];
    else {
      while (seg < n - 2 && x > p[seg + 1]![0]) seg++;
      const h = dx[seg]!;
      const t = (x - p[seg]![0]) / h;
      const t2 = t * t;
      const t3 = t2 * t;
      y =
        (2 * t3 - 3 * t2 + 1) * p[seg]![1] +
        (t3 - 2 * t2 + t) * h * m[seg]! +
        (-2 * t3 + 3 * t2) * p[seg + 1]![1] +
        (t3 - t2) * h * m[seg + 1]!;
    }
    out[v] = Math.max(0, Math.min(1, y)) * 255;
  }
  return out;
}

function multiply(a: readonly number[], b: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      out.push(a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!);
  return out;
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** The same matrix as CSS `saturate(s)` (Rec. 709 weights). */
function saturate(s: number): number[] {
  return [
    0.213 + 0.787 * s,
    0.715 - 0.715 * s,
    0.072 - 0.072 * s,
    0.213 - 0.213 * s,
    0.715 + 0.285 * s,
    0.072 - 0.072 * s,
    0.213 - 0.213 * s,
    0.715 - 0.715 * s,
    0.072 + 0.928 * s,
  ];
}

export interface Pipeline {
  r: Uint8ClampedArray;
  g: Uint8ClampedArray;
  b: Uint8ClampedArray;
  /** Row-major; null when it would change nothing. */
  m: number[] | null;
  /** Vibrance, −1…1; 0 for none. */
  vib: number;
  /** Selective colour per degree of hue; null for none. */
  hsl: HslTable | null;
}

/** For each whole degree of hue: how far it turns (degrees), and the change in colour and light. */
export interface HslTable {
  dh: Float32Array;
  ds: Float32Array;
  dl: Float32Array;
}

/** How much of `band` a hue is: 1 at its middle, falling to 0 at the next band's middle. */
function bandWeight(hue: number, band: HslBand): number {
  const i = HSL_BANDS.indexOf(band);
  const c = HSL_CENTRES[band];
  const prev = HSL_CENTRES[HSL_BANDS[(i + 7) % 8]!];
  const next = HSL_CENTRES[HSL_BANDS[(i + 1) % 8]!];
  const d = ((hue - c + 540) % 360) - 180;
  const span = d < 0 ? (c - prev + 360) % 360 : (next - c + 360) % 360;
  return Math.max(0, 1 - Math.abs(d) / span);
}

export function hslTable(h: Hsl): HslTable {
  const dh = new Float32Array(360);
  const ds = new Float32Array(360);
  const dl = new Float32Array(360);
  for (let deg = 0; deg < 360; deg++)
    for (const b of HSL_BANDS) {
      const w = bandWeight(deg, b);
      if (!w) continue;
      dh[deg]! += w * h[b].h * 0.3;
      ds[deg]! += (w * h[b].s) / 100;
      dl[deg]! += (w * h[b].l) / 100;
    }
  return { dh, ds, dl };
}

/** A wheel's push on red, green and blue: they add up to nothing, the biggest is ±1 at full amount. */
export function wheelRgb(w: Wheel): [number, number, number] {
  if (!w.amount) return [0, 0, 0];
  const h = (((w.hue % 360) + 360) % 360) / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  const [r, g, b] =
    h < 1
      ? [1, x, 0]
      : h < 2
        ? [x, 1, 0]
        : h < 3
          ? [0, 1, x]
          : h < 4
            ? [0, x, 1]
            : h < 5
              ? [x, 0, 1]
              : [1, 0, x];
  const mean = (r + g + b) / 3;
  const v = [r - mean, g - mean, b - mean];
  const top = Math.max(...v.map(Math.abs)) || 1;
  const k = w.amount / 100 / top;
  return [v[0]! * k, v[1]! * k, v[2]! * k];
}

/** Lift, gamma and gain for channel `ch` (0 red, 1 green, 2 blue) applied to x (0…1). */
export function gradeChannel(x: number, ch: number, g: Grade): number {
  const lift = wheelRgb(g.shadows)[ch]! * 0.25 + (g.shadows.lum / 100) * 0.25;
  const gamma = wheelRgb(g.midtones)[ch]! * 0.5 + (g.midtones.lum / 100) * 0.5;
  const gain = wheelRgb(g.highlights)[ch]! * 0.3 + (g.highlights.lum / 100) * 0.3;
  let y = x * (1 + gain);
  y = y + lift * (1 - y);
  y = Math.max(0, Math.min(1, y));
  return y ** (1 / Math.max(0.2, 1 + gamma));
}

/** Null when the colours would come out unchanged. */
export function pipeline(r: Resolved): Pipeline | null {
  const { tune: a, wb, curves, lookCurve, lookMatrix, k, grade, hsl } = r;
  const graded = !isNoGrade(grade);
  const selective = !isNoHsl(hsl);
  const fade = r.effects.fade / 100;
  const curved = [curves.rgb, curves.r, curves.g, curves.b].some((c) => !isLinear(c));
  const amb = a.ambiance / 100;
  if (
    Object.values(a).every((v) => !v) &&
    !wb.temperature &&
    !wb.tint &&
    !fade &&
    !curved &&
    !lookCurve &&
    !lookMatrix &&
    !graded &&
    !selective
  )
    return null;

  const C = a.contrast * 1.28;
  const f = (259 * (C + 255)) / (255 * (259 - C));
  // Brightness is a gamma curve (2^−b, so 0.5…2): mid-tones move, black and white stay.
  const gamma = 2 ** (-a.brightness / 100);
  const sh = a.shadows / 100 + amb * 0.4;
  const hi = a.highlights / 100 - amb * 0.25;
  const T = wb.temperature / 100;
  const gains = [
    1 + (T > 0 ? 0.15 : 0.25) * T,
    1 - 0.22 * (wb.tint / 100),
    1 - (T > 0 ? 0.25 : 0.15) * T,
  ];
  const w = a.warmth / 100;
  const offsets = [w * 25, w * 5, -w * 25];
  const look = lookCurve ? curveLut(lookCurve) : null;
  const master = isLinear(curves.rgb) ? null : curveLut(curves.rgb);
  const own = [curves.r, curves.g, curves.b].map((c) => (isLinear(c) ? null : curveLut(c)));

  const luts = [0, 1, 2].map((ch) => {
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) {
      let x = Math.min(1, (v / 255) * gains[ch]!);
      x = x ** gamma;
      x += sh * 1.8 * x * (1 - x) ** 2 + hi * 1.8 * x * x * (1 - x);
      x = f * (x - 0.5) + 0.5;
      x = fade * 0.16 + x * (1 - fade * 0.22);
      let y = Math.max(0, Math.min(255, x * 255 + offsets[ch]!));
      if (look) y += (look[Math.round(y)]! - y) * k;
      if (master) y = master[Math.round(y)]!;
      const c = own[ch];
      if (c) y = c[Math.round(y)]!;
      if (graded) y = gradeChannel(y / 255, ch, grade) * 255;
      lut[v] = y;
    }
    return lut;
  });

  let m: number[] | null = a.saturation ? saturate(1 + a.saturation / 100) : null;
  if (lookMatrix) {
    const blend = lookMatrix.map((x, i) => IDENTITY[i]! + (x - IDENTITY[i]!) * k);
    m = m ? multiply(blend, m) : blend;
  }
  return {
    r: luts[0]!,
    g: luts[1]!,
    b: luts[2]!,
    m,
    vib: amb * 0.6,
    hsl: selective ? hslTable(hsl) : null,
  };
}

/** Changes RGBA pixels in place; alpha stays. */
export function applyPipeline(data: Uint8ClampedArray, p: Pipeline): void {
  const { r, g, b, m, vib, hsl } = p;
  for (let i = 0; i < data.length; i += 4) {
    let R: number = r[data[i]!]!;
    let G: number = g[data[i + 1]!]!;
    let B: number = b[data[i + 2]!]!;
    if (m) {
      const r2 = m[0]! * R + m[1]! * G + m[2]! * B;
      const g2 = m[3]! * R + m[4]! * G + m[5]! * B;
      B = m[6]! * R + m[7]! * G + m[8]! * B;
      R = r2;
      G = g2;
    }
    if (vib) {
      // Muted colours move most; strong ones and greys hardly at all.
      const hi = Math.max(R, G, B);
      const lo = Math.min(R, G, B);
      const L = 0.2126 * R + 0.7152 * G + 0.0722 * B;
      const s = Math.min(1, (hi - lo) / 255);
      const k = 1 + vib * (1 - s) * Math.min(1, s * 4);
      R = L + (R - L) * k;
      G = L + (G - L) * k;
      B = L + (B - L) * k;
    }
    if (hsl) [R, G, B] = selectiveColour(R, G, B, hsl);
    data[i] = R;
    data[i + 1] = G;
    data[i + 2] = B;
  }
}

/** One pixel through the selective colour table (0…255 in and out); greys stay as they are. */
export function selectiveColour(
  R: number,
  G: number,
  B: number,
  t: HslTable,
): [number, number, number] {
  const r = Math.max(0, Math.min(1, R / 255));
  const g = Math.max(0, Math.min(1, G / 255));
  const b = Math.max(0, Math.min(1, B / 255));
  const hi = Math.max(r, g, b);
  const lo = Math.min(r, g, b);
  const d = hi - lo;
  if (d < 1e-4) return [R, G, B];
  const l = (hi + lo) / 2;
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = hi === r ? ((g - b) / d) % 6 : hi === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  const i = Math.floor(h) % 360;
  // Colour moves only where there is colour to move.
  const w = Math.min(1, s * 4);
  const h2 = (h + t.dh[i]! * w + 360) % 360;
  const s2 = Math.max(0, Math.min(1, s * (1 + t.ds[i]! * w)));
  const l2 = Math.max(0, Math.min(1, l + t.dl[i]! * 0.5 * w * (1 - Math.abs(2 * l - 1))));
  const c = (1 - Math.abs(2 * l2 - 1)) * s2;
  const x = c * (1 - Math.abs(((h2 / 60) % 2) - 1));
  const m0 = l2 - c / 2;
  const seg = Math.floor(h2 / 60);
  const [r1, g1, b1] =
    seg === 0
      ? [c, x, 0]
      : seg === 1
        ? [x, c, 0]
        : seg === 2
          ? [0, c, x]
          : seg === 3
            ? [0, x, c]
            : seg === 4
              ? [x, 0, c]
              : [c, 0, x];
  return [(r1 + m0) * 255, (g1 + m0) * 255, (b1 + m0) * 255];
}

/** Light and colour that suit the photo: dark ones brighter, flat ones more contrast. */
export function autoTune(data: Uint8ClampedArray): Tune {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < data.length; i += 16) {
    hist[Math.round(0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!)]!++;
    n++;
  }
  const at = (q: number) => {
    let sum = 0;
    for (let v = 0; v < 256; v++) {
      sum += hist[v]!;
      if (sum >= q * n) return v / 255;
    }
    return 1;
  };
  const lo = at(0.01);
  const mid = at(0.5);
  const top = at(0.99);
  const round = (v: number, max: number) => Math.round(clamp(v, -max, max));
  return {
    ...NO_TUNE,
    brightness: round((0.48 - mid) * 140, 45),
    contrast: round((0.88 - (top - lo)) * 70, 35),
    shadows: round((0.12 - lo) * 120, 30),
    highlights: round((0.92 - top) * 120, 30),
    saturation: 8,
    ambiance: 10,
  };
}

/** Grey-world white balance: what makes the average colour grey. */
export function autoWhiteBalance(data: Uint8ClampedArray): WhiteBalance {
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < data.length; i += 16) {
    r += data[i]!;
    g += data[i + 1]!;
    b += data[i + 2]!;
  }
  const avg = (r + g + b) / 3 || 1;
  return {
    temperature: Math.round(clamp(((b - r) / avg) * 120, -60, 60)),
    tint: Math.round(clamp(((g - (r + b) / 2) / avg) * 150, -60, 60)),
  };
}
