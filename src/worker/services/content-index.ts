// D6 (ADR-090): the text inside files, for "search file contents". One object per space next to its
// index — `u/{userId}/text.txt`, `f/{familyId}/text.txt` — never D1 (ADR-064). Line 1 is a JSON
// header; every other line is one file, `[id, content, "text"]`, where `content` is the id of the
// content the text was taken from: text of content that has since been replaced never shows, and
// goes on the next write. Written with R2's etag condition and retried, like the index.
import type { DriveTree } from '../../shared/drive-tree';
import {
  searchWords,
  termMatches,
  type ParsedSearch,
  type SearchTerm,
} from '../../shared/search-query';
import type { Ctx } from '../context';
import { AppError } from '../lib/errors';
import { isRateLimited, type IndexOwner } from './drive-index';

export function textKey(owner: IndexOwner): string {
  return 'user' in owner ? `u/${owner.user}/text.txt` : `f/${owner.family}/text.txt`;
}

export interface TextLine {
  content: string;
  text: string;
  /** The text has letters outside ASCII (accents, other scripts): matched by splitting it into words. */
  wide: boolean;
}

// eslint-disable-next-line no-control-regex
const NOT_ASCII = /[^\x00-\x7f]/;

/** A line for a text, its ASCII-ness worked out once here rather than on every search. */
export function textLine(content: string, text: string): TextLine {
  return { content, text, wide: NOT_ASCII.test(text) };
}

const HEAD = '{"v":1}';

export function parseTexts(body: string): Map<string, TextLine> {
  const out = new Map<string, TextLine>();
  const lines = body.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    try {
      const v = JSON.parse(l) as unknown;
      if (
        Array.isArray(v) &&
        typeof v[0] === 'string' &&
        typeof v[1] === 'string' &&
        typeof v[2] === 'string'
      )
        out.set(v[0], { content: v[1], text: v[2], wide: v[3] === 1 });
    } catch {
      // A broken line is one file's text, not worth refusing the rest for.
    }
  }
  return out;
}

export function textsBody(map: Map<string, TextLine>): string {
  let out = HEAD;
  for (const [id, l] of map)
    out += `\n${JSON.stringify(l.wide ? [id, l.content, l.text, 1] : [id, l.content, l.text])}`;
  return `${out}\n`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Reads a space's texts, lets `change` edit them, and writes them back when it says so (true),
 * retrying on a lost race or R2's one-write-a-second-per-key limit. `change` may run more than once.
 */
export async function changeTexts(
  bucket: R2Bucket,
  owner: IndexOwner,
  change: (map: Map<string, TextLine>) => boolean | Promise<boolean>,
  attempts = 12,
): Promise<void> {
  const key = textKey(owner);
  for (let attempt = 1; ; attempt++) {
    const obj = await bucket.get(key);
    const map = obj ? parseTexts(await obj.text()) : new Map<string, TextLine>();
    if (!(await change(map))) return;
    let limited = false;
    try {
      const put = map.size
        ? await bucket.put(key, textsBody(map), {
            httpMetadata: { contentType: 'text/plain; charset=utf-8', cacheControl: 'no-store' },
            onlyIf: obj ? { etagMatches: obj.etag } : new Headers({ 'if-none-match': '*' }),
          })
        : obj
          ? (await bucket.delete(key), true)
          : true;
      if (put) return;
    } catch (e) {
      if (!isRateLimited(e)) throw e;
      limited = true;
    }
    if (attempt >= attempts)
      throw new AppError('INDEX_BUSY', 'The search text is busy, try again', { index: key });
    await sleep((limited ? 1000 : Math.min(150 * attempt, 1000)) + Math.floor(Math.random() * 250));
  }
}

/** The content id a tree gives a file (the last part of its R2 key), as texts are keyed. */
export function contentIdOf(tree: DriveTree, id: string): string | null {
  const c = tree.contentOf(id);
  if (c === null) return null;
  const s = String(c);
  return s.slice(s.lastIndexOf('/') + 1);
}

export interface TextInput {
  id: string;
  text: string;
}

/**
 * Puts texts for files of one space (the caller checked the right to edit each), dropping lines of
 * files that are gone from the tree or whose content changed. Refuses past the space's cap.
 */
export async function putTexts(
  ctx: Ctx,
  owner: IndexOwner,
  tree: DriveTree,
  items: TextInput[],
): Promise<{ stored: number }> {
  const cfg = await ctx.config();
  let stored = 0;
  await changeTexts(ctx.env.BUCKET, owner, (map) => {
    stored = 0;
    let changed = false;
    for (const [id, l] of map)
      if (contentIdOf(tree, id) !== l.content) {
        map.delete(id);
        changed = true;
      }
    for (const it of items) {
      const content = contentIdOf(tree, it.id);
      if (!content) continue;
      const text = it.text.slice(0, cfg.content_text_max_chars);
      const old = map.get(it.id);
      if (old && old.content === content && old.text === text) continue;
      map.set(it.id, textLine(content, text));
      stored++;
      changed = true;
    }
    if (changed && textsBody(map).length > cfg.content_index_max_bytes)
      throw new AppError('CONFLICT', 'the search text of this space is full', {
        reason: 'CONTENT_INDEX_FULL',
        maxBytes: cfg.content_index_max_bytes,
      });
    return changed;
  });
  return { stored };
}

/** Drops the lines of these files (deleted for good, or new content). No object, nothing to do. */
export async function forgetTexts(
  ctx: Ctx,
  owner: IndexOwner,
  ids: readonly string[],
): Promise<void> {
  if (!ids.length) return;
  const head = await ctx.env.BUCKET.head(textKey(owner));
  if (!head) return;
  await changeTexts(ctx.env.BUCKET, owner, (map) => {
    let changed = false;
    for (const id of ids) changed = map.delete(id) || changed;
    return changed;
  });
}

/** Which files of a space have current text (for "Index again": the rest still need it). */
export async function textedIds(
  ctx: Ctx,
  owner: IndexOwner,
  tree: DriveTree,
): Promise<Set<string>> {
  const obj = await ctx.env.BUCKET.get(textKey(owner));
  if (!obj) return new Set();
  const out = new Set<string>();
  for (const [id, l] of parseTexts(await obj.text()))
    if (contentIdOf(tree, id) === l.content) out.add(id);
  return out;
}

export interface ContentHit {
  id: string;
  snippet: string;
  /** [start, end) ranges of the snippet to highlight. */
  ranges: Array<[number, number]>;
}

const SNIPPET = 140;

/** Where in a text the words are, folded like names are (no accents, lower case). */
function snippetOf(
  text: string,
  p: ParsedSearch,
): { snippet: string; ranges: Array<[number, number]> } {
  const wanted = p.groups.flat().flatMap((t) => t.words);
  const re = /[\p{L}\p{N}]+/gu;
  let first = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const w = searchWords(m[0])[0] ?? '';
    if (wanted.some((q) => (p.match === 'word' ? w === q : w.startsWith(q)))) {
      first = m.index;
      break;
    }
  }
  const start = Math.max(0, first - 40);
  let piece = text.slice(start, start + SNIPPET).replace(/\s+/g, ' ');
  const lead = start > 0 ? '…' : '';
  const tail = start + SNIPPET < text.length ? '…' : '';
  piece = `${lead}${piece}${tail}`;
  const ranges: Array<[number, number]> = [];
  const re2 = /[\p{L}\p{N}]+/gu;
  while ((m = re2.exec(piece))) {
    const w = searchWords(m[0])[0] ?? '';
    const q = wanted.find((x) => (p.match === 'word' ? w === x : w.startsWith(x)));
    if (q)
      ranges.push([
        m.index,
        m.index + (p.match === 'word' ? m[0].length : Math.min(m[0].length, q.length)),
      ]);
  }
  return { snippet: piece, ranges };
}

/**
 * Files of a space whose text matches the query's words (all groups, no exclusions), with a
 * snippet each. Cheap first: a line is only split into words when every group's first letters
 * occur in it.
 */
export async function searchTexts(
  ctx: Ctx,
  owner: IndexOwner,
  tree: DriveTree,
  p: ParsedSearch,
  limit = 200,
): Promise<ContentHit[]> {
  if (!p.groups.length) return [];
  const res = termRegexes(p);
  const obj = await ctx.env.BUCKET.get(textKey(owner));
  if (!obj) return [];
  const out: ContentHit[] = [];
  for (const [id, l] of parseTexts(await obj.text())) {
    if (contentIdOf(tree, id) !== l.content) continue;
    if (!textMatches(l.text, l.wide, p, res)) continue;
    out.push({ id, ...snippetOf(l.text, p) });
    if (out.length >= limit) break;
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A term as one regex over lower-case ASCII text: no need to split the text into words. */
function termRegex(t: SearchTerm, match: 'prefix' | 'word'): RegExp {
  const ws = t.words.map(escapeRe);
  const sep = t.phrase ? '[^a-z0-9]+' : null;
  const end = match === 'word' ? '(?![a-z0-9])' : '';
  if (sep) {
    const last = ws.length - 1;
    const body = ws
      .map((w, i) => `${w}${i < last || match === 'word' ? '(?![a-z0-9])' : ''}`)
      .join(sep);
    return new RegExp(`(?<![a-z0-9])${body}`);
  }
  // Loose words: each must appear (checked one by one), so this regex is for one word.
  return new RegExp(`(?<![a-z0-9])${ws[0]}${end}`);
}

interface TermTest {
  term: SearchTerm;
  res: RegExp[];
}

export function termRegexes(p: ParsedSearch): { groups: TermTest[][]; exclude: TermTest[] } {
  const one = (t: SearchTerm): TermTest => ({
    term: t,
    res: t.phrase
      ? [termRegex(t, p.match)]
      : t.words.map((w) => termRegex({ raw: w, words: [w], phrase: false }, p.match)),
  });
  return { groups: p.groups.map((g) => g.map(one)), exclude: p.exclude.map(one) };
}

/**
 * Whether a file's text answers the query: plain ASCII text by regex on its lower case (fast);
 * text with other letters by splitting it into search words, the way names are matched.
 */
export function textMatches(
  text: string,
  wide: boolean,
  p: ParsedSearch,
  res: ReturnType<typeof termRegexes>,
): boolean {
  if (!wide) {
    const lower = text.toLowerCase();
    // `includes` first: most lines miss, and it is cheaper than the regex.
    const hit = (t: TermTest) =>
      t.term.words.every((w) => lower.includes(w)) && t.res.every((r) => r.test(lower));
    return res.groups.every((g) => g.some(hit)) && !res.exclude.some(hit);
  }
  const have = searchWords(text);
  return (
    p.groups.every((g) => g.some((t) => termMatches(have, t, p.match))) &&
    !p.exclude.some((t) => termMatches(have, t, p.match))
  );
}

/** Everything a space's texts hold, for the person's data export. */
export async function exportTexts(ctx: Ctx, owner: IndexOwner): Promise<Array<[string, string]>> {
  const obj = await ctx.env.BUCKET.get(textKey(owner));
  if (!obj) return [];
  return [...parseTexts(await obj.text())].map(([id, l]) => [id, l.text]);
}
