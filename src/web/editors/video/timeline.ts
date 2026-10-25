// The video editor's timeline (ADR-050): parts of clips, played one after another. Times are
// seconds; a part is `start`…`end` of its clip.

export interface Part {
  id: string;
  clip: string;
  start: number;
  end: number;
}

/** No part gets shorter than this. */
export const MIN_PART = 0.1;

export const length = (p: Part) => p.end - p.start;
export const total = (parts: Part[]) => parts.reduce((s, p) => s + length(p), 0);

/** Which part plays at timeline time `t`, and where in its clip. */
export function locate(
  parts: Part[],
  t: number,
): { index: number; at: number; offset: number } | null {
  let offset = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const len = length(p);
    if (t < offset + len || i === parts.length - 1) {
      const into = Math.max(0, Math.min(len, t - offset));
      return { index: i, at: p.start + into, offset };
    }
    offset += len;
  }
  return null;
}

/** Timeline time where part `index` starts. */
export function startOf(parts: Part[], index: number): number {
  return total(parts.slice(0, index));
}

/** Splits the part under `t` in two; nothing happens too close to its ends. */
export function split(parts: Part[], t: number, newId: string): Part[] {
  const loc = locate(parts, t);
  if (!loc) return parts;
  const p = parts[loc.index]!;
  if (loc.at - p.start < MIN_PART || p.end - loc.at < MIN_PART) return parts;
  return [
    ...parts.slice(0, loc.index),
    { ...p, end: loc.at },
    { ...p, id: newId, start: loc.at },
    ...parts.slice(loc.index + 1),
  ];
}

export function remove(parts: Part[], id: string): Part[] {
  return parts.length > 1 ? parts.filter((p) => p.id !== id) : parts;
}

export function move(parts: Part[], id: string, dir: -1 | 1): Part[] {
  const i = parts.findIndex((p) => p.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= parts.length) return parts;
  const next = [...parts];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

/** Moves the start (or end) of a part to `at` in its clip, keeping at least MIN_PART. */
export function trim(parts: Part[], id: string, edge: 'start' | 'end', at: number): Part[] {
  return parts.map((p) => {
    if (p.id !== id) return p;
    if (edge === 'start') return { ...p, start: Math.max(0, Math.min(at, p.end - MIN_PART)) };
    return { ...p, end: Math.max(at, p.start + MIN_PART) };
  });
}

/** 75.25 → "1:15.2" */
export function clock(s: number): string {
  const v = Math.max(0, s);
  const m = Math.floor(v / 60);
  const sec = v - m * 60;
  return `${m}:${sec < 10 ? '0' : ''}${sec.toFixed(1)}`;
}
