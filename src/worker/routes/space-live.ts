// W3 (ADR-096): GET /api/spaces/:id/live with `Upgrade: websocket` — the app's connection to the
// Space's live room. Answered before every other middleware, because those rebuild responses to add
// headers and a 101 must reach the browser exactly as the room made it. So the checks the API does
// elsewhere are done here: the app's Origin (a browser always sends it on a WebSocket handshake, and
// it stands in for the CSRF token, which a WebSocket cannot carry), the session, the account, the
// person's role in the Space, and the team's status. The room trusts what it is handed.
import { getAuth } from '../auth';
import { createCtx } from '../context';
import type { Env } from '../env';
import { requestLang } from '../lib/lang';
import { securityEvent } from '../lib/log';
import { errorBody } from '../middleware/errors';
import { roomStub } from '../services/space-room';
import { spaceRole } from '../services/spaces';

const LIVE = /^\/api\/spaces\/([0-9A-HJKMNP-TV-Z]{26})\/live$/;

/** The Space id when this request asks for its live room. */
export function liveSpaceOf(req: Request): string | null {
  if (req.method !== 'GET') return null;
  return LIVE.exec(new URL(req.url).pathname)?.[1] ?? null;
}

const fail = (status: number, code: string, message: string) =>
  Response.json(errorBody(code, message), {
    status,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });

export async function spaceLive(
  req: Request,
  env: Env,
  waitUntil: ((p: Promise<unknown>) => void) | undefined,
  spaceId: string,
): Promise<Response> {
  if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket')
    return fail(426, 'BAD_REQUEST', 'expected a WebSocket');
  const stub = roomStub(env, spaceId);
  if (!stub) return fail(404, 'NOT_FOUND', 'not found');
  if (req.headers.get('origin') !== env.APP_ORIGIN) {
    securityEvent('authz_fail', { what: 'origin' });
    return fail(403, 'ORIGIN_MISMATCH', 'origin not allowed');
  }
  const ctx = createCtx(env, waitUntil);
  const session = await getAuth(ctx).api.getSession({ headers: req.headers });
  if (!session) return fail(401, 'UNAUTHORIZED', 'sign in required');
  const user = session.user as typeof session.user & { status?: string };
  if ((user.status ?? 'active') !== 'active') return fail(403, 'FORBIDDEN', 'account suspended');
  const r = await spaceRole(ctx, user.id, spaceId);
  if (!r) return fail(404, 'NOT_FOUND', 'not found');
  if (r.team.status === 'frozen') return fail(403, 'READ_ONLY', 'this team is frozen');
  return stub.fetch(
    new Request('https://room/connect', {
      headers: {
        upgrade: 'websocket',
        'x-zk-space': spaceId,
        'x-zk-user': user.id,
        'x-zk-name': user.name || user.email,
        'x-zk-role': r.role,
        'x-zk-readonly': r.team.status === 'active' ? '0' : '1',
        'x-zk-lang': requestLang(req),
      },
    }),
  );
}
