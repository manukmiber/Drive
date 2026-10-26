// Folder decoration (ADR-058): a colour from a fixed palette, an icon from a fixed list or one emoji,
// and a cover image. Shared by the Worker (checks, the public share page) and the app.

/** Each colour has a shade for light surfaces and one for dark, both readable as an icon. */
export const FOLDER_COLORS = {
  red: { light: '#dc2626', dark: '#f87171' },
  orange: { light: '#c2410c', dark: '#fb923c' },
  amber: { light: '#b45309', dark: '#fbbf24' },
  lime: { light: '#4d7c0f', dark: '#a3e635' },
  green: { light: '#15803d', dark: '#4ade80' },
  teal: { light: '#0f766e', dark: '#2dd4bf' },
  sky: { light: '#0369a1', dark: '#38bdf8' },
  blue: { light: '#1d4ed8', dark: '#60a5fa' },
  indigo: { light: '#4338ca', dark: '#a5b4fc' },
  violet: { light: '#6d28d9', dark: '#c4b5fd' },
  pink: { light: '#be185d', dark: '#f9a8d4' },
  slate: { light: '#475569', dark: '#cbd5e1' },
} as const;
export type FolderColor = keyof typeof FOLDER_COLORS;

/** lucide-react icon names (kebab case, as their files are named). */
export const FOLDER_ICONS = [
  'folder',
  'star',
  'heart',
  'briefcase',
  'graduation-cap',
  'book-open',
  'camera',
  'image',
  'music',
  'film',
  'file-text',
  'code',
  'gamepad-2',
  'plane',
  'house',
  'shopping-bag',
  'wallet',
  'receipt',
  'baby',
  'paw-print',
  'dumbbell',
  'utensils',
  'lock',
  'archive',
] as const;
export type FolderIconName = (typeof FOLDER_ICONS)[number];

export interface FolderDecor {
  color: FolderColor | null;
  /** A name from FOLDER_ICONS, or one emoji. */
  icon: string | null;
  /** A file whose thumbnail the viewer may see; null when there is none or it is not theirs to see. */
  coverId: string | null;
}

export function isFolderColor(s: string): s is FolderColor {
  return Object.hasOwn(FOLDER_COLORS, s);
}

export function isIconName(s: string): s is FolderIconName {
  return (FOLDER_ICONS as readonly string[]).includes(s);
}

/** Exactly one emoji (one grapheme, pictographic or a flag). */
export function isOneEmoji(s: string): boolean {
  if (!s || s.length > 16) return false;
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)];
  return graphemes.length === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s);
}

export function isFolderIcon(s: string): boolean {
  return isIconName(s) || isOneEmoji(s);
}
