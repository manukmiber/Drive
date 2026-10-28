// Text, stickers and shapes laid over a picture (ADR-067), shared by the photo editor, the collage
// and the video editor. Plain data: the middle in fractions of the picture they belong to, the
// size in short sides of it, so a smaller copy on screen looks like the saved result. No DOM here.

export type FontId = 'sans' | 'serif' | 'mono' | 'round' | 'hand' | 'display';
export type TextStyle = 'plain' | 'bold' | 'box' | 'outline' | 'shadow' | 'neon';
export type TextAlign = 'left' | 'center' | 'right';
export type ShapeId =
  | 'rect'
  | 'round'
  | 'circle'
  | 'triangle'
  | 'star'
  | 'heart'
  | 'arrow'
  | 'line'
  | 'bubble'
  | 'burst';

interface Base {
  id: string;
  /** Middle, 0…1 of the picture's width and height. */
  x: number;
  y: number;
  /** Text: the letters' height; stickers and shapes: their height. In short sides of the picture. */
  size: number;
  /** Degrees clockwise. */
  rotation: number;
  /** 0…1. */
  opacity: number;
}

export interface TextItem extends Base {
  kind: 'text';
  text: string;
  font: FontId;
  style: TextStyle;
  color: string;
  align: TextAlign;
}

export interface StickerItem extends Base {
  kind: 'sticker';
  emoji: string;
}

export interface ShapeItem extends Base {
  kind: 'shape';
  shape: ShapeId;
  color: string;
  /** Filled, or only its outline. */
  fill: boolean;
  /** Outline width, a fraction of the shape's height. */
  line: number;
  /** Width over height. */
  aspect: number;
}

export type DecorItem = TextItem | StickerItem | ShapeItem;
export type DecorKind = DecorItem['kind'];

export const FONTS: FontId[] = ['sans', 'serif', 'mono', 'round', 'hand', 'display'];
export const TEXT_STYLES: TextStyle[] = ['plain', 'bold', 'box', 'outline', 'shadow', 'neon'];
export const SHAPES: ShapeId[] = [
  'rect',
  'round',
  'circle',
  'triangle',
  'star',
  'heart',
  'arrow',
  'line',
  'bubble',
  'burst',
];

/** System fonts only: nothing is fetched, so the page and the saved picture use the same ones. */
export const FONT_STACK: Record<FontId, string> = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", "Noto Serif", serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, "Roboto Mono", monospace',
  round: '"Arial Rounded MT Bold", "Nunito", "Varela Round", ui-rounded, system-ui, sans-serif',
  hand: '"Segoe Print", "Bradley Hand", "Comic Sans MS", "Chalkboard SE", cursive',
  display: 'Impact, Haettenschweiler, "Arial Narrow Bold", "Oswald", sans-serif',
};

/** Variation selectors stay with their emoji: split by grapheme where the engine can. */
export function graphemes(s: string): string[] {
  const Seg = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (Seg)
    return [...new Seg(undefined, { granularity: 'grapheme' }).segment(s)].map((g) => g.segment);
  return [...s];
}

export const STICKERS: Record<string, string[]> = {
  smile: graphemes('😀😂🥹😍🥰😘😎🤩🥳😇🙂😉😜🤗🤔😴😭😡🤯🥺😱🤠👻💀'),
  love: graphemes('❤️🧡💛💚💙💜🖤🤍💕💖💗💘💝💞💌💋😻🫶🥰💐🌹'),
  party: graphemes('🎉🎊🎈🎂🎁🥂🍾🎆🎇✨🎀🪅🎵🎶🎤🏆🥇👑💎'),
  nature: graphemes('🌸🌺🌻🌷🌼🍀🌿🍁🌙⭐🌟☀️🌈⛅❄️🔥🌊🦋🐶🐱🐰🐻🐼'),
  food: graphemes('🍕🍔🍟🌭🍜🍣🍩🍪🍰🧁🍦🍓🍉🍌🥑☕🧋🍹🍫🍿'),
  travel: graphemes('✈️🚗🏍️🚲⛵🏖️🏝️⛰️🗼🗽🏰🎡📍🗺️🧳📸🌄🌅'),
  things: graphemes('📷🎮💻📱⌚💡📚✏️🎨🎸⚽🏀👟👓🕶️💄💍🛍️'),
  signs: graphemes('✅❌⭕❗❓💯🔔💬💭👉👈👆👇👍👎👏🙌🙏💪✌️🤞'),
};

const SIZE: Record<DecorKind, number> = { text: 0.08, sticker: 0.2, shape: 0.25 };

/** A new item in the middle, the default size for its kind. */
export function makeItem(id: string, kind: 'text', extra?: Partial<TextItem>): TextItem;
export function makeItem(id: string, kind: 'sticker', extra?: Partial<StickerItem>): StickerItem;
export function makeItem(id: string, kind: 'shape', extra?: Partial<ShapeItem>): ShapeItem;
export function makeItem(id: string, kind: DecorKind, extra: Partial<DecorItem> = {}): DecorItem {
  const base = { id, x: 0.5, y: 0.5, size: SIZE[kind], rotation: 0, opacity: 1 };
  if (kind === 'text')
    return {
      ...base,
      kind,
      text: '',
      font: 'sans',
      style: 'bold',
      color: '#ffffff',
      align: 'center',
      ...(extra as Partial<TextItem>),
    };
  if (kind === 'sticker') return { ...base, kind, emoji: '😀', ...(extra as Partial<StickerItem>) };
  return {
    ...base,
    kind,
    shape: 'heart',
    color: '#ef4444',
    fill: true,
    line: 0.08,
    aspect: 1,
    ...(extra as Partial<ShapeItem>),
  };
}

/** The shapes that are wider than tall by default. */
export const SHAPE_ASPECT: Partial<Record<ShapeId, number>> = { arrow: 2, line: 3, bubble: 1.4 };

export function bringForward(items: DecorItem[], id: string, dir: 1 | -1): DecorItem[] {
  const i = items.findIndex((x) => x.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= items.length) return items;
  const next = [...items];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

/** Turns near a right angle snap onto it (within 4°). */
export function snapAngle(deg: number): number {
  const a = (((deg % 360) + 540) % 360) - 180;
  for (const r of [-180, -90, 0, 90, 180]) if (Math.abs(a - r) < 4) return r === -180 ? 180 : r;
  return Math.round(a * 10) / 10;
}
