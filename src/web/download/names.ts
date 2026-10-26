// File and folder names for "save into a folder" (ADR-053), kept apart from the browser APIs.

/** Path parts safe on every desktop system; "..", "." and empty parts are dropped. */
export function safeParts(path: string): string[] {
  return path
    .split('/')
    .map((p) =>
      p
        // eslint-disable-next-line no-control-regex
        .replace(/[<>:"\\|?*\u0000-\u001f]/g, '_')
        .replace(/[. ]+$/, '')
        .slice(0, 200),
    )
    .filter((p) => p && p !== '.' && p !== '..');
}

/** "a.jpg" → "a (1).jpg" → "a (2).jpg" … */
export function numbered(name: string, n: number): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}
