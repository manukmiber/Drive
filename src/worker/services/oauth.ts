// Sign-in for Zeiko's own apps (ADR-063): OAuth 2.0 authorization code with PKCE (RFC 6749, 7636,
// 8252), so an app never asks anyone to copy a token. Drive is the authorization server; the
// person approves on Drive's own page with their normal Drive session. Codes live a minute and work
// once; access tokens are short (zkd_), refresh tokens long (zkr_) and replaced on every use, and a
// refresh token used a second time ends the whole connection (someone copied it).
import { DAY_MS } from '../../shared/constants';
import type { Ctx } from '../context';
import { base64UrlEncode, sha256Hex, timingSafeEqual } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { randomBase62, ulid } from '../lib/ids';
import {
  findToken,
  insertToken,
  isScope,
  mintToken,
  REFRESH_RE,
  TOKEN_RE,
  TOKEN_SCOPES,
  type TokenScope,
} from './tokens';

export interface OAuthClient {
  id: string;
  name: string;
  /** Exact redirect URIs; `loopback` also allows http://127.0.0.1 or [::1] on any port (RFC 8252 §7.3). */
  redirectUris: (appOrigin: string) => string[];
  loopbackPaths: string[];
  scopes: readonly TokenScope[];
}

/** First-party apps only; others need registration and review first (ADR-063). */
export const OAUTH_CLIENTS: readonly OAuthClient[] = [
  {
    id: 'zeiko-android',
    name: 'Zeiko Drive for Android',
    // App Links (verified through /.well-known/assetlinks.json) and the app's own scheme.
    redirectUris: (o) => [`${o}/app/callback`, 'id.biz.zeiko.drive:/oauth/callback'],
    loopbackPaths: [],
    scopes: TOKEN_SCOPES,
  },
  {
    id: 'zeiko-desktop',
    name: 'Zeiko Drive for desktop',
    redirectUris: () => [],
    loopbackPaths: ['/callback'],
    scopes: TOKEN_SCOPES,
  },
  {
    id: 'zeiko-cli',
    name: 'Zeiko CLI',
    redirectUris: () => [],
    loopbackPaths: ['/callback'],
    scopes: TOKEN_SCOPES,
  },
];

export const clientById = (id: string) => OAUTH_CLIENTS.find((c) => c.id === id) ?? null;

/** RFC 6749 §5.2 error, answered as { error, error_description } with the right status. */
export class OAuthError extends Error {
  constructor(
    readonly error:
      | 'invalid_request'
      | 'invalid_client'
      | 'invalid_grant'
      | 'unsupported_grant_type'
      | 'invalid_scope',
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function redirectAllowed(client: OAuthClient, uri: string, appOrigin: string): boolean {
  if (client.redirectUris(appOrigin).includes(uri)) return true;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  return (
    u.protocol === 'http:' &&
    (u.hostname === '127.0.0.1' || u.hostname === '[::1]') &&
    client.loopbackPaths.includes(u.pathname) &&
    !u.username &&
    !u.password &&
    !u.hash
  );
}

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
}

export interface CheckedRequest {
  client: { id: string; name: string };
  redirectUri: string;
  scopes: TokenScope[];
  state: string;
  codeChallenge: string;
}

/**
 * Whether the app's request can be shown for approval. A wrong client or redirect URI is shown as
 * an error on Drive's page and never redirected to (RFC 6749 §4.1.2.1).
 */
export function checkAuthorize(appOrigin: string, r: AuthorizeRequest): CheckedRequest {
  const client = clientById(r.clientId);
  if (!client) throw new AppError('VALIDATION', 'unknown app', { reason: 'invalid_client' });
  if (!redirectAllowed(client, r.redirectUri, appOrigin))
    throw new AppError('VALIDATION', 'this return address is not registered for the app', {
      reason: 'invalid_redirect_uri',
    });
  if (r.codeChallengeMethod !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(r.codeChallenge))
    throw new AppError('VALIDATION', 'PKCE with S256 is required', { reason: 'invalid_request' });
  if (!r.state || r.state.length > 512)
    throw new AppError('VALIDATION', 'state is required', { reason: 'invalid_request' });
  const asked = [...new Set(r.scope.split(' ').filter(Boolean))];
  if (!asked.length || asked.some((s) => !isScope(s) || !client.scopes.includes(s)))
    throw new AppError('VALIDATION', 'unknown or not allowed scope', { reason: 'invalid_scope' });
  return {
    client: { id: client.id, name: client.name },
    redirectUri: r.redirectUri,
    scopes: asked as TokenScope[],
    state: r.state,
    codeChallenge: r.codeChallenge,
  };
}

/** The signed-in person said yes: a one-time code for the app, sent back on its redirect URI. */
export async function approve(
  ctx: Ctx,
  userId: string,
  r: AuthorizeRequest,
): Promise<{ redirect: string }> {
  const ok = checkAuthorize(ctx.env.APP_ORIGIN, r);
  const cfg = await ctx.config();
  const code = randomBase62(43);
  await ctx.env.DB.prepare(
    `INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, scopes, code_challenge, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(
      await sha256Hex(code),
      ok.client.id,
      userId,
      ok.redirectUri,
      ok.scopes.join(' '),
      ok.codeChallenge,
      ctx.now() + cfg.oauth_code_ttl_seconds * 1000,
    )
    .run();
  return { redirect: withParams(ok.redirectUri, { code, state: ok.state }) };
}

/** The person said no: the app hears access_denied. */
export function deny(appOrigin: string, r: AuthorizeRequest): { redirect: string } {
  const ok = checkAuthorize(appOrigin, r);
  return { redirect: withParams(ok.redirectUri, { error: 'access_denied', state: ok.state }) };
}

function withParams(uri: string, params: Record<string, string>): string {
  const q = new URLSearchParams(params).toString();
  return `${uri}${uri.includes('?') ? '&' : '?'}${q}`;
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

async function issue(
  ctx: Ctx,
  grant: { id: string; user_id: string; client_id: string; scopes: string },
): Promise<TokenResponse> {
  const cfg = await ctx.config();
  const now = ctx.now();
  const name = clientById(grant.client_id)?.name ?? grant.client_id;
  const access = await mintToken('access');
  const refresh = await mintToken('refresh');
  const base = {
    user_id: grant.user_id,
    name,
    scopes: grant.scopes,
    created_at: now,
    last_used_at: null,
    revoked_at: null,
    grant_id: grant.id,
  };
  await insertToken(ctx, {
    ...base,
    id: ulid(now),
    prefix: access.prefix,
    secret_hash: access.hash,
    kind: 'oauth_access',
    expires_at: now + cfg.oauth_access_ttl_seconds * 1000,
  });
  await insertToken(ctx, {
    ...base,
    id: ulid(now),
    prefix: refresh.prefix,
    secret_hash: refresh.hash,
    kind: 'oauth_refresh',
    expires_at: now + cfg.oauth_refresh_ttl_days * DAY_MS,
  });
  await ctx.env.DB.prepare(`UPDATE oauth_grants SET last_used_at = ?2 WHERE id = ?1`)
    .bind(grant.id, now)
    .run();
  return {
    access_token: access.token,
    token_type: 'Bearer',
    expires_in: cfg.oauth_access_ttl_seconds,
    refresh_token: refresh.token,
    scope: grant.scopes,
  };
}

/** Ends a connection: the grant and every token it gave out. */
export async function revokeGrant(ctx: Ctx, grantId: string): Promise<void> {
  const now = ctx.now();
  const DB = ctx.env.DB;
  await DB.batch([
    DB.prepare(`UPDATE oauth_grants SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL`).bind(
      grantId,
      now,
    ),
    DB.prepare(
      `UPDATE api_tokens SET revoked_at = ?2 WHERE grant_id = ?1 AND revoked_at IS NULL`,
    ).bind(grantId, now),
  ]);
}

const pkceOk = async (verifier: string, challenge: string) =>
  /^[A-Za-z0-9\-._~]{43,128}$/.test(verifier) &&
  timingSafeEqual(
    base64UrlEncode(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
    ),
    challenge,
  );

/** grant_type=authorization_code */
export async function exchangeCode(
  ctx: Ctx,
  p: { code: string; redirectUri: string; clientId: string; codeVerifier: string },
): Promise<TokenResponse> {
  if (!clientById(p.clientId)) throw new OAuthError('invalid_client', 'unknown client', 401);
  const hash = await sha256Hex(p.code);
  const row = await ctx.env.DB.prepare(`SELECT * FROM oauth_codes WHERE code_hash = ?1`)
    .bind(hash)
    .first<{
      client_id: string;
      user_id: string;
      redirect_uri: string;
      scopes: string;
      code_challenge: string;
      expires_at: number;
      used_at: number | null;
      grant_id: string | null;
    }>();
  const bad = () => new OAuthError('invalid_grant', 'the code is not valid');
  if (!row) throw bad();
  if (row.used_at !== null) {
    // Used twice: whatever the first exchange made is revoked too (RFC 6749 §4.1.2).
    if (row.grant_id) await revokeGrant(ctx, row.grant_id);
    throw bad();
  }
  if (
    row.expires_at <= ctx.now() ||
    row.client_id !== p.clientId ||
    row.redirect_uri !== p.redirectUri ||
    !(await pkceOk(p.codeVerifier, row.code_challenge))
  )
    throw bad();
  const user = await ctx.env.DB.prepare(`SELECT status FROM users WHERE id = ?1`)
    .bind(row.user_id)
    .first<{ status: string }>();
  if (user?.status !== 'active') throw bad();
  const now = ctx.now();
  const grantId = ulid(now);
  // Claim the code and open the grant together: of two exchanges at once, one wins.
  const DB = ctx.env.DB;
  const [claim] = await DB.batch([
    DB.prepare(
      `UPDATE oauth_codes SET used_at = ?2, grant_id = ?3 WHERE code_hash = ?1 AND used_at IS NULL`,
    ).bind(hash, now, grantId),
    DB.prepare(
      `INSERT INTO oauth_grants (id, user_id, client_id, scopes, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5 WHERE changes() = 1`,
    ).bind(grantId, row.user_id, row.client_id, row.scopes, now),
  ]);
  if (!claim?.meta.changes) throw bad();
  return issue(ctx, {
    id: grantId,
    user_id: row.user_id,
    client_id: row.client_id,
    scopes: row.scopes,
  });
}

/** grant_type=refresh_token: a new pair; the old refresh token stops working. */
export async function refresh(
  ctx: Ctx,
  p: { refreshToken: string; clientId: string },
): Promise<TokenResponse> {
  const bad = () => new OAuthError('invalid_grant', 'the refresh token is not valid');
  if (!REFRESH_RE.test(p.refreshToken)) throw bad();
  const row = await findToken(ctx, p.refreshToken);
  if (!row || row.kind !== 'oauth_refresh' || !row.grant_id) throw bad();
  const grant = await ctx.env.DB.prepare(`SELECT * FROM oauth_grants WHERE id = ?1`)
    .bind(row.grant_id)
    .first<{
      id: string;
      user_id: string;
      client_id: string;
      scopes: string;
      revoked_at: number | null;
    }>();
  if (!grant || grant.client_id !== p.clientId) throw bad();
  if (row.revoked_at !== null) {
    // An old refresh token again: someone else has a copy. End the connection.
    await revokeGrant(ctx, grant.id);
    throw bad();
  }
  if (grant.revoked_at !== null || (row.expires_at !== null && row.expires_at <= ctx.now()))
    throw bad();
  if (row.u_status !== 'active') throw bad();
  const used = await ctx.env.DB.prepare(
    `UPDATE api_tokens SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL`,
  )
    .bind(row.id, ctx.now())
    .run();
  if (!used.meta.changes) {
    await revokeGrant(ctx, grant.id);
    throw bad();
  }
  return issue(ctx, grant);
}

/** RFC 7009: an access token ends itself; a refresh token ends the connection. Unknown: no error. */
export async function revokeToken(ctx: Ctx, token: string, clientId: string): Promise<void> {
  if (!TOKEN_RE.test(token) && !REFRESH_RE.test(token)) return;
  const row = await findToken(ctx, token);
  if (!row?.grant_id) return;
  const grant = await ctx.env.DB.prepare(`SELECT client_id FROM oauth_grants WHERE id = ?1`)
    .bind(row.grant_id)
    .first<{ client_id: string }>();
  if (grant?.client_id !== clientId) return;
  if (row.kind === 'oauth_refresh') await revokeGrant(ctx, row.grant_id);
  else
    await ctx.env.DB.prepare(
      `UPDATE api_tokens SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL`,
    )
      .bind(row.id, ctx.now())
      .run();
}

export interface ConnectedApp {
  id: string;
  clientId: string;
  name: string;
  scopes: TokenScope[];
  createdAt: number;
  lastUsedAt: number | null;
}

/** Settings → Tokens & apps: the apps connected to this account. */
export async function listApps(ctx: Ctx, userId: string): Promise<ConnectedApp[]> {
  const { results } = await ctx.env.DB.prepare(
    `SELECT id, client_id, scopes, created_at, last_used_at FROM oauth_grants
     WHERE user_id = ?1 AND revoked_at IS NULL ORDER BY created_at DESC`,
  )
    .bind(userId)
    .all<{
      id: string;
      client_id: string;
      scopes: string;
      created_at: number;
      last_used_at: number | null;
    }>();
  return results.map((g) => ({
    id: g.id,
    clientId: g.client_id,
    name: clientById(g.client_id)?.name ?? g.client_id,
    scopes: g.scopes.split(' ').filter(isScope),
    createdAt: g.created_at,
    lastUsedAt: g.last_used_at,
  }));
}

/** Owner only; someone else's grant is simply not found. */
export async function disconnectApp(ctx: Ctx, userId: string, grantId: string): Promise<void> {
  const g = await ctx.env.DB.prepare(
    `SELECT id FROM oauth_grants WHERE id = ?1 AND user_id = ?2 AND revoked_at IS NULL`,
  )
    .bind(grantId, userId)
    .first<{ id: string }>();
  if (!g) throw new AppError('NOT_FOUND', 'no such app');
  await revokeGrant(ctx, g.id);
}
