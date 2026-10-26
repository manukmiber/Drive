// CORS for Zeiko S3 buckets (ADR-055): PutBucketCors / GetBucketCors / DeleteBucketCors, the
// browser's preflight (OPTIONS), and the Access-Control-* headers on real requests, following
// Amazon S3's rules: the first rule whose origin and method match wins, one "*" allowed in an
// origin or header pattern, at most 100 rules.
import type { Ctx } from '../context';
import { S3Error } from '../lib/s3-errors';
import { decodeXmlText, esc, xmlElements, xmlText } from '../lib/s3-xml';
import { ownBucket, type BucketRow } from './s3';

export const CORS_METHODS = ['GET', 'PUT', 'POST', 'DELETE', 'HEAD'] as const;
export type CorsMethod = (typeof CORS_METHODS)[number];
export const MAX_CORS_RULES = 100;

export interface CorsRule {
  id?: string;
  allowedOrigins: string[];
  allowedMethods: CorsMethod[];
  allowedHeaders: string[];
  exposeHeaders: string[];
  maxAgeSeconds?: number;
}

const bad = (message: string) => new S3Error('MalformedXML', message);

/** Checks rules the way Amazon does; returns them cleaned (trimmed, methods upper case). */
export function validateCors(rules: CorsRule[]): CorsRule[] {
  if (!rules.length) throw bad('A CORS configuration needs at least one CORSRule.');
  if (rules.length > MAX_CORS_RULES)
    throw bad(`A CORS configuration can have at most ${MAX_CORS_RULES} rules.`);
  return rules.map((r) => {
    const origins = r.allowedOrigins.map((o) => o.trim()).filter(Boolean);
    const methods = r.allowedMethods.map((m) => m.trim().toUpperCase());
    const headers = r.allowedHeaders.map((h) => h.trim()).filter(Boolean);
    const expose = r.exposeHeaders.map((h) => h.trim()).filter(Boolean);
    if (!origins.length || !methods.length)
      throw bad('Each CORSRule needs at least one AllowedOrigin and one AllowedMethod.');
    for (const m of methods)
      if (!(CORS_METHODS as readonly string[]).includes(m))
        throw new S3Error(
          'InvalidRequest',
          `Found unsupported HTTP method in CORS config. Unsupported method is ${m}`,
        );
    for (const o of origins)
      if (o.split('*').length > 2 || o.length > 1024)
        throw new S3Error(
          'InvalidRequest',
          `AllowedOrigin "${o}" can not have more than one wildcard.`,
        );
    for (const h of headers)
      if (h.split('*').length > 2 || h.length > 1024)
        throw new S3Error(
          'InvalidRequest',
          `AllowedHeader "${h}" can not have more than one wildcard.`,
        );
    if (
      r.maxAgeSeconds !== undefined &&
      (!Number.isInteger(r.maxAgeSeconds) || r.maxAgeSeconds < 0)
    )
      throw bad('MaxAgeSeconds must be a non-negative whole number.');
    const id = r.id?.trim().slice(0, 255);
    return {
      ...(id ? { id } : {}),
      allowedOrigins: [...new Set(origins)],
      allowedMethods: [...new Set(methods)] as CorsMethod[],
      allowedHeaders: [...new Set(headers)],
      exposeHeaders: [...new Set(expose)],
      ...(r.maxAgeSeconds !== undefined ? { maxAgeSeconds: r.maxAgeSeconds } : {}),
    };
  });
}

/** <CORSConfiguration> as clients send it (aws s3api put-bucket-cors, the SDKs, rclone). */
export function parseCorsXml(xml: string): CorsRule[] {
  if (!xmlElements(xml, 'CORSConfiguration').length)
    throw bad(
      'The XML you provided was not well-formed or did not validate against our published schema.',
    );
  const all = (block: string, tag: string) => xmlElements(block, tag).map(decodeXmlText);
  return validateCors(
    xmlElements(xml, 'CORSRule').map((r) => {
      const max = xmlText(r, 'MaxAgeSeconds');
      if (max !== null && !/^\d+$/.test(max.trim()))
        throw bad('MaxAgeSeconds must be a non-negative whole number.');
      const id = xmlText(r, 'ID');
      return {
        ...(id ? { id } : {}),
        allowedOrigins: all(r, 'AllowedOrigin'),
        allowedMethods: all(r, 'AllowedMethod') as CorsMethod[],
        allowedHeaders: all(r, 'AllowedHeader'),
        exposeHeaders: all(r, 'ExposeHeader'),
        ...(max !== null ? { maxAgeSeconds: Number(max.trim()) } : {}),
      };
    }),
  );
}

export function corsXml(rules: CorsRule[]): string {
  const many = (tag: string, vs: string[]) => vs.map((v) => `<${tag}>${esc(v)}</${tag}>`).join('');
  const body = rules
    .map(
      (r) =>
        `<CORSRule>${r.id ? `<ID>${esc(r.id)}</ID>` : ''}${many('AllowedHeader', r.allowedHeaders)}${many('AllowedMethod', r.allowedMethods)}${many('AllowedOrigin', r.allowedOrigins)}${many('ExposeHeader', r.exposeHeaders)}${r.maxAgeSeconds !== undefined ? `<MaxAgeSeconds>${r.maxAgeSeconds}</MaxAgeSeconds>` : ''}</CORSRule>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${body}</CORSConfiguration>`;
}

/** "https://*.example.com" against an origin; one "*" matches anything, case-insensitive for headers. */
function wild(pattern: string, value: string, caseless: boolean): boolean {
  const p = caseless ? pattern.toLowerCase() : pattern;
  const v = caseless ? value.toLowerCase() : value;
  const star = p.indexOf('*');
  if (star === -1) return p === v;
  const head = p.slice(0, star);
  const tail = p.slice(star + 1);
  return v.length >= head.length + tail.length && v.startsWith(head) && v.endsWith(tail);
}

export function parseCors(json: string | null): CorsRule[] | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as CorsRule[];
    return Array.isArray(v) && v.length ? v : null;
  } catch {
    return null;
  }
}

/**
 * The rule that allows this origin + method (+ the request headers a preflight names), or null.
 * Real requests pass no headers: only the origin and method decide, like Amazon.
 */
export function matchCors(
  rules: CorsRule[] | null,
  origin: string,
  method: string,
  requestHeaders: string[] = [],
): CorsRule | null {
  if (!rules) return null;
  for (const r of rules) {
    if (!r.allowedOrigins.some((o) => wild(o, origin, false))) continue;
    if (!(r.allowedMethods as string[]).includes(method.toUpperCase())) continue;
    if (!requestHeaders.every((h) => r.allowedHeaders.some((a) => wild(a, h, true)))) continue;
    return r;
  }
  return null;
}

/** Access-Control-* for a matched rule. `preflight` adds the method/header answers and max age. */
export function corsHeaders(
  rule: CorsRule,
  origin: string,
  preflight: { method: string; headers: string[] } | null,
): Headers {
  const anyOrigin = rule.allowedOrigins.includes('*');
  const h = new Headers({
    'Access-Control-Allow-Origin': anyOrigin ? '*' : origin,
    'Access-Control-Allow-Methods': rule.allowedMethods.join(', '),
    Vary: 'Origin, Access-Control-Request-Headers, Access-Control-Request-Method',
  });
  // A wildcard origin cannot come with credentials (the browser would refuse it anyway).
  if (!anyOrigin) h.set('Access-Control-Allow-Credentials', 'true');
  if (rule.exposeHeaders.length)
    h.set('Access-Control-Expose-Headers', rule.exposeHeaders.join(', '));
  if (preflight) {
    if (preflight.headers.length)
      h.set('Access-Control-Allow-Headers', preflight.headers.join(', '));
    if (rule.maxAgeSeconds !== undefined)
      h.set('Access-Control-Max-Age', String(rule.maxAgeSeconds));
  }
  return h;
}

/** Access-Control-Request-Headers → lower-case names. */
export function requestedHeaders(value: string | null): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function bucketCors(b: Pick<BucketRow, 'cors_json'>): CorsRule[] | null {
  return parseCors(b.cors_json ?? null);
}

/** Owner only. `null` removes the configuration. */
export async function setBucketCors(
  ctx: Ctx,
  userId: string,
  name: string,
  rules: CorsRule[] | null,
): Promise<CorsRule[] | null> {
  await ownBucket(ctx, userId, name);
  const clean = rules ? validateCors(rules) : null;
  await ctx.env.DB.prepare('UPDATE s3_buckets SET cors_json = ?3 WHERE name = ?1 AND user_id = ?2')
    .bind(name, userId, clean ? JSON.stringify(clean) : null)
    .run();
  return clean;
}

export async function getBucketCors(ctx: Ctx, userId: string, name: string) {
  return bucketCors(await ownBucket(ctx, userId, name));
}
