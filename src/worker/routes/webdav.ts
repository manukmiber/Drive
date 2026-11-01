// The WebDAV host (D9, ADR-089): HTTP Basic with the account's email and an access token that has
// the `webdav` scope. No cookie is ever read here, and nothing of the app (Origin, CSRF, sessions)
// is mixed in. The logic is services/webdav.ts.
import type { Ctx } from '../context';
import type { Env } from '../env';
import {
  child,
  DAV_XML_MAX_BYTES,
  davError,
  parseXml,
  XmlError,
  type XmlNode,
} from '../lib/dav-xml';
import { isAppError } from '../lib/errors';
import { log, securityEvent } from '../lib/log';
import { clientIp, enforceRateLimit } from '../middleware/ratelimit';
import { authenticateToken, TOKEN_RE } from '../services/tokens';
import {
  copyFailures,
  davCopy,
  DavError,
  davDelete,
  davGetFile,
  davHref,
  davListing,
  davMkcol,
  davMove,
  davProppatch,
  davPut,
  davStatusOf,
  lockBody,
  lockOwner,
  propfind,
  propRequestOf,
  resolveDav,
  splitDavPath,
  type DavTarget,
} from '../services/webdav';
import { driveTree, type DriveSpace } from '../services/drive-read';

export function isDavHost(url: URL, env: Pick<Env, 'DAV_ORIGIN'>): boolean {
  if (!env.DAV_ORIGIN) return false;
  return url.host.toLowerCase() === new URL(env.DAV_ORIGIN).host.toLowerCase();
}

const METHODS =
  'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK';
const REALM = 'Basic realm="Zeiko Drive", charset="UTF-8"';

const BASE_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
};

function text(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body ? `${body}\n` : null, {
    status,
    headers: { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', ...extra },
  });
}

function xml(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { ...BASE_HEADERS, 'Content-Type': 'application/xml; charset=utf-8', ...extra },
  });
}

function empty(status: number, extra: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { ...BASE_HEADERS, ...extra } });
}

const unauthorized = (why: string) => text(401, why, { 'WWW-Authenticate': REALM });

/** The email and token of `Authorization: Basic …`, or just the token of `Bearer …`. */
function credentials(header: string | null): { user: string | null; token: string } | null {
  if (!header) return null;
  const bearer = /^Bearer\s+(\S+)$/i.exec(header);
  if (bearer) return { user: null, token: bearer[1]! };
  const basic = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header);
  if (!basic) return null;
  let decoded: string;
  try {
    const bytes = Uint8Array.from(atob(basic[1]!), (ch) => ch.charCodeAt(0));
    decoded = new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
  const colon = decoded.indexOf(':');
  if (colon === -1) return null;
  return { user: decoded.slice(0, colon).trim(), token: decoded.slice(colon + 1).trim() };
}

async function signIn(ctx: Ctx, req: Request): Promise<{ userId: string } | Response> {
  const creds = credentials(req.headers.get('authorization'));
  if (!creds) return unauthorized('Sign in with your Zeiko account email and an access token.');
  const refuse = async (why: string) => {
    securityEvent('authn_failure', { what: 'webdav' });
    await enforceRateLimit(ctx.env, 'RL_AUTH', `dav-fail:${clientIp(req)}`);
    return unauthorized(why);
  };
  if (!TOKEN_RE.test(creds.token))
    return refuse('The password is an access token (zkd_…) made in Drive → Settings.');
  let auth;
  try {
    auth = await authenticateToken(ctx, `Bearer ${creds.token}`);
  } catch (e) {
    if (isAppError(e) && e.code === 'UNAUTHORIZED')
      return refuse('This access token does not work (wrong, expired or revoked).');
    throw e;
  }
  if (creds.user !== null && creds.user.toLowerCase() !== auth.user.email.toLowerCase())
    return refuse('The user name must be the email of the account the token belongs to.');
  if (!auth.scopes.includes('webdav'))
    return refuse('This access token cannot be used for WebDAV: make one with the WebDAV scope.');
  await enforceRateLimit(ctx.env, 'RL_DAV', `dav:${auth.token.id}`);
  return { userId: auth.user.id };
}

/** Reads a small XML request body (PROPFIND, PROPPATCH, LOCK); null when there is none. */
async function xmlBody(req: Request): Promise<XmlNode | null> {
  const declared = Number(req.headers.get('content-length') ?? 'NaN');
  if (Number.isFinite(declared) && declared > DAV_XML_MAX_BYTES)
    throw new DavError(413, 'request body too large');
  if (!req.body) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > DAV_XML_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new DavError(413, 'request body too large');
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  const body = new TextDecoder().decode(all).trim();
  if (!body) return null;
  try {
    return parseXml(body);
  } catch (e) {
    if (e instanceof XmlError) throw new DavError(400, `malformed XML: ${e.message}`);
    throw e;
  }
}

/** Where MOVE/COPY go: a path on this host. */
function destination(req: Request, env: Env): string[] {
  const raw = req.headers.get('destination');
  if (!raw) throw new DavError(400, 'Destination header is required');
  let url: URL;
  try {
    url = new URL(raw, req.url);
  } catch {
    throw new DavError(400, 'Destination is not a URL');
  }
  if (!isDavHost(url, env)) throw new DavError(502, 'Destination is on another server');
  const segments = splitDavPath(url.pathname);
  if (!segments) throw new DavError(400, 'Destination path is not valid');
  return segments;
}

/** Bytes a PUT carries: Content-Length, or what Finder announces when it sends chunks. */
function putLength(req: Request): { length: number; known: boolean } {
  const cl = req.headers.get('content-length');
  if (cl !== null && /^\d+$/.test(cl.trim())) return { length: Number(cl), known: true };
  const expected = req.headers.get('x-expected-entity-length');
  if (expected !== null && /^\d+$/.test(expected.trim()))
    return { length: Number(expected), known: false };
  if (!req.body) return { length: 0, known: true };
  throw new DavError(411, 'Content-Length is required');
}

/** A body of a known length for R2 (Workers' FixedLengthStream; tests and dev take any stream). */
function withLength(body: ReadableStream | null, length: number): ReadableStream | null {
  const Fixed = (
    globalThis as {
      FixedLengthStream?: new (n: number) => { readable: ReadableStream; writable: WritableStream };
    }
  ).FixedLengthStream;
  if (!body || !Fixed) return body;
  const fixed = new Fixed(length);
  body.pipeTo(fixed.writable).catch(() => undefined);
  return fixed.readable;
}

function mtimeOf(req: Request): number | null {
  const raw = req.headers.get('x-oc-mtime');
  if (!raw || !/^\d{1,11}$/.test(raw.trim())) return null;
  const s = Number(raw);
  return s > 0 ? s * 1000 : null;
}

function errorResponse(e: unknown): Response {
  if (e instanceof DavError) {
    return e.condition ? xml(e.status, davError(e.condition)) : text(e.status, e.message);
  }
  if (isAppError(e)) {
    const status = davStatusOf(e);
    if (status === 401) return unauthorized(e.message);
    if (status === 413 && typeof e.data?.maxBytes === 'number')
      return text(
        413,
        `Files over ${Math.floor(e.data.maxBytes / 1024 / 1024)} MiB cannot be uploaded over WebDAV; use the Zeiko Drive app or API.`,
      );
    return text(status, e.message);
  }
  log.error('webdav_failed', { message: e instanceof Error ? e.message : String(e) });
  return text(500, 'something went wrong');
}

function targetHref(target: DavTarget, segments: string[]): string {
  const folder =
    target.kind === 'root' || (target.kind === 'node' && target.node.kind === 'folder');
  return davHref(segments, folder);
}

export async function handleDav(req: Request, ctx: Ctx): Promise<Response> {
  const method = req.method.toUpperCase();
  if (method === 'OPTIONS')
    return empty(200, { DAV: '1, 2', Allow: METHODS, 'MS-Author-Via': 'DAV' });
  try {
    const who = await signIn(ctx, req);
    if (who instanceof Response) return who;
    const { userId } = who;
    const segments = splitDavPath(new URL(req.url).pathname);
    if (!segments) return text(400, 'path is not valid');
    const target = await resolveDav(ctx, userId, segments);
    switch (method) {
      case 'PROPFIND': {
        const depthHeader = req.headers.get('depth')?.trim().toLowerCase();
        if (depthHeader === 'infinity')
          throw new DavError(403, 'Depth: infinity is not supported', 'propfind-finite-depth');
        if (depthHeader !== undefined && depthHeader !== '0' && depthHeader !== '1')
          throw new DavError(400, 'Depth must be 0 or 1');
        const request = propRequestOf(await xmlBody(req));
        if (target.kind !== 'root' && target.kind !== 'node') return text(404, 'not found');
        const body = await propfind(
          ctx,
          userId,
          target,
          segments,
          depthHeader === '0' ? 0 : 1,
          request,
        );
        return xml(207, body);
      }
      case 'GET':
      case 'HEAD': {
        if (target.kind === 'node' && target.node.kind === 'file')
          return await davGetFile(ctx, userId, target.node, req);
        if (target.kind !== 'root' && target.kind !== 'node') return text(404, 'not found');
        const spaces: DriveSpace[] = [];
        for (const s of ['personal', 'family'] as const)
          if (await driveTree(ctx, userId, s)) spaces.push(s);
        if (method === 'HEAD') return empty(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return text(200, davListing(target, spaces).trimEnd());
      }
      case 'PUT': {
        const { length, known } = putLength(req);
        const body = known ? req.body : withLength(req.body, length);
        const { created } = await davPut(ctx, userId, target, {
          length,
          body,
          contentType: req.headers.get('content-type'),
          mtime: mtimeOf(req),
        });
        return empty(created ? 201 : 204);
      }
      case 'MKCOL': {
        if (req.body && req.headers.get('content-length') !== '0') {
          const extra = await req.arrayBuffer();
          if (extra.byteLength) throw new DavError(415, 'MKCOL takes no body');
        }
        await davMkcol(ctx, userId, target);
        return empty(201);
      }
      case 'DELETE':
        await davDelete(ctx, userId, target);
        return empty(204);
      case 'MOVE':
      case 'COPY': {
        const dstSegments = destination(req, ctx.env);
        const overwrite = req.headers.get('overwrite')?.trim().toUpperCase() !== 'F';
        const depthHeader = req.headers.get('depth')?.trim().toLowerCase();
        if (method === 'MOVE' && depthHeader !== undefined && depthHeader !== 'infinity')
          throw new DavError(400, 'MOVE of a folder is always Depth: infinity');
        if (
          method === 'COPY' &&
          depthHeader !== undefined &&
          depthHeader !== '0' &&
          depthHeader !== 'infinity'
        )
          throw new DavError(400, 'Depth must be 0 or infinity');
        const dst = await resolveDav(ctx, userId, dstSegments);
        const input = {
          overwrite,
          depth: depthHeader === '0' ? (0 as const) : ('infinity' as const),
        };
        if (method === 'MOVE') {
          const { created } = await davMove(ctx, userId, target, dst, dstSegments, input);
          return empty(created ? 201 : 204);
        }
        const { created, failures } = await davCopy(ctx, userId, target, dst, dstSegments, input);
        if (failures.length) return xml(207, copyFailures(failures));
        return empty(created ? 201 : 204);
      }
      case 'PROPPATCH': {
        const body = await xmlBody(req);
        if (!body) throw new DavError(400, 'PROPPATCH needs a body');
        return xml(
          207,
          await davProppatch(ctx, userId, target, targetHref(target, segments), body),
        );
      }
      case 'LOCK': {
        const body = await xmlBody(req);
        const held = /<(opaquelocktoken:[^>]+)>/.exec(req.headers.get('if') ?? '')?.[1];
        let status = 200;
        if (target.kind === 'nowhere')
          throw new DavError(target.atRoot ? 403 : 409, 'a folder on the way does not exist');
        if (target.kind === 'missing') {
          if (held) throw new DavError(412, 'no such lock');
          // LOCK on an unmapped path makes an empty file (RFC 4918 §9.10.4).
          await davPut(ctx, userId, target, {
            length: 0,
            body: null,
            contentType: null,
            mtime: null,
          });
          status = 201;
        }
        const token = held ?? `opaquelocktoken:${crypto.randomUUID()}`;
        const scope = body ? child(body, 'lockscope') : undefined;
        const shared = Boolean(scope && child(scope, 'shared'));
        const depth = req.headers.get('depth')?.trim() === '0' ? '0' : 'infinity';
        const href =
          target.kind === 'missing' ? davHref(segments, false) : targetHref(target, segments);
        return xml(status, lockBody(href, token, { shared, depth, owner: lockOwner(body) }), {
          ...(held ? {} : { 'Lock-Token': `<${token}>` }),
        });
      }
      case 'UNLOCK':
        return empty(204);
      default:
        return text(405, 'method not allowed', { Allow: METHODS });
    }
  } catch (e) {
    return errorResponse(e);
  }
}
