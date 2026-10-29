// Object tags for Zeiko S3 (S8, ADR-076): Put/Get/DeleteObjectTagging, x-amz-tagging on PutObject and
// CreateMultipartUpload, x-amz-tagging-directive on CopyObject, and lifecycle Tag filters. Amazon's
// limits: up to 10 tags, keys 1–128 and values 0–256 characters, keys unique, no "aws:" keys.
import { S3Error } from '../lib/s3-errors';
import { esc, xmlElements, xmlText } from '../lib/s3-xml';

export interface Tag {
  key: string;
  value: string;
}

export const MAX_TAGS = 10;
const MAX_KEY = 128;
const MAX_VALUE = 256;
/** Letters, numbers and spaces in any script, and + - = . _ : / @ (Amazon's tag character set). */
const ALLOWED = /^[\p{L}\p{M}\p{N}\p{Zs}+\-=._:/@]*$/u;

const invalid = (message: string) => new S3Error('InvalidTag', message);
const length = (s: string) => Array.from(s).length;

export function validateTags(tags: Tag[]): Tag[] {
  if (tags.length > MAX_TAGS) throw invalid(`Object tags cannot be greater than ${MAX_TAGS}`);
  const seen = new Set<string>();
  for (const t of tags) {
    if (!t.key || length(t.key) > MAX_KEY)
      throw invalid(`The TagKey you have provided is invalid (1 to ${MAX_KEY} characters).`);
    if (length(t.value) > MAX_VALUE)
      throw invalid(
        `The TagValue you have provided is too long (at most ${MAX_VALUE} characters).`,
      );
    if (!ALLOWED.test(t.key) || !ALLOWED.test(t.value))
      throw invalid(
        'The TagKey or TagValue you have provided has characters that are not allowed.',
      );
    if (t.key.toLowerCase().startsWith('aws:'))
      throw invalid('System tags cannot be added/updated by requester');
    if (seen.has(t.key)) throw invalid('Cannot provide multiple Tags with the same key');
    seen.add(t.key);
  }
  return tags;
}

/** `x-amz-tagging: k1=v1&k2=v2` (URL-encoded, like a query string); null when absent. */
export function tagsFromHeader(v: string | null): Tag[] | null {
  if (v === null) return null;
  const out: Tag[] = [];
  for (const pair of v.split('&')) {
    if (!pair) continue;
    const at = pair.indexOf('=');
    const raw = (s: string) => {
      try {
        return decodeURIComponent(s.replace(/\+/g, ' '));
      } catch {
        throw new S3Error('InvalidArgument', 'The header x-amz-tagging is not well formed.');
      }
    };
    out.push(
      at < 0
        ? { key: raw(pair), value: '' }
        : { key: raw(pair.slice(0, at)), value: raw(pair.slice(at + 1)) },
    );
  }
  return validateTags(out);
}

/** The <Tag> elements of a fragment (a TagSet, or a lifecycle Filter/And). */
export function tagElements(xml: string): Tag[] {
  return xmlElements(xml, 'Tag').map((t) => {
    const key = xmlText(t, 'Key');
    if (key === null)
      throw new S3Error(
        'MalformedXML',
        'The XML you provided was not well-formed or did not validate against our published schema.',
      );
    return { key, value: xmlText(t, 'Value') ?? '' };
  });
}

/** PutObjectTagging's body: <Tagging><TagSet><Tag><Key/><Value/></Tag>…</TagSet></Tagging>. */
export function tagsFromXml(xml: string): Tag[] {
  const root = xmlElements(xml, 'Tagging')[0];
  const set = root === undefined ? undefined : xmlElements(root, 'TagSet')[0];
  if (set === undefined)
    throw new S3Error(
      'MalformedXML',
      'The XML you provided was not well-formed or did not validate against our published schema.',
    );
  return validateTags(tagElements(set));
}

export function tagXml(t: Tag): string {
  return `<Tag><Key>${esc(t.key)}</Key><Value>${esc(t.value)}</Value></Tag>`;
}

export function taggingXml(tags: Tag[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Tagging xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><TagSet>${tags.map(tagXml).join('')}</TagSet></Tagging>`;
}

/** Stored form: `[[key, value], …]`; null for none. */
export function tagsJson(tags: Tag[] | null | undefined): string | null {
  return tags?.length ? JSON.stringify(tags.map((t) => [t.key, t.value])) : null;
}

export function parseTags(json: string | null | undefined): Tag[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    if (!Array.isArray(v)) return [];
    return v
      .filter((p): p is [string, string] => Array.isArray(p) && typeof p[0] === 'string')
      .map(([key, value]) => ({ key, value: typeof value === 'string' ? value : '' }));
  } catch {
    return [];
  }
}

/** True when the object carries every one of `wanted` (a lifecycle Tag filter). */
export function hasTags(json: string | null | undefined, wanted: Tag[]): boolean {
  if (!wanted.length) return true;
  const have = new Map(parseTags(json).map((t) => [t.key, t.value]));
  return wanted.every((t) => have.get(t.key) === t.value);
}
