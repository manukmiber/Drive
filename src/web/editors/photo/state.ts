// What an edit is (ADR-052): everything the photo editor changes, as plain data. Undo/redo keep a
// list of these; nothing in them is a picture. No DOM here, so the maths is tested in Node.
import type { DecorItem } from '../decor/items';
import {
  NO_CURVES,
  NO_DETAIL,
  NO_EFFECTS,
  NO_GRADE,
  NO_HSL,
  NO_TUNE,
  NO_WB,
  type Colour,
} from './adjust';
import { NO_LENS, NO_VIGNETTE, type LensBlur, type RedactMode, type Vignette } from './effects';
import { FULL, type Orientation, type Rect } from './geometry';

/** A healed spot: its middle in fractions of the photo, its radius in short sides of it. */
export interface Spot {
  x: number;
  y: number;
  r: number;
}

export type Pen = 'pen' | 'marker' | 'neon';

/** A line drawn on the photo (ADR-067): points in fractions of the photo, width in short sides. */
export interface Stroke {
  id: string;
  /** x, y, x, y, … */
  points: number[];
  color: string;
  width: number;
  pen: Pen;
}

/** A covered box (ADR-067), in fractions of the photo. */
export interface Redaction {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  mode: RedactMode;
  /** 0…100. */
  strength: number;
}

export type FrameStyle = 'none' | 'thin' | 'thick' | 'polaroid' | 'round';

export interface Frame {
  style: FrameStyle;
  /** 0…100. */
  width: number;
  color: string;
}

export interface PhotoState extends Colour {
  o: Orientation;
  /** Straightening, degrees clockwise, −45…45. */
  angle: number;
  crop: Rect;
  vignette: Vignette;
  lens: LensBlur;
  heal: Spot[];
  /** Text, stickers and shapes on the photo (ADR-067), in photo fractions; later ones on top. */
  decor: DecorItem[];
  strokes: Stroke[];
  redact: Redaction[];
  frame: Frame;
  /** Of the cropped size, 0…1. */
  scale: number;
}

export const START: PhotoState = {
  o: { turn: 0, flipH: false, flipV: false },
  angle: 0,
  crop: FULL,
  tune: NO_TUNE,
  wb: NO_WB,
  curves: NO_CURVES,
  grade: NO_GRADE,
  hsl: NO_HSL,
  detail: NO_DETAIL,
  effects: NO_EFFECTS,
  look: { id: 'none', amount: 100 },
  vignette: NO_VIGNETTE,
  lens: NO_LENS,
  heal: [],
  decor: [],
  strokes: [],
  redact: [],
  frame: { style: 'none', width: 40, color: '#ffffff' },
  scale: 1,
};
