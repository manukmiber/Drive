// D6 (ADR-090): the search box's syntax, read the same way by the Worker and the app. Keywords come
// in Indonesian and English. Nothing here can fail: an unknown key is a plain word, a bad value is
// dropped and named in `warnings`.
import type { DriveTypeFilter } from './drive-tree';

export type SearchDateField = 'modified' | 'created' | 'taken';

export interface SearchTerm {
  /** As typed (for highlighting and putting the query back together). */
  raw: string;
  /** Its search words: letters and digits, lower case, accents removed. */
  words: string[];
  phrase: boolean;
}

export interface ParsedSearch {
  /** Every group must match; a group matches when any of its terms does (OR). */
  groups: SearchTerm[][];
  exclude: SearchTerm[];
  types: DriveTypeFilter[];
  exts: string[];
  dateField: SearchDateField;
  /** ms, inclusive. */
  after: number | null;
  /** ms, exclusive. */
  before: number | null;
  /** bytes, inclusive. */
  minSize: number | null;
  maxSize: number | null;
  inFolder: string | null;
  space: 'personal' | 'family' | null;
  starred: boolean;
  shared: boolean;
  match: 'prefix' | 'word';
  sort: 'relevance' | 'date';
  warnings: string[];
}

/** Search words the way names have always been searched: letters and digits, no accents. */
export function searchWords(s: string): string[] {
  return s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

const TYPE_WORDS: Record<string, DriveTypeFilter> = {
  gambar: 'image',
  image: 'image',
  images: 'image',
  foto: 'image',
  photo: 'image',
  photos: 'image',
  video: 'video',
  videos: 'video',
  audio: 'audio',
  musik: 'audio',
  music: 'audio',
  lagu: 'audio',
  pdf: 'pdf',
  dokumen: 'document',
  document: 'document',
  documents: 'document',
  doc: 'document',
  docs: 'document',
  arsip: 'archive',
  archive: 'archive',
  zip: 'archive',
  folder: 'folder',
  folders: 'folder',
  map: 'folder',
};

const KEYS: Record<string, string> = {
  jenis: 'type',
  type: 'type',
  tipe: 'type',
  ext: 'ext',
  ekstensi: 'ext',
  setelah: 'after',
  after: 'after',
  sejak: 'after',
  sebelum: 'before',
  before: 'before',
  tanggal: 'date',
  date: 'date',
  ukuran: 'size',
  size: 'size',
  di: 'in',
  in: 'in',
  ruang: 'space',
  space: 'space',
  cocok: 'match',
  match: 'match',
  urut: 'sort',
  sort: 'sort',
  is: 'is',
  adalah: 'is',
};

const FLAGS: Record<string, 'starred' | 'shared'> = {
  berbintang: 'starred',
  starred: 'starred',
  bintang: 'starred',
  dibagikan: 'shared',
  shared: 'shared',
};

const DATE_FIELDS: Record<string, SearchDateField> = {
  diubah: 'modified',
  modified: 'modified',
  dibuat: 'created',
  created: 'created',
  diambil: 'taken',
  taken: 'taken',
};

const SPACES: Record<string, 'personal' | 'family'> = {
  pribadi: 'personal',
  personal: 'personal',
  saya: 'personal',
  mine: 'personal',
  keluarga: 'family',
  family: 'family',
};

/** WIB, the time zone the app shows dates in (ADR-008: times are UTC ms). */
const WIB_MS = 7 * 3600_000;

/** Start of a year, month or day in WIB, and the start of the period after it. */
export function datePeriod(v: string): { start: number; end: number } | null {
  const m = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(v.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = m[2] ? Number(m[2]) : null;
  const d = m[3] ? Number(m[3]) : null;
  if (y < 1970 || y > 9999 || (mo !== null && (mo < 1 || mo > 12))) return null;
  if (d !== null) {
    const start = Date.UTC(y, mo! - 1, d);
    if (new Date(start).getUTCDate() !== d) return null;
    return { start: start - WIB_MS, end: start + 86_400_000 - WIB_MS };
  }
  if (mo !== null)
    return { start: Date.UTC(y, mo - 1, 1) - WIB_MS, end: Date.UTC(y, mo, 1) - WIB_MS };
  return { start: Date.UTC(y, 0, 1) - WIB_MS, end: Date.UTC(y + 1, 0, 1) - WIB_MS };
}

const UNITS: Record<string, number> = {
  b: 1,
  kb: 1024,
  k: 1024,
  mb: 1024 ** 2,
  m: 1024 ** 2,
  gb: 1024 ** 3,
  g: 1024 ** 3,
  tb: 1024 ** 4,
};

/** `>10mb`, `<=1,5gb`, `500kb`: the bound and which side. */
export function sizeBound(v: string): { op: '>' | '<' | '>=' | '<='; bytes: number } | null {
  const m = /^(>=|<=|>|<)?\s*(\d+(?:[.,]\d+)?)\s*([a-z]*)$/i.exec(v.trim());
  if (!m) return null;
  const unit = UNITS[(m[3] || 'b').toLowerCase()];
  if (!unit) return null;
  const bytes = Math.round(Number(m[2]!.replace(',', '.')) * unit);
  if (!Number.isFinite(bytes)) return null;
  return { op: (m[1] as '>' | '<' | '>=' | '<=' | undefined) ?? '>=', bytes };
}

interface Token {
  negate: boolean;
  quoted: boolean;
  key: string | null;
  value: string;
}

function tokenize(q: string): Token[] {
  const out: Token[] = [];
  const s = q.slice(0, 500);
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (i >= s.length) break;
    let negate = false;
    if (s[i] === '-' && i + 1 < s.length && !/\s/.test(s[i + 1]!)) {
      negate = true;
      i++;
    }
    let key: string | null = null;
    const keyMatch = /^([\p{L}]+):(?=\S)/u.exec(s.slice(i));
    if (keyMatch && KEYS[keyMatch[1]!.toLowerCase()]) {
      key = keyMatch[1]!.toLowerCase();
      i += keyMatch[0].length;
    }
    if (s[i] === '"') {
      const end = s.indexOf('"', i + 1);
      const value = end === -1 ? s.slice(i + 1) : s.slice(i + 1, end);
      i = end === -1 ? s.length : end + 1;
      out.push({ negate, quoted: true, key, value });
      continue;
    }
    let j = i;
    while (j < s.length && !/\s/.test(s[j]!)) j++;
    out.push({ negate, quoted: false, key, value: s.slice(i, j) });
    i = j;
  }
  return out;
}

export function emptySearch(): ParsedSearch {
  return {
    groups: [],
    exclude: [],
    types: [],
    exts: [],
    dateField: 'modified',
    after: null,
    before: null,
    minSize: null,
    maxSize: null,
    inFolder: null,
    space: null,
    starred: false,
    shared: false,
    match: 'prefix',
    sort: 'relevance',
    warnings: [],
  };
}

/** Reads a search box's text. */
export function parseSearch(q: string): ParsedSearch {
  const p = emptySearch();
  let orNext = false;
  for (const t of tokenize(q)) {
    const key = t.key ? KEYS[t.key]! : null;
    const v = t.value.trim();
    if (!key) {
      if (!t.quoted && !t.negate && (v === 'OR' || v === 'ATAU')) {
        if (p.groups.length) orNext = true;
        continue;
      }
      const flag = !t.quoted && !t.negate ? FLAGS[v.toLowerCase()] : undefined;
      if (flag) {
        p[flag] = true;
        continue;
      }
      const words = searchWords(v);
      if (!words.length) continue;
      const term: SearchTerm = { raw: v, words, phrase: t.quoted && words.length > 1 };
      if (t.negate) p.exclude.push(term);
      else if (orNext && p.groups.length) p.groups[p.groups.length - 1]!.push(term);
      else p.groups.push([term]);
      orNext = false;
      continue;
    }
    orNext = false;
    const lower = v.toLowerCase();
    switch (key) {
      case 'type': {
        const ty = TYPE_WORDS[lower];
        if (ty) {
          if (!p.types.includes(ty)) p.types.push(ty);
        } else p.warnings.push(`${t.key}:${v}`);
        break;
      }
      case 'ext': {
        const e = lower.replace(/^\./, '');
        if (/^[a-z0-9]{1,10}$/.test(e)) {
          if (!p.exts.includes(e)) p.exts.push(e);
        } else p.warnings.push(`${t.key}:${v}`);
        break;
      }
      case 'after':
      case 'before': {
        const period = datePeriod(v);
        if (!period) p.warnings.push(`${t.key}:${v}`);
        else if (key === 'after') p.after = period.start;
        else p.before = period.start;
        break;
      }
      case 'date': {
        const f = DATE_FIELDS[lower];
        if (f) p.dateField = f;
        else p.warnings.push(`${t.key}:${v}`);
        break;
      }
      case 'size': {
        const b = sizeBound(v);
        if (!b) p.warnings.push(`${t.key}:${v}`);
        else if (b.op === '>') p.minSize = b.bytes + 1;
        else if (b.op === '>=') p.minSize = b.bytes;
        else if (b.op === '<') p.maxSize = Math.max(0, b.bytes - 1);
        else p.maxSize = b.bytes;
        break;
      }
      case 'in':
        if (v) p.inFolder = v.slice(0, 200);
        break;
      case 'space': {
        const s = SPACES[lower];
        if (s) p.space = s;
        else p.warnings.push(`${t.key}:${v}`);
        break;
      }
      case 'match':
        if (lower === 'kata' || lower === 'word') p.match = 'word';
        else if (lower === 'awalan' || lower === 'prefix') p.match = 'prefix';
        else p.warnings.push(`${t.key}:${v}`);
        break;
      case 'sort':
        if (lower === 'tanggal' || lower === 'date' || lower === 'terbaru' || lower === 'newest')
          p.sort = 'date';
        else if (lower === 'relevan' || lower === 'relevance') p.sort = 'relevance';
        else p.warnings.push(`${t.key}:${v}`);
        break;
      case 'is': {
        const flag = FLAGS[lower];
        if (flag) p[flag] = true;
        else p.warnings.push(`${t.key}:${v}`);
        break;
      }
    }
  }
  // At most 8 groups of at most 4 alternatives, like the old 8 words.
  p.groups = p.groups.slice(0, 8).map((g) => g.slice(0, 4));
  p.exclude = p.exclude.slice(0, 8);
  return p;
}

/** True when the query asks for anything at all (words or a filter). */
export function hasCriteria(p: ParsedSearch): boolean {
  return Boolean(
    p.groups.length ||
    p.types.length ||
    p.exts.length ||
    p.after !== null ||
    p.before !== null ||
    p.minSize !== null ||
    p.maxSize !== null ||
    p.inFolder ||
    p.space ||
    p.starred ||
    p.shared,
  );
}

const quote = (v: string) => (/[\s"]/.test(v) || !v ? `"${v.replace(/"/g, '')}"` : v);

function dateText(ms: number): string {
  const d = new Date(ms + WIB_MS);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function sizeText(bytes: number): string {
  for (const [unit, n] of [
    ['gb', 1024 ** 3],
    ['mb', 1024 ** 2],
    ['kb', 1024],
  ] as const)
    if (bytes >= n && bytes % n === 0) return `${bytes / n}${unit}`;
  return `${bytes}b`;
}

const REVERSE_TYPE: Record<DriveTypeFilter, string> = {
  image: 'gambar',
  video: 'video',
  audio: 'audio',
  pdf: 'pdf',
  document: 'dokumen',
  archive: 'arsip',
  folder: 'folder',
};

/**
 * The search box text for a parsed query (the filter panel edits a ParsedSearch and writes this).
 * Indonesian keywords: both languages read them.
 */
export function toQuery(p: ParsedSearch): string {
  const out: string[] = [];
  for (const g of p.groups)
    out.push(g.map((t) => (t.phrase ? `"${t.raw}"` : quote(t.raw))).join(' ATAU '));
  for (const t of p.exclude) out.push(`-${t.phrase ? `"${t.raw}"` : quote(t.raw)}`);
  for (const ty of p.types) out.push(`jenis:${REVERSE_TYPE[ty]}`);
  for (const e of p.exts) out.push(`ext:${e}`);
  if (p.dateField !== 'modified' && (p.after !== null || p.before !== null))
    out.push(`tanggal:${p.dateField === 'created' ? 'dibuat' : 'diambil'}`);
  if (p.after !== null) out.push(`setelah:${dateText(p.after)}`);
  if (p.before !== null) out.push(`sebelum:${dateText(p.before)}`);
  if (p.minSize !== null) out.push(`ukuran:>=${sizeText(p.minSize)}`);
  if (p.maxSize !== null) out.push(`ukuran:<=${sizeText(p.maxSize)}`);
  if (p.inFolder) out.push(`di:${quote(p.inFolder)}`);
  if (p.space) out.push(`ruang:${p.space === 'personal' ? 'pribadi' : 'keluarga'}`);
  if (p.starred) out.push('berbintang');
  if (p.shared) out.push('dibagikan');
  if (p.match === 'word') out.push('cocok:kata');
  if (p.sort === 'date') out.push('urut:tanggal');
  return out.join(' ');
}

/** Does a list of words contain this term (prefix or whole-word, phrase = consecutive words)? */
export function termMatches(have: string[], term: SearchTerm, match: 'prefix' | 'word'): boolean {
  const eq = (w: string, q: string, last: boolean) =>
    match === 'word' ? w === q : last || !term.phrase ? w.startsWith(q) : w === q;
  if (!term.phrase) return term.words.every((q) => have.some((w) => eq(w, q, true)));
  const n = term.words.length;
  for (let i = 0; i + n <= have.length; i++) {
    let ok = true;
    for (let k = 0; k < n && ok; k++) ok = eq(have[i + k]!, term.words[k]!, k === n - 1);
    if (ok) return true;
  }
  return false;
}

/** Whether a name (or any text) matches the query's words and exclusions. */
export function wordsMatch(text: string, p: ParsedSearch): boolean {
  const have = searchWords(text);
  return (
    p.groups.every((g) => g.some((t) => termMatches(have, t, p.match))) &&
    !p.exclude.some((t) => termMatches(have, t, p.match))
  );
}

/**
 * Where the query's words are in a name, as [start, end) character ranges of the original text,
 * for highlighting. Accents are ignored the way matching ignores them.
 */
export function highlightRanges(text: string, p: ParsedSearch): Array<[number, number]> {
  const wanted = p.groups.flat().flatMap((t) => t.words);
  if (!wanted.length) return [];
  const out: Array<[number, number]> = [];
  const re = /[\p{L}\p{N}]+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const w = searchWords(m[0])[0] ?? '';
    for (const q of wanted) {
      if (p.match === 'word' ? w === q : w.startsWith(q)) {
        // Highlight the matched prefix only; one character of the original per character of w.
        const len = p.match === 'word' ? m[0].length : Math.min(m[0].length, q.length);
        out.push([m.index, m.index + len]);
        break;
      }
    }
  }
  return out;
}
