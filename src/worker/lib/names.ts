// File/folder name rules (SPEC §14.4) and sibling-name keys (SPEC §4).
import { NAME_MAX_UTF8_BYTES } from '../../shared/constants';
import { AppError } from './errors';

// Control characters (C0, DEL, C1) and path separators are removed.
// eslint-disable-next-line no-control-regex
const STRIP = /[\u0000-\u001f\u007f-\u009f/\\]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
const utf8 = new TextEncoder();

/** Cleans a user-supplied name; throws INVALID_NAME when nothing usable is left. */
export function sanitizeName(raw: string): string {
  let name = raw.normalize('NFC').replace(STRIP, '').trim();
  // Windows silently drops trailing dots/spaces; strip them so names round-trip through ZIPs.
  name = name.replace(/[. ]+$/, '');
  if (name === '' || name === '.' || name === '..') {
    throw new AppError('INVALID_NAME', 'empty or reserved name');
  }
  const dot = name.indexOf('.');
  const base = dot === -1 ? name : name.slice(0, dot);
  if (WINDOWS_RESERVED.test(base)) {
    name = `${base}_${dot === -1 ? '' : name.slice(dot)}`;
  }
  if (utf8.encode(name).length > NAME_MAX_UTF8_BYTES) {
    throw new AppError('INVALID_NAME', 'name longer than 255 bytes');
  }
  return name;
}

/** Case-insensitive key used by the sibling uniqueness index (shared with the index reads). */
export { nameKey } from '../../shared/drive-tree';

export function splitExt(name: string): { base: string; ext: string } {
  const i = name.lastIndexOf('.');
  if (i <= 0) return { base: name, ext: '' };
  return { base: name.slice(0, i), ext: name.slice(i) };
}

/** "nama (1).ext" style alternative names. */
export function nameWithSuffix(name: string, n: number): string {
  const { base, ext } = splitExt(name);
  return `${base} (${n})${ext}`;
}
