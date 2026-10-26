// What an edit is (ADR-052): everything the photo editor changes, as plain data. Undo/redo keep a
// list of these; nothing in them is a picture. No DOM here, so the maths is tested in Node.
import { NO_CURVES, NO_DETAIL, NO_EFFECTS, NO_TUNE, NO_WB, type Colour } from './adjust';
import { NO_LENS, NO_VIGNETTE, type LensBlur, type Vignette } from './effects';
import { FULL, type Orientation, type Rect } from './geometry';

/** A healed spot: its middle in fractions of the photo, its radius in short sides of it. */
export interface Spot {
  x: number;
  y: number;
  r: number;
}

export type TextStyle = 'plain' | 'bold' | 'box' | 'outline';

/** Text on the photo: its middle in fractions of the photo, its size in short sides of it. */
export interface TextMark {
  id: string;
  text: string;
  x: number;
  y: number;
  size: number;
  color: string;
  style: TextStyle;
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
  texts: TextMark[];
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
  detail: NO_DETAIL,
  effects: NO_EFFECTS,
  look: { id: 'none', amount: 100 },
  vignette: NO_VIGNETTE,
  lens: NO_LENS,
  heal: [],
  texts: [],
  frame: { style: 'none', width: 40, color: '#ffffff' },
  scale: 1,
};
