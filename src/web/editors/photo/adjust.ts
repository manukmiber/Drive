// Colour changes for the photo editor (ADR-050): a lookup table per channel (brightness, contrast,
// warmth), then one 3×3 matrix (saturation, then the filter's own colour). Done on pixels, not with
// canvas `filter` (Safari lacks it), so the preview and the saved photo are the same.

export interface Adjust {
  /** −100…100 each; 0 changes nothing. */
  brightness: number;
  contrast: number;
  saturation: number;
  warmth: number;
}

export const NO_ADJUST: Adjust = { brightness: 0, contrast: 0, saturation: 0, warmth: 0 };

export type FilterId = 'none' | 'bw' | 'sepia' | 'warm' | 'cool' | 'vivid' | 'fade';

const SEPIA = [0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131];

export const FILTERS: Record<FilterId, { adjust: Partial<Adjust>; matrix?: number[] }> = {
  none: { adjust: {} },
  bw: { adjust: { saturation: -100, contrast: 10 } },
  sepia: { adjust: {}, matrix: SEPIA },
  warm: { adjust: { warmth: 35, saturation: 10 } },
  cool: { adjust: { warmth: -35 } },
  vivid: { adjust: { saturation: 45, contrast: 15 } },
  fade: { adjust: { contrast: -25, brightness: 15, saturation: -25 } },
};

export interface Pipeline {
  r: Uint8ClampedArray;
  g: Uint8ClampedArray;
  b: Uint8ClampedArray;
  /** Row-major; null when it would change nothing. */
  m: number[] | null;
}

const clamp = (v: number) => Math.max(-100, Math.min(100, v));

/** The filter's own values plus the sliders. */
export function combined(a: Adjust, filter: FilterId): Adjust {
  const f = FILTERS[filter].adjust;
  return {
    brightness: clamp(a.brightness + (f.brightness ?? 0)),
    contrast: clamp(a.contrast + (f.contrast ?? 0)),
    saturation: clamp(a.saturation + (f.saturation ?? 0)),
    warmth: clamp(a.warmth + (f.warmth ?? 0)),
  };
}

function multiply(a: number[], b: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      out.push(a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!);
  return out;
}

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

/** Null when the photo would come out unchanged. */
export function pipeline(adjust: Adjust, filter: FilterId): Pipeline | null {
  const a = combined(adjust, filter);
  const extra = FILTERS[filter].matrix;
  if (!a.brightness && !a.contrast && !a.saturation && !a.warmth && !extra) return null;
  const C = a.contrast * 1.28;
  const f = (259 * (C + 255)) / (255 * (259 - C));
  // Brightness is a gamma curve (2^−b, so 0.5…2): mid-tones move, black and white stay.
  const gamma = 2 ** (-a.brightness / 100);
  const tone = (v: number) => f * (255 * (v / 255) ** gamma - 128) + 128;
  const w = a.warmth / 100;
  const r = new Uint8ClampedArray(256);
  const g = new Uint8ClampedArray(256);
  const bl = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    const t = tone(v);
    r[v] = t + w * 25;
    g[v] = t + w * 5;
    bl[v] = t - w * 25;
  }
  let m: number[] | null = a.saturation ? saturate(1 + a.saturation / 100) : null;
  if (extra) m = m ? multiply(extra, m) : extra;
  return { r, g, b: bl, m };
}

/** Changes RGBA pixels in place; alpha stays. */
export function applyPipeline(data: Uint8ClampedArray, p: Pipeline): void {
  const { r, g, b, m } = p;
  for (let i = 0; i < data.length; i += 4) {
    const R = r[data[i]!]!;
    const G = g[data[i + 1]!]!;
    const B = b[data[i + 2]!]!;
    if (m) {
      data[i] = m[0]! * R + m[1]! * G + m[2]! * B;
      data[i + 1] = m[3]! * R + m[4]! * G + m[5]! * B;
      data[i + 2] = m[6]! * R + m[7]! * G + m[8]! * B;
    } else {
      data[i] = R;
      data[i + 1] = G;
      data[i + 2] = B;
    }
  }
}
