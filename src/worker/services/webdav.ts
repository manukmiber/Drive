// Drive over WebDAV (D9, ADR-089). Paths are names: `/Drive Saya/Foto/a.jpg`. They are walked in
// the person's trees read from the index (R2), and every change goes through the same services the
// app uses, so access rules, quota, scanning, versions, activity and the index stay one thing.
import { nameKey, type DriveNode, type DriveTree } from '../../shared/drive-tree';
import { mimeFromName } from '../../shared/mime';
import type { Ctx } from '../context';
import { track } from '../lib/analytics';
import {
  child,
  clark,
  davResponse,
  davStatusResponse,
  DAV_NS,
  multistatus,
  type PropStat,
  type PropValue,
  type XmlNode,
} from '../lib/dav-xml';
import { AppError, isAppError } from '../lib/errors';
import { serveObject } from '../lib/serve';
import { esc } from '../lib/s3-xml';
import { loadNode, requireNode } from './access';
import { assertDownloadable } from './download';
import { driveTree, type DriveSpace } from './drive-read';
import {
  copyFile,
  createFolder,
  deleteForever,
  moveNodes,
  renameNode,
  setClientModified,
  trashNodes,
  type NodeDto,
} from './nodes';
import { getPoolUsage } from './storage';
import { simpleUpload } from './uploads';

/** The two folders at `/`. Fixed words: a path a client has mounted must not move with the UI language. */
export const SPACE_NAMES: Record<DriveSpace, string> = {
  personal: 'Drive Saya',
  family: 'Drive Keluarga',
};

export type DavTarget =
  | { kind: 'root' }
  | {
      kind: 'node';
      space: DriveSpace;
      tree: DriveTree;
      node: DriveNode;
      /** The folder it is in; null for a space's own folder. */
      parent: DriveNode | null;
    }
  | { kind: 'missing'; space: DriveSpace; tree: DriveTree; parent: DriveNode; name: string }
  /** Nothing there and nothing can be made there: a folder on the way is missing (409), or at `/` (403). */
  | { kind: 'nowhere'; atRoot: boolean };

/** An error with the HTTP status WebDAV answers with (403, 405, 409, 412, …). */
export class DavError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** RFC 4918 precondition element for a `<D:error>` body. */
    readonly condition?: string,
  ) {
    super(message);
    this.name = 'DavError';
  }
}

/** Path segments, decoded; null when a segment is malformed or tries to climb. */
export function splitDavPath(pathname: string): string[] | null {
  const out: string[] = [];
  for (const raw of pathname.split('/')) {
    if (!raw) continue;
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (seg === '.' || seg === '..' || seg.includes('/') || seg.includes('\0')) return null;
    out.push(seg);
  }
  return out;
}

/** The href of a path, each segment percent-encoded; collections end with "/". */
export function davHref(segments: string[], collection: boolean): string {
  const path = segments.map((s) => encodeURIComponent(s)).join('/');
  if (!path) return '/';
  return `/${path}${collection ? '/' : ''}`;
}

function spaceOf(segment: string): DriveSpace | null {
  const k = nameKey(segment);
  if (k === nameKey(SPACE_NAMES.personal)) return 'personal';
  if (k === nameKey(SPACE_NAMES.family)) return 'family';
  return null;
}

/** What a path names in the person's Drive. */
export async function resolveDav(ctx: Ctx, userId: string, segments: string[]): Promise<DavTarget> {
  if (!segments.length) return { kind: 'root' };
  const space = spaceOf(segments[0]!);
  if (!space) return { kind: 'nowhere', atRoot: segments.length === 1 };
  const loaded = await driveTree(ctx, userId, space);
  if (!loaded) return { kind: 'nowhere', atRoot: segments.length === 1 };
  if (loaded.locked) throw new AppError('ACCOUNT_SUSPENDED', 'file access is locked until payment');
  const tree = loaded.tree;
  let cur = tree.node(tree.rootId);
  if (!cur) return { kind: 'nowhere', atRoot: segments.length === 1 };
  let parent: DriveNode | null = null;
  for (let i = 1; i < segments.length; i++) {
    const last = i === segments.length - 1;
    if (cur.kind !== 'folder') return { kind: 'nowhere', atRoot: false };
    const next = tree.childByName(cur.id, segments[i]!);
    if (!next) {
      return last
        ? { kind: 'missing', space, tree, parent: cur, name: segments[i]! }
        : { kind: 'nowhere', atRoot: false };
    }
    parent = cur;
    cur = next;
  }
  return { kind: 'node', space, tree, node: cur, parent };
}

// ───────────────────────────── PROPFIND ─────────────────────────────

export type PropRequest = { mode: 'all' } | { mode: 'names' } | { mode: 'props'; names: string[] };

/** Reads a PROPFIND body (none = allprop). */
export function propRequestOf(body: XmlNode | null): PropRequest {
  if (!body) return { mode: 'all' };
  if (body.ns !== DAV_NS || body.local !== 'propfind')
    throw new DavError(400, 'expected a DAV:propfind body');
  if (child(body, 'propname')) return { mode: 'names' };
  const prop = child(body, 'prop');
  if (prop) return { mode: 'props', names: prop.children.map(clark) };
  return { mode: 'all' };
}

const D = (local: string) => `{${DAV_NS}}${local}`;
const LIVE = [
  'displayname',
  'resourcetype',
  'getcontentlength',
  'getcontenttype',
  'getlastmodified',
  'creationdate',
  'getetag',
  'supportedlock',
  'lockdiscovery',
].map(D);
const QUOTA = ['quota-used-bytes', 'quota-available-bytes'].map(D);

const SUPPORTED_LOCK =
  '<D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry>' +
  '<D:lockentry><D:lockscope><D:shared/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry>';

interface Quota {
  used: number;
  available: number;
}

interface Resource {
  href: string;
  collection: boolean;
  displayName: string;
  size: number;
  mime: string | null;
  modified: number;
  created: number;
  etag: string;
  quota: (() => Promise<Quota>) | null;
}

function propValue(r: Resource, name: string, quota: Quota | null): PropValue | undefined {
  switch (name) {
    case D('displayname'):
      return { text: r.displayName };
    case D('resourcetype'):
      return r.collection ? { xml: '<D:collection/>' } : null;
    case D('getcontentlength'):
      return r.collection ? undefined : { text: String(r.size) };
    case D('getcontenttype'):
      return r.collection ? undefined : { text: r.mime || 'application/octet-stream' };
    case D('getlastmodified'):
      return { text: new Date(r.modified).toUTCString() };
    case D('creationdate'):
      return { text: new Date(r.created).toISOString() };
    case D('getetag'):
      return { text: r.etag };
    case D('supportedlock'):
      return { xml: SUPPORTED_LOCK };
    case D('lockdiscovery'):
      return null;
    case D('quota-used-bytes'):
      return quota ? { text: String(quota.used) } : undefined;
    case D('quota-available-bytes'):
      return quota ? { text: String(quota.available) } : undefined;
    default:
      return undefined;
  }
}

async function responseFor(r: Resource, req: PropRequest): Promise<string> {
  if (req.mode === 'names') {
    const names = [...LIVE, ...(r.quota ? QUOTA : [])].filter(
      (n) => propValue(r, n, { used: 0, available: 0 }) !== undefined,
    );
    return davResponse(r.href, [
      { status: 200, props: names.map((name) => ({ name, value: null })) },
    ]);
  }
  const names = req.mode === 'all' ? LIVE : req.names;
  const quota = r.quota && names.some((n) => QUOTA.includes(n)) ? await r.quota() : null;
  const found: PropStat = { status: 200, props: [] };
  const missing: PropStat = { status: 404, props: [] };
  for (const name of names) {
    const value = propValue(r, name, quota);
    if (value === undefined) missing.props.push({ name, value: null });
    else found.props.push({ name, value });
  }
  return davResponse(r.href, [found, missing]);
}

/** The ETag a file has in listings and on GET: its content's id. */
function fileEtag(tree: DriveTree, node: DriveNode): string {
  const content = tree.contentOf(node.id);
  const id = typeof content === 'string' ? content.slice(content.lastIndexOf('/') + 1) : content;
  return `"${id ?? node.id}"`;
}

function nodeResource(
  tree: DriveTree,
  node: DriveNode,
  href: string,
  displayName: string,
  quota: Resource['quota'],
): Resource {
  const folder = node.kind === 'folder';
  return {
    href,
    collection: folder,
    displayName,
    size: node.size,
    mime: node.mime,
    modified: node.clientModifiedAt ?? node.updatedAt,
    created: node.createdAt,
    etag: folder ? `"d${node.id}-${Math.floor(node.updatedAt / 1000)}"` : fileEtag(tree, node),
    quota: folder ? quota : null,
  };
}

/** A space's pool use, read once per request whichever of its folders asks. */
function quotaOf(ctx: Ctx, tree: DriveTree): () => Promise<Quota> {
  let p: Promise<Quota> | null = null;
  return () =>
    (p ??= (async () => {
      const root = await loadNode(ctx, tree.rootId);
      if (!root) return { used: 0, available: 0 };
      const u = await getPoolUsage(ctx, root.pool_id);
      return {
        used: u.usedBytes,
        available: Math.max(0, u.limitBytes - u.usedBytes - u.reservedBytes),
      };
    })());
}

/** The multistatus for PROPFIND on a target at Depth 0 or 1. */
export async function propfind(
  ctx: Ctx,
  userId: string,
  target: DavTarget,
  segments: string[],
  depth: 0 | 1,
  req: PropRequest,
): Promise<string> {
  if (target.kind === 'root') {
    const personal = await driveTree(ctx, userId, 'personal');
    const family = await driveTree(ctx, userId, 'family');
    const rootQuota = personal ? quotaOf(ctx, personal.tree) : null;
    const created = personal?.tree.node(personal.tree.rootId)?.createdAt ?? 0;
    const out = [
      await responseFor(
        {
          href: '/',
          collection: true,
          displayName: '',
          size: 0,
          mime: null,
          modified: created,
          created,
          etag: '"root"',
          quota: rootQuota,
        },
        req,
      ),
    ];
    if (depth === 1) {
      for (const [space, loaded] of [
        ['personal', personal],
        ['family', family],
      ] as const) {
        if (!loaded) continue;
        const root = loaded.tree.node(loaded.tree.rootId);
        if (!root) continue;
        out.push(
          await responseFor(
            nodeResource(
              loaded.tree,
              root,
              davHref([SPACE_NAMES[space]], true),
              SPACE_NAMES[space],
              quotaOf(ctx, loaded.tree),
            ),
            req,
          ),
        );
      }
    }
    return multistatus(out);
  }
  if (target.kind !== 'node') throw new DavError(404, 'not found');
  const { tree, node, parent, space } = target;
  const quota = quotaOf(ctx, tree);
  const folder = node.kind === 'folder';
  const name = parent ? node.name : SPACE_NAMES[space];
  const out = [
    await responseFor(nodeResource(tree, node, davHref(segments, folder), name, quota), req),
  ];
  if (depth === 1 && folder) {
    // Children under the path exactly as asked: clients find them by cutting that prefix off.
    const base = segments;
    for (const kid of tree.children(node.id)) {
      const href = davHref([...base, kid.name], kid.kind === 'folder');
      out.push(await responseFor(nodeResource(tree, kid, href, kid.name, quota), req));
    }
  }
  return multistatus(out);
}

// ───────────────────────────── GET ─────────────────────────────

/** A file's bytes (Range, If-None-Match), with the rules the app's download follows. */
export async function davGetFile(
  ctx: Ctx,
  userId: string,
  node: DriveNode,
  req: Request,
): Promise<Response> {
  const { node: rec } = await requireNode(ctx, userId, node.id, 'view');
  const blob = rec.blob_id
    ? await ctx.env.DB.prepare(
        'SELECT r2_key, size, scan_status, sniffed_mime FROM blobs WHERE id = ?1',
      )
        .bind(rec.blob_id)
        .first<{ r2_key: string; size: number; scan_status: string; sniffed_mime: string | null }>()
    : null;
  assertDownloadable(rec, blob?.scan_status ?? null, userId);
  if (!blob) throw new AppError('NOT_FOUND', 'file content missing');
  const { response, bytes } = await serveObject(ctx.env.BUCKET, req, {
    key: blob.r2_key,
    size: blob.size,
    etag: `"${rec.blob_id}"`,
    filename: rec.name,
    contentType: blob.sniffed_mime ?? rec.mime ?? 'application/octet-stream',
    disposition: 'attachment',
    extraHeaders: {
      'Last-Modified': new Date(rec.client_modified_at ?? rec.updated_at).toUTCString(),
    },
  });
  if (bytes > 0) track(ctx.env.ANALYTICS, 'download', { blobs: [rec.pool_id], doubles: [bytes] });
  return response;
}

/** A folder opened in a browser: its names as plain text (never HTML made of file names). */
export function davListing(target: DavTarget, userSpaces: DriveSpace[]): string {
  if (target.kind === 'root') return userSpaces.map((s) => `${SPACE_NAMES[s]}/`).join('\n') + '\n';
  if (target.kind !== 'node') return '';
  return (
    target.tree
      .children(target.node.id)
      .map((n) => (n.kind === 'folder' ? `${n.name}/` : n.name))
      .join('\n') + '\n'
  );
}

// ───────────────────────────── writes ─────────────────────────────

/**
 * The folder something goes in, and its name (for MOVE/COPY onto an existing item, the name as the
 * destination path spells it); refuses the places nothing can be made.
 */
function placeOf(
  target: DavTarget,
  asked?: string,
): { parent: DriveNode; name: string; space: DriveSpace } {
  if (target.kind === 'root') throw new DavError(405, 'the top folder cannot be replaced');
  if (target.kind === 'nowhere')
    throw target.atRoot
      ? new DavError(403, 'only "Drive Saya" and "Drive Keluarga" are at the top')
      : new DavError(409, 'a folder on the way does not exist');
  if (target.kind === 'missing')
    return { parent: target.parent, name: target.name, space: target.space };
  if (!target.parent) throw new DavError(405, 'this folder cannot be replaced');
  return { parent: target.parent, name: asked ?? target.node.name, space: target.space };
}

function cleanType(type: string | null, name: string): string | null {
  const t = type?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (t && t !== 'application/octet-stream' && t !== 'binary/octet-stream') return t;
  return mimeFromName(name);
}

export interface PutInput {
  length: number;
  body: ReadableStream | null;
  contentType: string | null;
  /** ms; from X-OC-Mtime. */
  mtime: number | null;
}

/** PUT: a new file, or new content for an existing one (its old content becomes a version). */
export async function davPut(
  ctx: Ctx,
  userId: string,
  target: DavTarget,
  input: PutInput,
): Promise<{ created: boolean; node: NodeDto }> {
  if (target.kind === 'node' && target.node.kind === 'folder')
    throw new DavError(405, 'a folder cannot be written as a file');
  const { parent, name } = placeOf(target);
  const cfg = await ctx.config();
  if (input.length > cfg.webdav_put_max_bytes)
    throw new AppError('PAYLOAD_TOO_LARGE', 'file too large for WebDAV', {
      maxBytes: cfg.webdav_put_max_bytes,
    });
  let created = target.kind === 'missing';
  // Windows writes 0 bytes first and the content right after: an empty file is not worth a version
  // or a place in the Trash.
  if (target.kind === 'node' && target.node.size === 0) {
    try {
      await deleteForever(ctx, userId, [target.node.id]);
      created = true;
    } catch (e) {
      if (!isAppError(e)) throw e;
    }
  }
  const node = await simpleUpload(
    ctx,
    userId,
    {
      parentId: parent.id,
      name,
      size: input.length,
      mime: cleanType(input.contentType, name),
      lastModified: input.mtime,
      onConflict: 'replace',
    },
    input.length,
    input.body,
    { maxBytes: cfg.webdav_put_max_bytes },
  );
  return { created, node };
}

/** MKCOL: a new folder where nothing is. */
export async function davMkcol(ctx: Ctx, userId: string, target: DavTarget): Promise<void> {
  if (target.kind === 'node' || target.kind === 'root')
    throw new DavError(405, 'something with that name is already there');
  const { parent, name } = placeOf(target);
  await createFolder(ctx, userId, parent.id, name, 'error');
}

/** DELETE: to the Trash, as in the app (it can be brought back for the Trash's days). */
export async function davDelete(ctx: Ctx, userId: string, target: DavTarget): Promise<void> {
  if (target.kind === 'root' || (target.kind === 'node' && !target.parent))
    throw new DavError(403, 'this folder cannot be deleted');
  if (target.kind !== 'node') throw new DavError(404, 'not found');
  await trashNodes(ctx, userId, [target.node.id]);
}

export interface TransferInput {
  overwrite: boolean;
  /** COPY of a folder: 0 = the folder alone, else everything in it. */
  depth: 0 | 'infinity';
}

/** Clears the destination of MOVE/COPY (to the Trash) when allowed; true when something was there. */
async function clearDestination(
  ctx: Ctx,
  userId: string,
  src: DriveNode,
  dst: DavTarget,
  overwrite: boolean,
): Promise<boolean> {
  if (dst.kind !== 'node') return false;
  if (dst.node.id === src.id) return false;
  if (!dst.parent) throw new DavError(403, 'this folder cannot be replaced');
  if (!overwrite) throw new DavError(412, 'the destination exists and Overwrite is F');
  await trashNodes(ctx, userId, [dst.node.id]);
  return true;
}

/** True when `folder` is `ancestorId` or inside it (in this tree). */
function within(tree: DriveTree, folder: DriveNode, ancestorId: string): boolean {
  let at: DriveNode | null = folder;
  for (let i = 0; at && i < 200; i++) {
    if (at.id === ancestorId) return true;
    at = at.parentId ? tree.node(at.parentId) : null;
  }
  return false;
}

function requireSource(src: DavTarget): { node: DriveNode; tree: DriveTree; parent: DriveNode } {
  if (src.kind === 'root' || (src.kind === 'node' && !src.parent))
    throw new DavError(403, 'this folder cannot be moved or copied');
  if (src.kind !== 'node') throw new DavError(404, 'not found');
  return { node: src.node, tree: src.tree, parent: src.parent! };
}

/** MOVE: rename, move to another folder, or both. Answers whether the destination was new. */
export async function davMove(
  ctx: Ctx,
  userId: string,
  src: DavTarget,
  dst: DavTarget,
  dstSegments: string[],
  input: TransferInput,
): Promise<{ created: boolean }> {
  const s = requireSource(src);
  const place = placeOf(dst, dstSegments[dstSegments.length - 1]);
  if (dst.kind === 'node' && dst.node.id === s.node.id && dst.node.name === place.name)
    throw new DavError(403, 'source and destination are the same');
  if (s.node.kind === 'folder' && within(s.tree, place.parent, s.node.id))
    throw new DavError(403, 'a folder cannot be moved into itself');
  const replaced = await clearDestination(ctx, userId, s.node, dst, input.overwrite);
  let name = s.node.name;
  if (place.parent.id !== s.parent.id) {
    const [moved] = await moveNodes(ctx, userId, [s.node.id], place.parent.id, {
      confirmSpaceChange: true,
    });
    name = moved?.name ?? name;
  }
  if (name !== place.name) await renameNode(ctx, userId, s.node.id, place.name);
  return { created: !replaced };
}

interface CopyFailure {
  segments: string[];
  status: number;
}

/** COPY: files share their content (no bytes copied); folders are made again, item by item. */
export async function davCopy(
  ctx: Ctx,
  userId: string,
  src: DavTarget,
  dst: DavTarget,
  dstSegments: string[],
  input: TransferInput,
): Promise<{ created: boolean; failures: CopyFailure[] }> {
  const s = requireSource(src);
  const place = placeOf(dst, dstSegments[dstSegments.length - 1]);
  if (dst.kind === 'node' && dst.node.id === s.node.id)
    throw new DavError(403, 'source and destination are the same');
  if (s.node.kind === 'folder' && input.depth === 'infinity') {
    const cfg = await ctx.config();
    if (countItems(s.tree, s.node.id, cfg.webdav_copy_max_items + 1) > cfg.webdav_copy_max_items)
      throw new DavError(
        403,
        `a folder with more than ${cfg.webdav_copy_max_items} items cannot be copied over WebDAV`,
      );
    if (within(s.tree, place.parent, s.node.id))
      throw new DavError(403, 'a folder cannot be copied into itself');
  }
  const replaced = await clearDestination(ctx, userId, s.node, dst, input.overwrite);
  const failures: CopyFailure[] = [];
  if (s.node.kind === 'file') {
    await copyOneFile(ctx, userId, s.node.id, place.parent.id, place.name);
  } else {
    const made = await createFolder(ctx, userId, place.parent.id, place.name, 'error');
    if (input.depth === 'infinity')
      await copyChildren(ctx, userId, s.tree, s.node.id, made.id, dstSegments, failures);
  }
  return { created: !replaced, failures };
}

async function copyOneFile(
  ctx: Ctx,
  userId: string,
  fileId: string,
  parentId: string,
  name: string,
): Promise<void> {
  const copy = await copyFile(ctx, userId, fileId, parentId);
  if (copy.name !== name) await renameNode(ctx, userId, copy.id, name);
}

function countItems(tree: DriveTree, folderId: string, stopAt: number): number {
  let n = 0;
  const stack = [folderId];
  while (stack.length && n < stopAt) {
    for (const kid of tree.children(stack.pop()!)) {
      n++;
      if (kid.kind === 'folder') stack.push(kid.id);
    }
  }
  return n;
}

async function copyChildren(
  ctx: Ctx,
  userId: string,
  tree: DriveTree,
  fromId: string,
  toId: string,
  base: string[],
  failures: CopyFailure[],
): Promise<void> {
  for (const kid of tree.children(fromId)) {
    const segments = [...base, kid.name];
    try {
      if (kid.kind === 'file') await copyOneFile(ctx, userId, kid.id, toId, kid.name);
      else {
        const made = await createFolder(ctx, userId, toId, kid.name, 'error');
        await copyChildren(ctx, userId, tree, kid.id, made.id, segments, failures);
      }
    } catch (e) {
      if (!isAppError(e) && !(e instanceof DavError)) throw e;
      failures.push({ segments, status: e instanceof DavError ? e.status : davStatusOf(e) });
    }
  }
}

/** The multistatus naming what a folder COPY could not copy (files not scanned yet, …). */
export function copyFailures(failures: CopyFailure[]): string {
  return multistatus(failures.map((f) => davStatusResponse(davHref(f.segments, false), f.status)));
}

// ───────────────────────────── PROPPATCH ─────────────────────────────

const MS_NS = 'urn:schemas-microsoft-com:';
const TIME_PROPS = new Set([D('getlastmodified'), `{${MS_NS}}Win32LastModifiedTime`]);

/**
 * PROPPATCH: the modified time is kept (as the time the person's device gave it); other properties
 * are answered as set and not kept (ADR-089).
 */
export async function davProppatch(
  ctx: Ctx,
  userId: string,
  target: DavTarget,
  href: string,
  body: XmlNode,
): Promise<string> {
  if (body.ns !== DAV_NS || body.local !== 'propertyupdate')
    throw new DavError(400, 'expected a DAV:propertyupdate body');
  if (target.kind === 'missing' || target.kind === 'nowhere') throw new DavError(404, 'not found');
  const names: string[] = [];
  let time: number | null = null;
  for (const op of body.children) {
    if (op.ns !== DAV_NS || (op.local !== 'set' && op.local !== 'remove')) continue;
    for (const prop of child(op, 'prop')?.children ?? []) {
      const name = clark(prop);
      names.push(name);
      if (op.local === 'set' && TIME_PROPS.has(name)) {
        const at = Date.parse(prop.text.trim());
        if (Number.isFinite(at) && at > 0) time = at;
      }
    }
  }
  let status = 200;
  if (target.kind === 'root' || !target.parent) status = 403;
  else if (time !== null) {
    try {
      await setClientModified(ctx, userId, target.node.id, time);
    } catch (e) {
      if (!isAppError(e)) throw e;
      status = 403;
    }
  }
  return multistatus([
    davResponse(href, [{ status, props: names.map((name) => ({ name, value: null })) }]),
  ]);
}

// ───────────────────────────── LOCK ─────────────────────────────

/** The lock a LOCK answers with. Nothing is kept: locks are advisory here (ADR-089). */
export function lockBody(
  href: string,
  token: string,
  o: { shared: boolean; depth: '0' | 'infinity'; owner: string | null },
): string {
  const owner = o.owner ? `<D:owner><D:href>${esc(o.owner)}</D:href></D:owner>` : '';
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>` +
    `<D:locktype><D:write/></D:locktype><D:lockscope>${o.shared ? '<D:shared/>' : '<D:exclusive/>'}</D:lockscope>` +
    `<D:depth>${o.depth}</D:depth>${owner}<D:timeout>Second-3600</D:timeout>` +
    `<D:locktoken><D:href>${esc(token)}</D:href></D:locktoken>` +
    `<D:lockroot><D:href>${esc(href)}</D:href></D:lockroot>` +
    `</D:activelock></D:lockdiscovery></D:prop>`
  );
}

/** The lock's owner as text (Windows sends `<D:owner><D:href>DOMAIN\\user</D:href></D:owner>`). */
export function lockOwner(body: XmlNode | null): string | null {
  const owner = body ? child(body, 'owner') : undefined;
  if (!owner) return null;
  const text = (n: XmlNode): string => n.text + n.children.map(text).join('');
  const t = text(owner).trim();
  return t ? t.slice(0, 200) : null;
}

// ───────────────────────────── errors ─────────────────────────────

/** The status WebDAV answers an application error with. */
export function davStatusOf(e: AppError): number {
  switch (e.code) {
    case 'UNAUTHORIZED':
      return 401;
    case 'NOT_FOUND':
      return 404;
    case 'FORBIDDEN':
    case 'READ_ONLY':
    case 'ACCOUNT_SUSPENDED':
    case 'INVALID_NAME':
      return 403;
    case 'NAME_CONFLICT':
    case 'CONFLICT':
    case 'UPLOAD_STATE':
      return 409;
    case 'QUOTA_FULL':
      return 507;
    case 'FILE_TOO_LARGE':
    case 'PAYLOAD_TOO_LARGE':
      return 413;
    case 'RATE_LIMITED':
      return 429;
    case 'INDEX_BUSY':
      return 503;
    case 'BAD_REQUEST':
    case 'VALIDATION':
      return 400;
    default:
      return e.status >= 400 ? e.status : 500;
  }
}
