// D6 (ADR-090): search with the box's syntax over the person's trees (their own and their family's,
// read from the index), what others shared with them (D2), and — when they turned it on — the text
// inside files. One order, a page at a time.
import { scoreNode, type DriveNode, type DriveTypeFilter } from '../../shared/drive-tree';
import { hasCriteria, parseSearch, type ParsedSearch } from '../../shared/search-query';
import type { Ctx } from '../context';
import { accessDb } from '../lib/access-db';
import { AppError } from '../lib/errors';
import { putTexts, searchTexts, textedIds, type TextInput } from './content-index';
import { changeIndex, type IndexOwner } from './drive-index';
import { familyAccess, treeNode } from './drive-read';
import { textKind } from '../../shared/mime';
import { driveTree, type DriveSpace } from './drive-read';
import { headOf } from './versions';
import { sharedCandidates } from './grants';
import type { NodeDto } from './nodes';

export interface SearchRequest {
  q: string;
  /** Old parameters, still read (merged into the parsed query). */
  type?: DriveTypeFilter | undefined;
  modifiedAfter?: number | undefined;
  space?: DriveSpace | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export interface SearchSnippet {
  text: string;
  ranges: Array<[number, number]>;
}

export interface SearchResult {
  items: NodeDto[];
  nextCursor: string | null;
  /** D6 part 2: where the words are inside a file, by node id. */
  snippets: Record<string, SearchSnippet>;
  /** Parts of the query that were not understood (shown under the box). */
  warnings: string[];
  /** Whether file contents were searched (the person's switch). */
  contentSearch: boolean;
}

const PAGE = 50;
const MAX_RESULTS = 500;

/** A query's fingerprint, so a cursor of one query is not used for another. */
function fingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/** The person's "search file contents" switch (D6), kept in their own index's header. */
export async function contentSearchOn(ctx: Ctx, userId: string): Promise<boolean> {
  const head = await headOf(ctx, { user: userId });
  return head?.contentSearch === true;
}

/** Items the person shared: by an active link, or with a person (D2). */
async function sharedByMe(ctx: Ctx, userId: string): Promise<Set<string>> {
  const now = ctx.now();
  const A = accessDb(ctx.env);
  const [links, grants] = await Promise.all([
    A.prepare(
      `SELECT si.node_id FROM share_items si JOIN shares s ON s.id = si.share_id
       WHERE s.created_by = ?1 AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > ?2)`,
    )
      .bind(userId, now)
      .all<{ node_id: string }>()
      .catch(() => ({ results: [] as Array<{ node_id: string }> })),
    A.prepare(
      `SELECT node_id FROM node_grants WHERE granted_by = ?1 AND (expires_at IS NULL OR expires_at > ?2)`,
    )
      .bind(userId, now)
      .all<{ node_id: string }>()
      .catch(() => ({ results: [] as Array<{ node_id: string }> })),
  ]);
  return new Set([...links.results, ...grants.results].map((r) => r.node_id));
}

function dateOf(n: DriveNode, p: ParsedSearch): number {
  if (p.dateField === 'created') return n.createdAt;
  if (p.dateField === 'taken') return n.takenAt ?? n.clientModifiedAt ?? n.createdAt;
  return n.updatedAt;
}

export async function searchDrive(
  ctx: Ctx,
  userId: string,
  req: SearchRequest,
): Promise<SearchResult> {
  const p = parseSearch(req.q);
  if (req.type && !p.types.includes(req.type)) p.types.push(req.type);
  if (req.modifiedAfter) p.after = Math.max(p.after ?? 0, req.modifiedAfter);
  if (req.space) p.space = req.space;
  const contentSearch = await contentSearchOn(ctx, userId);
  const empty: SearchResult = {
    items: [],
    nextCursor: null,
    snippets: {},
    warnings: p.warnings,
    contentSearch,
  };
  if (!hasCriteria(p)) return empty;

  const fp = fingerprint(JSON.stringify([req.q, req.type, req.modifiedAfter, req.space]));
  let offset = 0;
  if (req.cursor) {
    const m = /^(\d{1,4})\.([0-9a-z]+)$/.exec(req.cursor);
    if (!m || m[2] !== fp) throw new AppError('BAD_REQUEST', 'invalid cursor');
    offset = Number(m[1]);
  }
  const limit = Math.min(Math.max(req.limit ?? PAGE, 1), 100);

  const only = p.shared ? await sharedByMe(ctx, userId) : null;
  const found = new Map<string, { node: NodeDto; score: number }>();
  const snippets: Record<string, SearchSnippet> = {};
  for (const space of ['personal', 'family'] as const) {
    if (p.space && p.space !== space) continue;
    const loaded = await driveTree(ctx, userId, space);
    if (!loaded || loaded.locked) continue;
    const { tree } = loaded;
    const within = p.inFolder ? tree.foldersNamed(p.inFolder) : null;
    if (within && !within.length) continue;
    for (const hit of tree.find(p, { within, only })) found.set(hit.node.id, hit);
    if (contentSearch && p.groups.length) {
      for (const hit of await searchTexts(ctx, loaded.index, tree, p)) {
        const node = tree.node(hit.id);
        if (!node || !tree.passes(node, p, { within, only, words: false })) continue;
        const had = found.get(node.id);
        found.set(node.id, { node, score: (had?.score ?? 0) + 1 });
        snippets[node.id] = { text: hit.snippet, ranges: hit.ranges };
      }
    }
  }
  // Shared with the person (D2): names only, when no space was asked for.
  if (!p.space && !p.inFolder && p.groups.length) {
    for (const node of await sharedCandidates(ctx, userId)) {
      if (found.has(node.id)) continue;
      const score = scoreNode(node, p, only);
      if (score !== null) found.set(node.id, { node, score });
    }
  }

  const all = [...found.values()].sort((a, b) =>
    p.sort === 'date'
      ? dateOf(b.node, p) - dateOf(a.node, p) || (a.node.id < b.node.id ? 1 : -1)
      : b.score - a.score ||
        (a.node.kind === 'folder' ? 0 : 1) - (b.node.kind === 'folder' ? 0 : 1) ||
        b.node.updatedAt - a.node.updatedAt ||
        (a.node.id < b.node.id ? 1 : -1),
  );
  const capped = all.slice(0, MAX_RESULTS);
  const page = capped.slice(offset, offset + limit);
  const next = offset + limit < capped.length ? `${offset + limit}.${fp}` : null;
  const pageSnippets: Record<string, SearchSnippet> = {};
  for (const { node } of page) if (snippets[node.id]) pageSnippets[node.id] = snippets[node.id]!;
  return {
    items: page.map((x) => x.node),
    nextCursor: next,
    snippets: pageSnippets,
    warnings: p.warnings,
    contentSearch,
  };
}

/** Turns "search file contents" on or off for the person (their own index's header). */
export async function setContentSearch(ctx: Ctx, userId: string, on: boolean): Promise<void> {
  await changeIndex(ctx.env.BUCKET, { user: userId }, (doc) => doc.setMeta('contentSearch', on));
}

/**
 * Texts the person's browser took from files (D6). Each file needs the right to edit it; files
 * that are not found or not theirs to edit are skipped, not errors. One write per space.
 */
export async function postTexts(
  ctx: Ctx,
  userId: string,
  items: TextInput[],
): Promise<{ stored: number; skipped: number }> {
  if (!(await contentSearchOn(ctx, userId)))
    throw new AppError('CONFLICT', 'search file contents is off', { reason: 'CONTENT_SEARCH_OFF' });
  const groups = new Map<
    string,
    { owner: IndexOwner; tree: Parameters<typeof putTexts>[2]; items: TextInput[] }
  >();
  let skipped = 0;
  for (const it of items) {
    const found = await treeNode(ctx, userId, it.id);
    if (!found || found.node.kind !== 'file' || !found.access.edit) {
      skipped++;
      continue;
    }
    const key = JSON.stringify(found.index);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { owner: found.index, tree: found.tree, items: [] }));
    g.items.push(it);
  }
  let stored = 0;
  for (const g of groups.values()) stored += (await putTexts(ctx, g.owner, g.tree, g.items)).stored;
  return { stored, skipped };
}

export interface MissingText {
  id: string;
  name: string;
  mime: string | null;
  size: number;
}

/** Documents of the person's spaces that have no current text yet ("Index again"). */
export async function missingTexts(
  ctx: Ctx,
  userId: string,
  limit = 100,
): Promise<{ items: MissingText[]; total: number }> {
  const cfg = await ctx.config();
  const out: MissingText[] = [];
  for (const space of ['personal', 'family'] as const) {
    const loaded = await driveTree(ctx, userId, space);
    if (!loaded || loaded.locked) continue;
    const texted = await textedIds(ctx, loaded.index, loaded.tree);
    for (const { node } of loaded.tree.contents()) {
      if (texted.has(node.id) || node.size > cfg.content_text_source_max_bytes) continue;
      if (!textKind(node.name, node.mime)) continue;
      if (space === 'family' && !familyAccess(node, userId, loaded.role).edit) continue;
      out.push({ id: node.id, name: node.name, mime: node.mime, size: node.size });
    }
  }
  return { items: out.slice(0, limit), total: out.length };
}
