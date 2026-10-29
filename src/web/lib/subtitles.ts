// Subtitles for the video preview (D13): .srt/.vtt files next to the video, turned into WebVTT in
// the browser and attached as a <track> through a blob: URL, so nothing about the file leaves the page.

const SUB_EXT = /\.(srt|vtt)$/i;

export const isSubtitleName = (name: string): boolean => SUB_EXT.test(name);

const baseOf = (name: string) => name.replace(/\.[^.]*$/, '');

/**
 * How well `sub` belongs to the video `video`: 2 = same base name ("Film.srt" for "Film.mp4"),
 * 1 = base name plus a tag ("Film.id.srt", "Film.en.forced.srt"), 0 = not related.
 */
export function subtitleMatch(video: string, sub: string): 0 | 1 | 2 {
  if (!isSubtitleName(sub)) return 0;
  const v = baseOf(video).toLowerCase();
  const s = baseOf(sub).toLowerCase();
  if (s === v) return 2;
  return s.startsWith(`${v}.`) ? 1 : 0;
}

/** The tag after the video's base name ("id", "en.forced"), or the subtitle's base name. */
export function subtitleLabel(video: string, sub: string): string {
  const v = baseOf(video);
  const s = baseOf(sub);
  return subtitleMatch(video, sub) === 1 ? s.slice(v.length + 1) : s;
}

/**
 * Bytes → text. A BOM decides; otherwise strict UTF-8, and old Windows files (the usual .srt from
 * the internet) fall back to Windows-1252.
 */
export function decodeSubtitle(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

// "01:02:03,456", "1:02:03.4", "02:03,456" (no hours) → milliseconds.
const TIME = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?$/;

function parseTime(s: string): number | null {
  const m = TIME.exec(s.trim());
  if (!m) return null;
  const [, h = '0', min, sec, frac = '0'] = m;
  if (Number(min) > 59 || Number(sec) > 59) return null;
  const ms = Number(frac.padEnd(3, '0'));
  return ((Number(h) * 60 + Number(min)) * 60 + Number(sec)) * 1000 + ms;
}

function vttTime(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms % 1000, 3)}`;
}

/**
 * SRT cue text → WebVTT cue text: <b>/<i>/<u> stay, other tags (<font color>) and ASS overrides
 * ({\an8}) go, a stray "&" or "<" is escaped, and "-->" can't end the cue early.
 */
function cueText(line: string): string {
  return line
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/<(?!\/?(?:b|i|u)>)\/?[a-z][^<>]*>/gi, '')
    .replace(/&(?![a-z]+;|#\d+;|#x[0-9a-f]+;)/gi, '&amp;')
    .replace(/<(?!\/?(?:b|i|u)>)/gi, '&lt;')
    .replace(/-->/g, '→');
}

/** SubRip → WebVTT. Blocks that aren't cues are skipped rather than failing the whole file. */
export function srtToVtt(text: string): string {
  const blocks = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/);
  const cues: string[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim());
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0 || at > 1) continue;
    const [from, rest = ''] = lines[at]!.split('-->');
    // Anything after the end time (SRT's "X1:… Y1:…" box) isn't WebVTT.
    const start = parseTime(from!);
    const end = parseTime(rest.trim().split(/\s+/)[0] ?? '');
    if (start === null || end === null || end < start) continue;
    const body = lines
      .slice(at + 1)
      .map(cueText)
      .filter((l) => l.trim());
    if (!body.length) continue;
    cues.push(`${vttTime(start)} --> ${vttTime(end)}\n${body.join('\n')}`);
  }
  return `WEBVTT\n\n${cues.join('\n\n')}${cues.length ? '\n' : ''}`;
}

/** Any subtitle file → WebVTT text. A .vtt is kept (a missing header is added), anything else is SRT. */
export function toVtt(name: string, bytes: Uint8Array): string {
  const text = decodeSubtitle(bytes).replace(/^\uFEFF/, '');
  if (/^WEBVTT(?:[ \t]|\r?\n|$)/.test(text)) return text.replace(/\r\n?/g, '\n');
  if (/\.vtt$/i.test(name) && !/^\s*\d+\s*\r?\n\s*[\d:,.]+\s*-->/.test(text))
    return `WEBVTT\n\n${text.replace(/\r\n?/g, '\n')}`;
  return srtToVtt(text);
}

export type SubtitleSize = 'sm' | 'md' | 'lg';
const SIZE_KEY = 'zk_sub_size';

export function loadSubtitleSize(): SubtitleSize {
  try {
    const v = localStorage.getItem(SIZE_KEY);
    return v === 'sm' || v === 'lg' ? v : 'md';
  } catch {
    return 'md';
  }
}

export function saveSubtitleSize(size: SubtitleSize): void {
  try {
    localStorage.setItem(SIZE_KEY, size);
  } catch {
    // Private mode: the choice lasts for this preview only.
  }
}
