// Access tokens (ADR-061): what scripts, apps, the SDK and WebDAV sign in with instead of the
// browser's session cookie. A token is `zkd_` + an 8-character public id + a 32-character secret;
// the id finds the row and the whole token's SHA-256 is compared in constant time. Tokens only
// work on /api/v1 (and the WebDAV host); the cookie API never reads them, and nothing reaches ops.
import { DAY_MS } from '../../shared/constants';
import type { Ctx } from '../context';
import { sha256Hex, timingSafeEqual } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { randomBase62, ulid } from '../lib/ids';
import type { SessionUser } from '../types';

export const TOKEN_SCOPES = ['drive.read', 'drive.write', 'share', 'webdav', 's3.manage'] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];
export type TokenKind = 'personal' | 'oauth_access' | 'oauth_refresh';

export const TOKEN_PREFIX = 'zkd_';
/** Refresh tokens of connected apps (ADR-063): never accepted as a Bearer token. */
export const REFRESH_PREFIX = 'zkr_';
const ID_LEN = 8;
const SECRET_LEN = 32;
export const TOKEN_RE = /^zkd_[0-9A-Za-z]{40}$/;
export const REFRESH_RE = /^zkr_[0-9A-Za-z]{40}$/;
/** last_used_at is written at most this often per token (D1 writes on Workers Free). */
const TOUCH_EVERY_MS = 5 * 60_000;

export const isScope = (s: string): s is TokenScope =>
  (TOKEN_SCOPES as readonly string[]).includes(s);

export interface TokenRow {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  secret_hash: string;
  scopes: string;
  kind: TokenKind;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
  /** The connected app this token belongs to (ADR-063); null for personal tokens. */
  grant_id?: string | null;
}

export interface TokenDto {
  id: string;
  name: string;
  /** zkd_ + the public id: enough to recognise it, useless to sign in with. */
  prefix: string;
  scopes: TokenScope[];
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
}

const scopesOf = (s: string) => s.split(' ').filter(isScope);

const toDto = (r: TokenRow): TokenDto => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  scopes: scopesOf(r.scopes),
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  expiresAt: r.expires_at,
});

/** A new token's secret and its row values; the caller stores it (personal, or OAuth in A3). */
export async function mintToken(
  kind: 'access' | 'refresh' = 'access',
): Promise<{ token: string; prefix: string; hash: string }> {
  const head = kind === 'refresh' ? REFRESH_PREFIX : TOKEN_PREFIX;
  const id = randomBase62(ID_LEN);
  const token = `${head}${id}${randomBase62(SECRET_LEN)}`;
  return { token, prefix: `${head}${id}`, hash: await sha256Hex(token) };
}

export interface CreateTokenInput {
  name: string;
  scopes: TokenScope[];
  /** Days until it stops working; null = never. */
  expiresInDays: number | null;
}

/** Personal token from Settings. The secret is returned once and never again. */
export async function createToken(
  ctx: Ctx,
  userId: string,
  input: CreateTokenInput,
): Promise<{ token: string; info: TokenDto }> {
  const cfg = await ctx.config();
  const name = input.name.trim();
  if (!name) throw new AppError('VALIDATION', 'a name is required', { field: 'name' });
  const scopes = [...new Set(input.scopes)].filter(isScope);
  if (!scopes.length)
    throw new AppError('VALIDATION', 'pick at least one scope', { field: 'scopes' });
  const open = await ctx.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?1 AND kind = 'personal' AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > ?2)`,
  )
    .bind(userId, ctx.now())
    .first<{ n: number }>();
  if ((open?.n ?? 0) >= cfg.api_tokens_max_per_user)
    throw new AppError('CONFLICT', 'too many tokens', { reason: 'too_many_tokens' });
  const now = ctx.now();
  const { token, prefix, hash } = await mintToken();
  const row: TokenRow = {
    id: ulid(now),
    user_id: userId,
    name: name.slice(0, 80),
    prefix,
    secret_hash: hash,
    scopes: scopes.join(' '),
    kind: 'personal',
    created_at: now,
    last_used_at: null,
    expires_at: input.expiresInDays === null ? null : now + input.expiresInDays * DAY_MS,
    revoked_at: null,
  };
  await insertToken(ctx, row);
  return { token, info: toDto(row) };
}

export async function insertToken(ctx: Ctx, row: TokenRow): Promise<void> {
  await ctx.env.DB.prepare(
    `INSERT INTO api_tokens (id, user_id, name, prefix, secret_hash, scopes, kind, created_at, expires_at, grant_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  )
    .bind(
      row.id,
      row.user_id,
      row.name,
      row.prefix,
      row.secret_hash,
      row.scopes,
      row.kind,
      row.created_at,
      row.expires_at,
      row.grant_id ?? null,
    )
    .run();
}

/** The user's working personal tokens, newest first. */
export async function listTokens(ctx: Ctx, userId: string): Promise<TokenDto[]> {
  const { results } = await ctx.env.DB.prepare(
    `SELECT * FROM api_tokens WHERE user_id = ?1 AND kind = 'personal' AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > ?2) ORDER BY created_at DESC`,
  )
    .bind(userId, ctx.now())
    .all<TokenRow>();
  return results.map(toDto);
}

/** Owner only; someone else's id is simply not found. */
export async function revokeToken(ctx: Ctx, userId: string, id: string): Promise<void> {
  const r = await ctx.env.DB.prepare(
    `UPDATE api_tokens SET revoked_at = ?3 WHERE id = ?1 AND user_id = ?2 AND kind = 'personal' AND revoked_at IS NULL`,
  )
    .bind(id, userId, ctx.now())
    .run();
  if (!r.meta.changes) throw new AppError('NOT_FOUND', 'no such token');
}

export interface TokenAuth {
  user: SessionUser;
  token: TokenRow;
  scopes: TokenScope[];
}

/**
 * The user behind `Authorization: Bearer zkd_…`, or an UNAUTHORIZED error. Revoked, expired or
 * unknown tokens, and frozen or deleted accounts, all fail the same way.
 */
export async function authenticateToken(
  ctx: Ctx,
  header: string | undefined,
  kinds: readonly TokenKind[] = ['personal', 'oauth_access'],
): Promise<TokenAuth> {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  const token = m?.[1] ?? '';
  const fail = () =>
    new AppError('UNAUTHORIZED', 'a valid access token is required', { reason: 'bad_token' });
  if (!TOKEN_RE.test(token)) throw fail();
  const row = await findToken(ctx, token);
  const now = ctx.now();
  if (
    !row ||
    !kinds.includes(row.kind) ||
    row.revoked_at !== null ||
    (row.expires_at !== null && row.expires_at <= now)
  )
    throw fail();
  if (row.u_status !== 'active')
    throw new AppError('ACCOUNT_SUSPENDED', 'this account cannot use the API', {
      reason: row.u_status,
    });
  if (row.last_used_at === null || now - row.last_used_at > TOUCH_EVERY_MS)
    await ctx.env.DB.prepare(`UPDATE api_tokens SET last_used_at = ?2 WHERE id = ?1`)
      .bind(row.id, now)
      .run();
  return {
    user: { id: row.user_id, email: row.u_email, name: row.u_name, status: row.u_status },
    token: row,
    scopes: scopesOf(row.scopes),
  };
}

/**
 * The row of a whole token (access or refresh) with its owner, or null when the id is unknown or
 * the secret is wrong; the hash is compared in constant time either way.
 */
export async function findToken(
  ctx: Ctx,
  token: string,
): Promise<
  (TokenRow & { u_email: string; u_name: string; u_status: SessionUser['status'] }) | null
> {
  const row = await ctx.env.DB.prepare(
    `SELECT t.*, u.email AS u_email, u.name AS u_name, u.status AS u_status
     FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.prefix = ?1`,
  )
    .bind(token.slice(0, TOKEN_PREFIX.length + ID_LEN))
    .first<TokenRow & { u_email: string; u_name: string; u_status: SessionUser['status'] }>();
  const hash = await sha256Hex(token);
  // Compared even when no row matched, so a miss and a wrong secret take the same time.
  const same = timingSafeEqual(row?.secret_hash ?? '0'.repeat(64), hash);
  return row && same ? row : null;
}

export function requireScope(auth: Pick<TokenAuth, 'scopes'>, scope: TokenScope): void {
  if (!auth.scopes.includes(scope))
    throw new AppError('FORBIDDEN', `this token lacks the ${scope} scope`, {
      reason: 'missing_scope',
      scope,
    });
}
