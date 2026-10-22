// Public share links: /{r64}/{s32}/{nama} (SPEC §6.1). One click → download (file → the file,
// folder/bundle → streamed ZIP). Preview bots get Open Graph HTML and never count as downloads.
import { Hono, type Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { formatBytes } from '../../shared/format';
import type { Strings } from '../../shared/strings.id';
import { requestLang, strings } from '../lib/lang';
import { track } from '../lib/analytics';
import { hashIp, hmacBase62, sha256Hex, timingSafeEqual } from '../lib/crypto';
import { contentDisposition, parseRange } from '../lib/http';
import { isPreviewBot, page } from '../lib/pages';
import { shareAdHtml } from './ads';
import { serveObject } from '../lib/serve';
import { planZip, withKnownLength, zipStream } from '../lib/zip';
import { clientIp, enforceRateLimit } from '../middleware/ratelimit';
import { collectEntries } from '../services/archive';
import { escapeHtml } from '../services/email-templates';
import {
  countDownload,
  getShareRow,
  shareState,
  verifyPassword,
  verifyShareSignature,
  type DeadReason,
  type ShareRow,
} from '../services/shares';
import { wibDate } from '../../shared/time';
import type { AppBindings } from '../types';
import { appPath } from '../lib/paths';

function deadText(tr: Strings, reason: DeadReason): string {
  const text: Record<DeadReason, string> = {
    not_found: tr.share.linkNotFound,
    revoked: tr.share.revokedText,
    expired: tr.share.linkExpired,
    limit: tr.share.limitText,
    disabled: tr.share.disabledText,
  };
  return text[reason];
}

function dead(c: Context<AppBindings>, reason: DeadReason, r64?: string, ad = ''): Response {
  const lang = requestLang(c.req.raw);
  const tr = strings(lang);
  const text = deadText(tr, reason);
  return page(text, `<h1>${escapeHtml(text)}</h1><p>${escapeHtml(tr.share.askNew)}</p>`, {
    status: reason === 'not_found' ? 404 : 410,
    ad,
    lang,
    reportLabel: tr.share.report,
    ...(r64 ? { reportUrl: appPath(c.env, `/lapor?share=${r64}`) } : {}),
  });
}

async function passCookieValue(secret: string, r64: string, exp: number): Promise<string> {
  return `${exp}.${await hmacBase62(secret, `sp|${r64}|${exp}`, 32)}`;
}

async function hasPassCookie(c: Context<AppBindings>, r64: string): Promise<boolean> {
  const v = getCookie(c, 'zk_sp');
  if (!v) return false;
  const [expStr] = v.split('.');
  const exp = Number(expStr);
  if (!exp || exp * 1000 < c.get('ctx').now()) return false;
  return timingSafeEqual(v, await passCookieValue(c.env.DOWNLOAD_SECRET, r64, exp));
}

function passwordPage(c: Context<AppBindings>, error: boolean, r64: string, ad = ''): Response {
  const lang = requestLang(c.req.raw);
  const tr = strings(lang);
  return page(
    tr.share.passwordTitle,
    `<h1>${escapeHtml(tr.share.passwordTitle)}</h1><p>${escapeHtml(tr.share.passwordBody)}</p>
<form method="post"><input type="password" name="password" required autofocus autocomplete="current-password" aria-label="${escapeHtml(tr.share.passwordLabel)}">
${error ? `<p class="err">${escapeHtml(tr.share.passwordWrong)}</p>` : ''}<button type="submit">${escapeHtml(tr.share.downloadNow)}</button></form>`,
    {
      status: error ? 401 : 200,
      reportUrl: appPath(c.env, `/lapor?share=${r64}`),
      ad,
      lang,
      reportLabel: tr.share.report,
    },
  );
}

async function ogPage(c: Context<AppBindings>, s: ShareRow, url: string): Promise<Response> {
  const size = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(n.size), 0) AS total, COUNT(*) AS n FROM share_items i JOIN nodes n ON n.id = i.node_id WHERE i.share_id = ?1`,
  )
    .bind(s.id)
    .first<{ total: number; n: number }>();
  const lang = requestLang(c.req.raw);
  const tr = strings(lang);
  const desc = `${s.kind === 'file' ? formatBytes(size?.total ?? 0) : s.kind === 'folder' ? tr.share.folder : tr.share.fileCount(size?.n ?? 0)} · ${tr.share.directDownload}`;
  const head = `<meta property="og:title" content="${escapeHtml(s.title)}"><meta property="og:description" content="${escapeHtml(desc)}">
<meta property="og:site_name" content="Zeiko Drive"><meta property="og:type" content="website"><meta property="og:url" content="${escapeHtml(url)}">
<meta property="og:image" content="${escapeHtml(new URL('/og.png', c.env.APP_ORIGIN).toString())}"><meta name="twitter:card" content="summary">`;
  return page(s.title, `<h1>${escapeHtml(s.title)}</h1><p>${escapeHtml(desc)}</p>`, { head, lang });
}

export const sharePublic = new Hono<AppBindings>().on(
  ['GET', 'HEAD', 'POST'],
  '/:r64{[0-9A-Za-z]{64}}/:s32{[0-9A-Za-z]{32}}/:name?',
  async (c) => {
    const ctx = c.get('ctx');
    const { r64, s32 } = c.req.param();
    // Forged or guessed links are rejected without touching D1.
    if (!(await verifyShareSignature(c.env, r64, s32))) return dead(c, 'not_found');
    const ip = clientIp(c.req.raw);
    await enforceRateLimit(c.env, 'RL_DOWNLOAD', `share:${ip}:${r64.slice(0, 16)}`);

    const s = await getShareRow(ctx, r64);
    const state = await shareState(ctx, s);
    const ua = c.req.header('user-agent') ?? null;
    if (state === 'limit' && s) {
      // Resuming a download that was already counted is still allowed.
      const fp = await hashIp(c.env.IP_HASH_SECRET, `${ip}|${ua ?? ''}`, wibDate(ctx.now()));
      if (!(await c.env.CONFIG_KV.get(`sd:${s.id.slice(0, 24)}:${fp}`)))
        return dead(c, 'limit', r64, await shareAdHtml(c, s.created_by));
    } else if (state) return dead(c, state, r64, await shareAdHtml(c, s?.created_by ?? null));
    const share = s!;

    if (isPreviewBot(ua)) return ogPage(c, share, c.req.url);

    if (share.password_hash) {
      if (c.req.method === 'POST') {
        const form = await c.req.parseBody();
        const ok =
          typeof form.password === 'string' &&
          (await verifyPassword(share.password_hash, form.password));
        if (!ok) return passwordPage(c, true, r64, await shareAdHtml(c, share.created_by));
        const cfg = await ctx.config();
        const exp = Math.floor(ctx.now() / 1000) + cfg.share_password_cookie_minutes * 60;
        setCookie(c, 'zk_sp', await passCookieValue(c.env.DOWNLOAD_SECRET, r64, exp), {
          path: `/${r64}/`,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
          maxAge: cfg.share_password_cookie_minutes * 60,
        });
        return c.redirect(new URL(c.req.url).pathname, 303);
      }
      if (!(await hasPassCookie(c, r64)))
        return passwordPage(c, false, r64, await shareAdHtml(c, share.created_by));
    } else if (c.req.method === 'POST') {
      return c.redirect(new URL(c.req.url).pathname, 303);
    }

    const fp = await hashIp(c.env.IP_HASH_SECRET, `${ip}|${ua ?? ''}`, wibDate(ctx.now()));
    const range = c.req.header('range');
    const startsAtZero = !range || /^bytes=0-/.test(range.trim());
    const counts = c.req.method === 'GET' && startsAtZero;

    if (share.kind === 'file') {
      const row = await c.env.DB.prepare(
        `SELECT n.id, n.name, n.mime, n.status, b.id AS blob_id, b.r2_key, b.size, b.scan_status, b.sniffed_mime
         FROM share_items i JOIN nodes n ON n.id = i.node_id JOIN blobs b ON b.id = n.blob_id
         WHERE i.share_id = ?1 AND n.trashed_at IS NULL`,
      )
        .bind(share.id)
        .first<{
          id: string;
          name: string;
          mime: string | null;
          status: string;
          blob_id: string;
          r2_key: string;
          size: number;
          scan_status: string;
          sniffed_mime: string | null;
        }>();
      if (!row || row.status !== 'ready' || !['clean', 'skipped'].includes(row.scan_status))
        return dead(c, 'not_found', r64);
      if (counts && !(await countDownload(ctx, share, fp))) return dead(c, 'limit', r64);
      const { response, bytes } = await serveObject(c.env.BUCKET, c.req.raw, {
        key: row.r2_key,
        size: row.size,
        etag: `"${row.blob_id}"`,
        filename: row.name,
        contentType: row.sniffed_mime ?? row.mime ?? 'application/octet-stream',
        disposition: 'attachment',
      });
      if (bytes) track(c.env.ANALYTICS, 'share_download', { doubles: [bytes] });
      return response;
    }

    // Folder (live content) or bundle (fixed items) → ZIP store, Range-capable.
    const { results: items } = await c.env.DB.prepare(
      'SELECT node_id FROM share_items WHERE share_id = ?1',
    )
      .bind(share.id)
      .all<{ node_id: string }>();
    const content = await collectEntries(
      ctx,
      items.map((i) => i.node_id),
    );
    if (!content.fileCount && !content.entries.length) return dead(c, 'not_found', r64);
    const plan = planZip(content.entries);
    const etag = `"z${(await sha256Hex(JSON.stringify(content.entries.map((e) => [e.path, e.key, e.size])))).slice(0, 32)}"`;
    const filename = `Zeiko-${share.title}.zip`;
    const headers = new Headers({
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDisposition(filename),
      'Accept-Ranges': 'bytes',
      ETag: etag,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    let r = parseRange(range, plan.size);
    const ifRange = c.req.header('if-range');
    if (r.kind !== 'none' && ifRange && ifRange !== etag) r = { kind: 'none' };
    if (r.kind === 'unsatisfiable') {
      headers.set('Content-Range', `bytes */${plan.size}`);
      return new Response(null, { status: 416, headers });
    }
    if (counts && !(await countDownload(ctx, share, fp))) return dead(c, 'limit', r64);
    if (r.kind === 'single') {
      const len = r.end - r.start + 1;
      headers.set('Content-Range', `bytes ${r.start}-${r.end}/${plan.size}`);
      headers.set('Content-Length', String(len));
      if (c.req.method === 'HEAD') return new Response(null, { status: 206, headers });
      return new Response(withKnownLength(zipStream(c.env.BUCKET, plan, r.start, r.end), len), {
        status: 206,
        headers,
      });
    }
    headers.set('Content-Length', String(plan.size));
    if (c.req.method === 'HEAD') return new Response(null, { status: 200, headers });
    track(c.env.ANALYTICS, 'share_download', { doubles: [plan.size] });
    return new Response(withKnownLength(zipStream(c.env.BUCKET, plan), plan.size), {
      status: 200,
      headers,
    });
  },
);
