// Local, non-intrusive ads (SPEC §10, ADR-032, ADR-043). An advertiser emails the operator; the
// operator enters the creative and a campaign (national, or cities), checks the creative by hand,
// and the advertiser pays once it is approved. No slots: every live campaign for a viewer's city
// and every national one rotate in the card, one every `ad_rotate_seconds`. Region-only serving,
// no user IDs in ad events.
import {
  AD_BODY_MAX,
  AD_TITLE_MAX,
  adCampaignPricePerDay,
  bannedTopic,
  type AdCategory,
  type AdCtaType,
  type AdPlacement,
} from '../../shared/ad-policy';
import type { AdCampaignScope, AdCampaignStatus } from '../../shared/enums';
import { addDaysWib, wibDate } from '../../shared/time';
import type { Ctx } from '../context';
import { track } from '../lib/analytics';
import { hmacBase62, timingSafeEqual } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { randomBase62, ulid } from '../lib/ids';
import { AD_CONTACT } from '../../shared/constants';
import {
  invoiceStmts,
  openPayment,
  walletBalance,
  walletStmts,
  withTax,
} from './billing';
import { notify } from './notify';
import { appPath } from '../lib/paths';

type Stmt = D1PreparedStatement;

// ───────────────────────────── areas ─────────────────────────────

export interface AreaRow {
  code: string;
  name: string;
  level: 'national' | 'province' | 'regency';
  parent_code: string | null;
  tier: 'tier1' | 'tier2' | 'tier3' | 'province' | 'national';
  cf_aliases_json: string;
}

interface AreaIndex {
  byCode: Map<string, AreaRow>;
  provinces: Map<string, AreaRow>;
  regencies: Array<{ row: AreaRow; aliases: Set<string>; name: string }>;
}

const areaMemo = new WeakMap<D1Database, { at: number; index: AreaIndex }>();

/** "Kota Malang", "South Jakarta", "Special Region of Yogyakarta" → comparable keys. */
export function normalizeAreaName(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[–—_.,'’-]/g, ' ')
    .replace(
      /^(kota administrasi|kota adm|kota|kabupaten|kab|provinsi|province of|special region of|daerah istimewa|daerah khusus ibukota|dki)\s+/,
      '',
    )
    .replace(/\s+(city|regency|province)$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function areaIndex(ctx: Ctx): Promise<AreaIndex> {
  const m = areaMemo.get(ctx.env.DB);
  if (m && ctx.now() - m.at < 300_000) return m.index;
  const { results } = await ctx.env.DB.prepare('SELECT * FROM ad_areas').all<AreaRow>();
  const index: AreaIndex = { byCode: new Map(), provinces: new Map(), regencies: [] };
  for (const r of results) {
    index.byCode.set(r.code, r);
    const aliases = new Set((JSON.parse(r.cf_aliases_json) as string[]).map(normalizeAreaName));
    if (r.level === 'province') {
      index.provinces.set(normalizeAreaName(r.name), r);
      for (const a of aliases) if (!index.provinces.has(a)) index.provinces.set(a, r);
    } else if (r.level === 'regency') {
      index.regencies.push({ row: r, aliases, name: normalizeAreaName(r.name) });
    }
  }
  areaMemo.set(ctx.env.DB, { at: ctx.now(), index });
  return index;
}

export interface Geo {
  /** Kota pilihan user di Pengaturan (area code). */
  userCity?: string | null | undefined;
  city?: string | null | undefined;
  region?: string | null | undefined;
  country?: string | null | undefined;
}

function chainFrom(index: AreaIndex, code: string): string[] {
  const out: string[] = [];
  for (
    let c: string | null = code;
    c && out.length < 4;
    c = index.byCode.get(c)?.parent_code ?? null
  ) {
    if (!index.byCode.has(c)) break;
    out.push(c);
  }
  if (!out.includes('ID')) out.push('ID');
  return out;
}

/** Most specific area first, ending with 'ID' (SPEC §10.3: pilihan user → cf.city → cf.region → nasional). */
export async function resolveAreaChain(ctx: Ctx, geo: Geo): Promise<string[]> {
  const index = await areaIndex(ctx);
  if (geo.userCity && index.byCode.has(geo.userCity)) return chainFrom(index, geo.userCity);
  if (geo.country && geo.country.toUpperCase() !== 'ID') return ['ID'];
  const province = geo.region ? index.provinces.get(normalizeAreaName(geo.region)) : undefined;
  if (geo.city) {
    const key = normalizeAreaName(geo.city);
    const inProvince = (r: AreaRow) => !province || r.parent_code === province.code;
    const pick =
      index.regencies.find((x) => inProvince(x.row) && x.aliases.has(key)) ??
      index.regencies.find(
        (x) => inProvince(x.row) && x.name === key && x.row.name.startsWith('Kota '),
      ) ??
      index.regencies.find((x) => inProvince(x.row) && x.name === key) ??
      (province ? undefined : index.regencies.find((x) => x.aliases.has(key)));
    if (pick) return chainFrom(index, pick.row.code);
  }
  if (province) return chainFrom(index, province.code);
  return ['ID'];
}

export async function searchAreas(
  ctx: Ctx,
  q: string,
  limit = 20,
): Promise<Array<{ code: string; name: string; level: string; province: string | null }>> {
  const index = await areaIndex(ctx);
  const exact = index.byCode.get(q.trim());
  const key = normalizeAreaName(q);
  const all = exact ? [exact] : [...index.byCode.values()].filter((a) => a.code !== 'ID');
  const hits =
    key && !exact
      ? all.filter(
          (a) =>
            normalizeAreaName(a.name).includes(key) ||
            (JSON.parse(a.cf_aliases_json) as string[]).some((x) =>
              normalizeAreaName(x).includes(key),
            ),
        )
      : all;
  return hits
    .sort((a, b) =>
      a.level === b.level ? a.name.localeCompare(b.name) : a.level === 'regency' ? -1 : 1,
    )
    .slice(0, limit)
    .map((a) => ({
      code: a.code,
      name: a.name,
      level: a.level,
      province:
        a.parent_code && a.parent_code !== 'ID'
          ? (index.byCode.get(a.parent_code)?.name ?? null)
          : null,
    }));
}

/**
 * The ad area a typed city names (ADR-041: the city on the Zeiko Account): a city or regency
 * first, else a province, else null (national ads only).
 */
export async function areaForCity(ctx: Ctx, city: string): Promise<string | null> {
  const key = normalizeAreaName(city);
  if (!key) return null;
  const index = await areaIndex(ctx);
  const pick =
    index.regencies.find((x) => x.aliases.has(key)) ??
    index.regencies.find((x) => x.name === key && x.row.name.startsWith('Kota ')) ??
    index.regencies.find((x) => x.name === key);
  return pick?.row.code ?? index.provinces.get(key)?.code ?? null;
}

export async function areaName(ctx: Ctx, code: string): Promise<string | null> {
  return (await areaIndex(ctx)).byCode.get(code)?.name ?? null;
}

// ───────────────────────────── advertisers ─────────────────────────────

export interface AdvertiserRow {
  user_id: string;
  business_name: string;
  kind: 'umkm' | 'mahasiswa' | 'lainnya';
  student_verified: number;
  student_email: string | null;
  phone: string;
  created_at: number;
}

export async function getAdvertiser(ctx: Ctx, userId: string): Promise<AdvertiserRow | null> {
  return ctx.env.DB.prepare('SELECT * FROM advertisers WHERE user_id = ?1')
    .bind(userId)
    .first<AdvertiserRow>();
}

async function requireAdvertiser(ctx: Ctx, userId: string): Promise<AdvertiserRow> {
  const a = await getAdvertiser(ctx, userId);
  if (!a) throw new AppError('NOT_FOUND', 'NOT_ADVERTISER');
  return a;
}

/**
 * The Drive account an advertiser's email names (ADR-043). Their dashboard is /iklan in Drive, so
 * they must have signed in to Drive once with their Zeiko Account before an ad can be entered.
 */
export async function driveUserByEmail(
  ctx: Ctx,
  email: string,
): Promise<{ id: string; email: string; name: string | null }> {
  const u = await ctx.env.DB.prepare(
    'SELECT id, email, name FROM users WHERE lower(email) = lower(?1) LIMIT 1',
  )
    .bind(email.trim())
    .first<{ id: string; email: string; name: string | null }>();
  if (!u) throw new AppError('NOT_FOUND', 'NO_DRIVE_USER', { field: 'email' });
  return u;
}

export function normalizePhone(raw: string): string | null {
  const d = raw.replace(/[^\d+]/g, '').replace(/^\+/, '');
  const n = d.startsWith('62')
    ? d
    : d.startsWith('0')
      ? `62${d.slice(1)}`
      : d.startsWith('8')
        ? `62${d}`
        : d;
  return /^628\d{7,12}$/.test(n) ? n : null;
}

export async function upsertAdvertiser(
  ctx: Ctx,
  userId: string,
  p: { businessName: string; kind: AdvertiserRow['kind']; phone: string },
): Promise<AdvertiserRow> {
  const phone = normalizePhone(p.phone);
  if (!phone) throw new AppError('VALIDATION', 'invalid phone', { field: 'phone' });
  const name = p.businessName.trim().slice(0, 80);
  if (!name) throw new AppError('VALIDATION', 'business name required', { field: 'businessName' });
  if (bannedTopic(name))
    throw new AppError('VALIDATION', 'business name not allowed', { field: 'businessName' });
  await ctx.env.DB.prepare(
    `INSERT INTO advertisers (user_id, business_name, kind, phone, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (user_id) DO UPDATE SET business_name = excluded.business_name, phone = excluded.phone,
       kind = excluded.kind`,
  )
    .bind(userId, name, p.kind, phone, ctx.now())
    .run();
  return (await getAdvertiser(ctx, userId))!;
}

// ───────────────────────────── creatives ─────────────────────────────

export interface CreativeRow {
  id: string;
  advertiser_id: string;
  title: string;
  body: string;
  image_key: string | null;
  cta_type: AdCtaType;
  cta_value: string;
  category: AdCategory;
  status: 'draft' | 'pending' | 'approved' | 'rejected' | 'suspended';
  reject_reason: string | null;
  reviewed_by: string | null;
  reviewed_at: number | null;
  created_at: number;
  updated_at: number;
}

const SHORTENERS =
  /(^|\.)(bit\.ly|s\.id|tinyurl\.com|t\.co|cutt\.ly|shorturl\.at|rb\.gy|is\.gd|goo\.gl|ow\.ly|linktr\.ee|lnk\.bio)$/i;

/** CTA → final https URL, or a reason code. Only known destinations for the marketplace CTAs. */
export function ctaUrl(type: AdCtaType, value: string): { url: string } | { error: string } {
  const v = value.trim();
  const handle = v.replace(/^@/, '');
  switch (type) {
    case 'whatsapp': {
      const n = normalizePhone(v);
      return n ? { url: `https://wa.me/${n}` } : { error: 'CTA_PHONE' };
    }
    case 'instagram':
      return /^[a-z0-9._]{1,30}$/i.test(handle)
        ? { url: `https://www.instagram.com/${handle}` }
        : { error: 'CTA_HANDLE' };
    case 'tiktok':
      return /^[a-z0-9._]{2,24}$/i.test(handle)
        ? { url: `https://www.tiktok.com/@${handle}` }
        : { error: 'CTA_HANDLE' };
    case 'shopee':
    case 'tokopedia':
    case 'web': {
      let u: URL;
      try {
        u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
      } catch {
        return { error: 'CTA_URL' };
      }
      if (u.protocol !== 'https:' || u.username || u.password || u.port)
        return { error: 'CTA_URL' };
      const host = u.hostname.toLowerCase();
      if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':') || !host.includes('.'))
        return { error: 'CTA_URL' };
      if (host.startsWith('xn--') || host.includes('.xn--')) return { error: 'CTA_URL' };
      if (SHORTENERS.test(host)) return { error: 'CTA_SHORTENER' };
      if (type === 'shopee' && !/(^|\.)shopee\.co\.id$/.test(host)) return { error: 'CTA_URL' };
      if (type === 'tokopedia' && !/(^|\.)tokopedia\.com$/.test(host)) return { error: 'CTA_URL' };
      return { url: u.toString() };
    }
  }
}

export interface CreativeInput {
  title: string;
  body: string;
  ctaType: AdCtaType;
  ctaValue: string;
  category: AdCategory;
}

function validateCreative(i: CreativeInput): void {
  const title = i.title.trim();
  const body = i.body.trim();
  if (!title || title.length > AD_TITLE_MAX)
    throw new AppError('VALIDATION', 'title length', { field: 'title', max: AD_TITLE_MAX });
  if (!body || body.length > AD_BODY_MAX)
    throw new AppError('VALIDATION', 'body length', { field: 'body', max: AD_BODY_MAX });
  const cta = ctaUrl(i.ctaType, i.ctaValue);
  if ('error' in cta) throw new AppError('VALIDATION', cta.error, { field: 'ctaValue' });
}

/** Paid for or showing: its words and picture are what the advertiser bought, so they stay. */
async function hasRunningCampaigns(ctx: Ctx, creativeId: string): Promise<boolean> {
  const r = await ctx.env.DB.prepare(
    `SELECT 1 AS x FROM ad_campaigns WHERE creative_id = ?1 AND status IN ('paid', 'live') LIMIT 1`,
  )
    .bind(creativeId)
    .first();
  return Boolean(r);
}

/** A changed creative is checked again, and so are the campaigns waiting to be paid with it. */
function recheckStmts(ctx: Ctx, creativeId: string, now: number): Stmt[] {
  return [
    ctx.env.DB.prepare(
      `UPDATE ad_campaigns SET status = 'pending', updated_at = ?2 WHERE creative_id = ?1 AND status = 'awaiting_payment'`,
    ).bind(creativeId, now),
  ];
}

/** The operator writes an advertiser's creative (ADR-043); it waits for the manual check. */
export async function saveCreative(
  ctx: Ctx,
  userId: string,
  input: CreativeInput,
  id?: string,
): Promise<CreativeRow> {
  await requireAdvertiser(ctx, userId);
  validateCreative(input);
  const now = ctx.now();
  if (id) {
    const c = await requireCreative(ctx, userId, id);
    if (await hasRunningCampaigns(ctx, c.id)) throw new AppError('CONFLICT', 'CREATIVE_IN_USE');
    if (c.status === 'suspended') throw new AppError('FORBIDDEN', 'CREATIVE_SUSPENDED');
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        `UPDATE ad_creatives SET title = ?2, body = ?3, cta_type = ?4, cta_value = ?5, category = ?6,
           status = CASE WHEN image_key IS NULL THEN 'draft' ELSE 'pending' END, reject_reason = NULL,
           reviewed_by = NULL, reviewed_at = NULL, updated_at = ?7 WHERE id = ?1`,
      ).bind(
        id,
        input.title.trim(),
        input.body.trim(),
        input.ctaType,
        input.ctaValue.trim(),
        input.category,
        now,
      ),
      ...recheckStmts(ctx, id, now),
    ]);
    return requireCreative(ctx, userId, id);
  }
  const newId = ulid(now);
  await ctx.env.DB.prepare(
    `INSERT INTO ad_creatives (id, advertiser_id, title, body, cta_type, cta_value, category, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'draft', ?8, ?8)`,
  )
    .bind(
      newId,
      userId,
      input.title.trim(),
      input.body.trim(),
      input.ctaType,
      input.ctaValue.trim(),
      input.category,
      now,
    )
    .run();
  return requireCreative(ctx, userId, newId);
}

async function requireCreative(ctx: Ctx, userId: string, id: string): Promise<CreativeRow> {
  const c = await ctx.env.DB.prepare(
    'SELECT * FROM ad_creatives WHERE id = ?1 AND advertiser_id = ?2',
  )
    .bind(id, userId)
    .first<CreativeRow>();
  if (!c) throw new AppError('NOT_FOUND', 'creative not found');
  return c;
}

/** Square WebP check from the container header (VP8 / VP8L / VP8X). */
export function webpSize(b: Uint8Array): { width: number; height: number } | null {
  const ascii = (o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
  if (b.length < 30 || ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WEBP') return null;
  const chunk = ascii(12, 4);
  if (chunk === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: (b[26]! | (b[27]! << 8)) & 0x3fff, height: (b[28]! | (b[29]! << 8)) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    return {
      width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)),
      height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)),
    };
  }
  return null;
}

export async function setCreativeImage(
  ctx: Ctx,
  userId: string,
  id: string,
  bytes: Uint8Array,
): Promise<CreativeRow> {
  const c = await requireCreative(ctx, userId, id);
  if (await hasRunningCampaigns(ctx, c.id)) throw new AppError('CONFLICT', 'CREATIVE_IN_USE');
  if (c.status === 'suspended') throw new AppError('FORBIDDEN', 'CREATIVE_SUSPENDED');
  const cfg = await ctx.config();
  if (bytes.length > cfg.ad_image_max_bytes)
    throw new AppError('FILE_TOO_LARGE', 'ad image too large', { max: cfg.ad_image_max_bytes });
  const dim = webpSize(bytes);
  if (!dim) throw new AppError('VALIDATION', 'IMAGE_NOT_WEBP', { field: 'image' });
  if (dim.width < 200 || Math.abs(dim.width - dim.height) > Math.max(2, dim.width * 0.02)) {
    throw new AppError('VALIDATION', 'IMAGE_NOT_SQUARE', { field: 'image', ...dim });
  }
  const key = `ads/${c.id}/${randomBase62(10)}.webp`;
  await ctx.env.BUCKET.put(key, bytes, { httpMetadata: { contentType: 'image/webp' } });
  const now = ctx.now();
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `UPDATE ad_creatives SET image_key = ?2, status = 'pending', reject_reason = NULL, reviewed_by = NULL,
         reviewed_at = NULL, updated_at = ?3 WHERE id = ?1`,
    ).bind(c.id, key, now),
    ...recheckStmts(ctx, c.id, now),
  ]);
  if (c.image_key) await ctx.env.BUCKET.delete(c.image_key);
  return requireCreative(ctx, userId, id);
}

// ───────────────────────────── the manual check ─────────────────────────────

async function auditAd(
  ctx: Ctx,
  actorId: string,
  action: string,
  targetType: 'ad_creative' | 'ad_campaign',
  targetId: string,
  meta: unknown,
): Promise<void> {
  await ctx.env.DB.prepare(
    `INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(ulid(ctx.now()), actorId, action, targetType, targetId, JSON.stringify(meta ?? null), ctx.now())
    .run();
}

/**
 * Creatives in `status` for the check (ADR-043): UMKM, small businesses and students first, then the
 * oldest. `flag` names a prohibited topic its words look like, for the person checking; it decides
 * nothing.
 */
export async function listCreativesForReview(ctx: Ctx, status: CreativeRow['status'] = 'pending') {
  const { results } = await ctx.env.DB.prepare(
    `SELECT c.*, a.business_name, a.kind AS advertiser_kind, u.email AS advertiser_email,
       (SELECT COUNT(*) FROM abuse_reports r WHERE r.target_type = 'ad' AND r.target_id = c.id AND r.status = 'open') AS open_reports,
       (SELECT COUNT(*) FROM ad_campaigns k WHERE k.creative_id = c.id AND k.status = 'pending') AS waiting_campaigns
     FROM ad_creatives c JOIN advertisers a ON a.user_id = c.advertiser_id JOIN users u ON u.id = a.user_id
     WHERE c.status = ?1
     ORDER BY CASE a.kind WHEN 'lainnya' THEN 1 ELSE 0 END, c.updated_at ASC LIMIT 100`,
  )
    .bind(status)
    .all<
      CreativeRow & {
        business_name: string;
        advertiser_kind: string;
        advertiser_email: string;
        open_reports: number;
        waiting_campaigns: number;
      }
    >();
  return results.map((c) => ({
    ...creativeDto(c),
    businessName: c.business_name,
    advertiserKind: c.advertiser_kind,
    advertiserEmail: c.advertiser_email,
    openReports: c.open_reports,
    waitingCampaigns: c.waiting_campaigns,
    flag: bannedTopic(c.title, c.body, c.cta_value, c.business_name),
  }));
}

/**
 * The manual check (ADR-043). Approving opens payment for the campaigns that were waiting on it
 * (one that should already have started expires instead); rejecting rejects them with the reason.
 */
export async function reviewCreative(
  ctx: Ctx,
  actorId: string,
  id: string,
  decision: 'approve' | 'reject',
  reason: string,
): Promise<void> {
  const now = ctx.now();
  const today = wibDate(now);
  const DB = ctx.env.DB;
  const res = await DB.prepare(
    `UPDATE ad_creatives SET status = ?2, reject_reason = ?3, reviewed_by = ?4, reviewed_at = ?5, updated_at = ?5
     WHERE id = ?1 AND status = 'pending'`,
  )
    .bind(id, decision === 'approve' ? 'approved' : 'rejected', decision === 'reject' ? reason : null, actorId, now)
    .run();
  if (!res.meta.changes) throw new AppError('CONFLICT', 'CREATIVE_STATE');
  const { results: waiting } = await DB.prepare(
    `SELECT * FROM ad_campaigns WHERE creative_id = ?1 AND status = 'pending'`,
  )
    .bind(id)
    .all<CampaignRow>();
  const next = (k: CampaignRow): AdCampaignStatus =>
    decision === 'reject' ? 'rejected' : k.start_date < today ? 'expired' : 'awaiting_payment';
  if (waiting.length) {
    await DB.batch(
      waiting.map((k) =>
        DB.prepare(
          `UPDATE ad_campaigns SET status = ?2, reason = ?3, updated_at = ?4 WHERE id = ?1 AND status = 'pending'`,
        ).bind(k.id, next(k), decision === 'reject' ? reason : null, now),
      ),
    );
  }
  await auditAd(ctx, actorId, `ad.${decision}`, 'ad_creative', id, {
    reason,
    campaigns: waiting.map((k) => ({ id: k.id, status: next(k) })),
  });
  const c = await DB.prepare('SELECT advertiser_id, title FROM ad_creatives WHERE id = ?1')
    .bind(id)
    .first<{ advertiser_id: string; title: string }>();
  if (!c) return;
  const toPay = waiting.filter((k) => next(k) === 'awaiting_payment');
  if (decision === 'approve' && toPay.length) {
    for (const k of toPay) await sendCampaignPayment(ctx, k.id);
  } else {
    await notify(ctx, c.advertiser_id, 'ad_status', {
      creativeId: id,
      title: c.title,
      status: decision === 'approve' ? 'approved' : 'rejected',
      reason,
    });
  }
}

/**
 * Takedown of an approved creative (SPEC §10.5): its paid and live campaigns stop. The days not
 * shown yet (from tomorrow) come back as credit (ADR-041) unless the violation is severe and
 * `ad_refund_on_suspend.severe` is false. Campaigns still waiting are cancelled.
 */
export async function suspendCreative(
  ctx: Ctx,
  actorId: string,
  id: string,
  severe: boolean,
  reason: string,
): Promise<{ refundedIdr: number }> {
  const cfg = await ctx.config();
  const now = ctx.now();
  const today = wibDate(now);
  const DB = ctx.env.DB;
  const c = await DB.prepare('SELECT * FROM ad_creatives WHERE id = ?1').bind(id).first<CreativeRow>();
  if (!c) throw new AppError('NOT_FOUND', 'creative not found');
  const refund = severe ? cfg.ad_refund_on_suspend.severe : cfg.ad_refund_on_suspend.other;
  const { results } = await DB.prepare(
    `SELECT * FROM ad_campaigns WHERE creative_id = ?1 AND status IN ('paid', 'live')`,
  )
    .bind(id)
    .all<CampaignRow>();
  const unshown = (k: CampaignRow) => {
    const from = k.start_date > today ? k.start_date : addDaysWib(today, 1);
    return from > k.end_date ? 0 : daysBetween(from, k.end_date) + 1;
  };
  const amount = refund
    ? await withTax(
        ctx,
        results.reduce((s, k) => s + unshown(k) * k.price_per_day_idr, 0),
      )
    : 0;
  const stmts: Stmt[] = [
    DB.prepare(
      `UPDATE ad_creatives SET status = 'suspended', reject_reason = ?2, reviewed_by = ?3, reviewed_at = ?4, updated_at = ?4 WHERE id = ?1`,
    ).bind(id, reason, actorId, now),
    DB.prepare(
      `UPDATE ad_campaigns SET status = 'suspended', reason = ?2, updated_at = ?3 WHERE creative_id = ?1 AND status IN ('paid', 'live')`,
    ).bind(id, reason, now),
    DB.prepare(
      `UPDATE ad_campaigns SET status = 'cancelled', reason = ?2, updated_at = ?3 WHERE creative_id = ?1 AND status IN ('pending', 'awaiting_payment')`,
    ).bind(id, reason, now),
  ];
  if (amount > 0) stmts.push(...walletStmts(ctx, c.advertiser_id, amount, 'ad_refund', `suspend:${id}:${now}`));
  await DB.batch(stmts);
  await auditAd(ctx, actorId, 'ad.suspend', 'ad_creative', id, {
    severe,
    reason,
    refundedIdr: amount,
    campaigns: results.length,
  });
  await notify(ctx, c.advertiser_id, 'ad_status', {
    creativeId: id,
    title: c.title,
    status: 'suspended',
    reason,
    refundedIdr: amount,
  });
  await bumpServeVersion(ctx);
  return { refundedIdr: amount };
}

// ───────────────────────────── campaigns ─────────────────────────────

export interface CampaignRow {
  id: string;
  advertiser_id: string;
  creative_id: string;
  scope: AdCampaignScope;
  start_date: string;
  end_date: string;
  days: number;
  price_per_day_idr: number;
  total_idr: number;
  status: AdCampaignStatus;
  reason: string | null;
  payment_id: string | null;
  pay_amount_idr: number | null;
  pay_qris: string | null;
  pay_url: string | null;
  created_by: string;
  paid_at: number | null;
  created_at: number;
  updated_at: number;
}

/** Whole days from `a` to `b` (both YYYY-MM-DD). */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export interface CampaignInput {
  creativeId: string;
  scope: AdCampaignScope;
  /** Cities or regencies (`ad_areas` level `regency`); ignored for national. */
  areaCodes: string[];
  startDate: string;
  days: number;
}

/**
 * The operator enters a campaign an advertiser asked for by email (ADR-043). The price is frozen
 * here. With its creative already approved it waits for payment at once (and the advertiser is
 * told); otherwise it waits for the check, and a creative that was a draft goes to it.
 */
export async function createCampaign(
  ctx: Ctx,
  actorId: string,
  input: CampaignInput,
): Promise<CampaignRow> {
  const cfg = await ctx.config();
  const DB = ctx.env.DB;
  const c = await DB.prepare('SELECT * FROM ad_creatives WHERE id = ?1')
    .bind(input.creativeId)
    .first<CreativeRow>();
  if (!c) throw new AppError('NOT_FOUND', 'creative not found');
  if (c.status === 'rejected' || c.status === 'suspended')
    throw new AppError('CONFLICT', 'CREATIVE_STATE');
  if (!c.image_key) throw new AppError('VALIDATION', 'IMAGE_REQUIRED', { field: 'image' });

  let areas: string[] = ['ID'];
  if (input.scope === 'cities') {
    const index = await areaIndex(ctx);
    areas = [...new Set(input.areaCodes.map((x) => x.trim()))];
    if (!areas.length || areas.length > 600)
      throw new AppError('VALIDATION', 'AREAS_REQUIRED', { field: 'areaCodes' });
    if (areas.some((code) => index.byCode.get(code)?.level !== 'regency'))
      throw new AppError('VALIDATION', 'AREA_NOT_CITY', { field: 'areaCodes' });
  }
  const today = wibDate(ctx.now());
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(input.startDate) ||
    input.startDate < today ||
    input.startDate > addDaysWib(today, cfg.ad_campaign_lead_days)
  )
    throw new AppError('VALIDATION', 'DATE_OUT_OF_RANGE', { field: 'startDate' });
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > cfg.ad_campaign_max_days)
    throw new AppError('VALIDATION', 'DAYS_OUT_OF_RANGE', {
      field: 'days',
      max: cfg.ad_campaign_max_days,
    });

  const perDay = adCampaignPricePerDay(cfg, input.scope, areas.length);
  const now = ctx.now();
  const id = ulid(now);
  const status: AdCampaignStatus = c.status === 'approved' ? 'awaiting_payment' : 'pending';
  await DB.batch([
    DB.prepare(
      `INSERT INTO ad_campaigns (id, advertiser_id, creative_id, scope, start_date, end_date, days, price_per_day_idr,
         total_idr, status, created_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)`,
    ).bind(
      id,
      c.advertiser_id,
      c.id,
      input.scope,
      input.startDate,
      addDaysWib(input.startDate, input.days - 1),
      input.days,
      perDay,
      perDay * input.days,
      status,
      actorId,
      now,
    ),
    ...areas.map((code) =>
      DB.prepare('INSERT INTO ad_campaign_areas (campaign_id, area_code) VALUES (?1, ?2)').bind(id, code),
    ),
    DB.prepare(
      `UPDATE ad_creatives SET status = 'pending', updated_at = ?2 WHERE id = ?1 AND status = 'draft'`,
    ).bind(c.id, now),
  ]);
  const k = (await DB.prepare('SELECT * FROM ad_campaigns WHERE id = ?1').bind(id).first<CampaignRow>())!;
  await auditAd(ctx, actorId, 'ad.campaign_create', 'ad_campaign', id, {
    creativeId: c.id,
    scope: input.scope,
    areas: areas.length,
    startDate: k.start_date,
    days: k.days,
    totalIdr: k.total_idr,
  });
  if (status === 'awaiting_payment') {
    await sendCampaignPayment(ctx, id);
    return (await DB.prepare('SELECT * FROM ad_campaigns WHERE id = ?1').bind(id).first<CampaignRow>())!;
  }
  return k;
}

/** Only a campaign nobody has paid for can be called off; a paid one is stopped by a takedown. */
export async function cancelCampaign(
  ctx: Ctx,
  actorId: string,
  id: string,
  reason: string,
): Promise<void> {
  const res = await ctx.env.DB.prepare(
    `UPDATE ad_campaigns SET status = 'cancelled', reason = ?2, updated_at = ?3 WHERE id = ?1 AND status IN ('pending', 'awaiting_payment')`,
  )
    .bind(id, reason, ctx.now())
    .run();
  if (!res.meta.changes) throw new AppError('CONFLICT', 'CAMPAIGN_STATE');
  await auditAd(ctx, actorId, 'ad.campaign_cancel', 'ad_campaign', id, { reason });
}

/** The operator's list: newest first, with where each runs and what it has done so far. */
export async function listCampaigns(ctx: Ctx, status?: AdCampaignStatus) {
  const index = await areaIndex(ctx);
  const { results } = await ctx.env.DB.prepare(
    `SELECT k.*, c.title, a.business_name, a.kind AS advertiser_kind, u.email AS advertiser_email,
       (SELECT group_concat(area_code) FROM ad_campaign_areas WHERE campaign_id = k.id) AS area_codes,
       (SELECT COALESCE(SUM(impressions), 0) FROM ad_campaign_stats WHERE campaign_id = k.id) AS impressions,
       (SELECT COALESCE(SUM(clicks), 0) FROM ad_campaign_stats WHERE campaign_id = k.id) AS clicks
     FROM ad_campaigns k JOIN ad_creatives c ON c.id = k.creative_id
       JOIN advertisers a ON a.user_id = k.advertiser_id JOIN users u ON u.id = a.user_id
     WHERE (?1 IS NULL OR k.status = ?1)
     ORDER BY k.created_at DESC LIMIT 200`,
  )
    .bind(status ?? null)
    .all<
      CampaignRow & {
        title: string;
        business_name: string;
        advertiser_kind: string;
        advertiser_email: string;
        area_codes: string | null;
        impressions: number;
        clicks: number;
      }
    >();
  return results.map((k) => ({
    ...campaignDto(k),
    title: k.title,
    businessName: k.business_name,
    advertiserKind: k.advertiser_kind,
    advertiserEmail: k.advertiser_email,
    areas: (k.area_codes ?? '').split(',').filter(Boolean).map((code) => areaRef(index, code)),
    impressions: k.impressions,
    clicks: k.clicks,
  }));
}

function areaRef(index: AreaIndex, code: string): { code: string; name: string } {
  return { code, name: code === 'ID' ? 'Indonesia' : (index.byCode.get(code)?.name ?? code) };
}

function campaignDto(k: CampaignRow) {
  return {
    id: k.id,
    creativeId: k.creative_id,
    scope: k.scope,
    startDate: k.start_date,
    endDate: k.end_date,
    days: k.days,
    pricePerDayIdr: k.price_per_day_idr,
    totalIdr: k.total_idr,
    status: k.status,
    reason: k.reason,
    createdAt: k.created_at,
    paidAt: k.paid_at,
  };
}

// ───────────────────────────── paying (by email, after the check) ─────────────────────────────

async function requireCampaign(ctx: Ctx, id: string): Promise<CampaignRow> {
  const k = await ctx.env.DB.prepare('SELECT * FROM ad_campaigns WHERE id = ?1')
    .bind(id)
    .first<CampaignRow>();
  if (!k) throw new AppError('NOT_FOUND', 'campaign not found');
  return k;
}

async function requireOwnCampaign(ctx: Ctx, userId: string, id: string): Promise<CampaignRow> {
  const k = await ctx.env.DB.prepare('SELECT * FROM ad_campaigns WHERE id = ?1 AND advertiser_id = ?2')
    .bind(id, userId)
    .first<CampaignRow>();
  if (!k) throw new AppError('NOT_FOUND', 'campaign not found');
  return k;
}

/** Waiting for payment, and not past its first day (it may still be paid on that day). */
function payable(k: CampaignRow, today: string): void {
  if (k.status !== 'awaiting_payment') throw new AppError('CONFLICT', 'CAMPAIGN_STATE');
  if (k.start_date < today) throw new AppError('CONFLICT', 'CAMPAIGN_EXPIRED');
}

/**
 * Pays an approved campaign from credit in one batch (the QRIS payment, when there was one, is
 * already credited). It starts at once when its first day is today.
 */
export async function payCampaignFromWallet(
  ctx: Ctx,
  userId: string,
  id: string,
): Promise<{ invoiceId: string; totalIdr: number }> {
  const k = await requireOwnCampaign(ctx, userId, id);
  const now = ctx.now();
  const today = wibDate(now);
  payable(k, today);
  const index = await areaIndex(ctx);
  const { results: areas } = await ctx.env.DB.prepare(
    'SELECT area_code FROM ad_campaign_areas WHERE campaign_id = ?1',
  )
    .bind(id)
    .all<{ area_code: string }>();
  const where =
    k.scope === 'national'
      ? 'Nasional'
      : areas.length === 1
        ? areaRef(index, areas[0]!.area_code).name
        : `${areas.length} kota`;
  const inv = await invoiceStmts(
    ctx,
    userId,
    [{ label: `Iklan · ${where} · ${k.start_date} s.d. ${k.end_date} (${k.days} hari)`, amountIdr: k.total_idr }],
    null,
  );
  const DB = ctx.env.DB;
  const debit = walletStmts(ctx, userId, -inv.total, 'ad_booking', inv.id);
  const stmts: Stmt[] = [
    debit[0]!,
    // Aborts the batch (CHECK balance >= 0) when the campaign stopped being payable meanwhile.
    DB.prepare(
      `UPDATE wallets SET balance_idr = -1 WHERE user_id = ?1
         AND NOT EXISTS (SELECT 1 FROM ad_campaigns WHERE id = ?2 AND status = 'awaiting_payment' AND start_date >= ?3)`,
    ).bind(userId, id, today),
    ...debit.slice(1),
    DB.prepare(
      `UPDATE ad_campaigns SET status = CASE WHEN start_date <= ?2 THEN 'live' ELSE 'paid' END, paid_at = ?3, updated_at = ?3
       WHERE id = ?1 AND status = 'awaiting_payment'`,
    ).bind(id, today, now),
    ...inv.stmts,
  ];
  try {
    await DB.batch(stmts);
  } catch (e) {
    if (!/CHECK constraint failed/i.test(String(e))) throw e;
    payable(await requireOwnCampaign(ctx, userId, id), today); // throws if that was the cause
    throw new AppError('INSUFFICIENT_BALANCE', 'not enough credit', { needIdr: inv.total });
  }
  if (k.start_date <= today) await bumpServeVersion(ctx);
  return { invoiceId: inv.id, totalIdr: inv.total };
}

/** The address of a campaign's QR image: unguessable, and only while it waits for payment. */
async function qrToken(ctx: Ctx, k: Pick<CampaignRow, 'id' | 'payment_id'>): Promise<string> {
  return hmacBase62(ctx.env.DOWNLOAD_SECRET, `adq|${k.id}|${k.payment_id ?? ''}`, 22);
}

export async function campaignQrUrl(ctx: Ctx, k: Pick<CampaignRow, 'id' | 'payment_id'>): Promise<string> {
  return `${ctx.env.APP_ORIGIN}/ad/qr/${k.id}.png?t=${await qrToken(ctx, k)}`;
}

/** The QRIS a waiting campaign's email shows, as text to draw; null once it is paid or gone. */
export async function campaignQris(ctx: Ctx, id: string, token: string): Promise<string | null> {
  const k = await ctx.env.DB.prepare('SELECT * FROM ad_campaigns WHERE id = ?1').bind(id).first<CampaignRow>();
  if (!k?.pay_qris || k.status !== 'awaiting_payment') return null;
  return timingSafeEqual(token, await qrToken(ctx, k)) ? k.pay_qris : null;
}

/**
 * Paying is by email (ADR-043): once a campaign is approved, a QRIS for what it costs (less any
 * credit) is opened in the advertiser's name and mailed to them with the QR in it; they pay from
 * the email, and the operator's confirmation of the QRIS starts it. Credit that covers it all pays
 * it at once. Sending again re-mails a QRIS still open rather than opening a second one. When no
 * QRIS can be opened (no Zeiko Account link, QRIS closed), the advertiser is told to wait for one,
 * and the operator is told to send it again.
 */
export async function sendCampaignPayment(
  ctx: Ctx,
  id: string,
): Promise<{ sent: 'credit' | 'qris' | 'failed' }> {
  const DB = ctx.env.DB;
  const k = await requireCampaign(ctx, id);
  payable(k, wibDate(ctx.now()));
  const c = await DB.prepare('SELECT title FROM ad_creatives WHERE id = ?1')
    .bind(k.creative_id)
    .first<{ title: string }>();
  const title = c?.title ?? '';
  const base = { campaignId: k.id, title, startDate: k.start_date };
  const total = await withTax(ctx, k.total_idr);
  const credit = await walletBalance(ctx, k.advertiser_id);
  if (credit >= total) {
    await payCampaignFromWallet(ctx, k.advertiser_id, k.id);
    await notify(ctx, k.advertiser_id, 'ad_status', { ...base, status: 'paid', totalIdr: total });
    return { sent: 'credit' };
  }
  const open = k.payment_id
    ? await DB.prepare(`SELECT status FROM payments WHERE id = ?1`)
        .bind(k.payment_id)
        .first<{ status: string }>()
    : null;
  if (open?.status === 'pending' && k.pay_amount_idr) {
    await notify(ctx, k.advertiser_id, 'ad_status', {
      ...base,
      status: 'awaiting_payment',
      amountIdr: k.pay_amount_idr,
      qrUrl: k.pay_qris ? await campaignQrUrl(ctx, k) : null,
      payUrl: k.pay_url,
    });
    return { sent: 'qris' };
  }
  const user = await DB.prepare('SELECT id, email FROM users WHERE id = ?1')
    .bind(k.advertiser_id)
    .first<{ id: string; email: string }>();
  try {
    if (!user) throw new AppError('NOT_FOUND', 'advertiser not found');
    const payment = await openPayment(ctx, user, {
      amountIdr: total - credit,
      purpose: { kind: 'ad_campaign', campaignId: k.id },
    });
    await DB.prepare(
      `UPDATE ad_campaigns SET payment_id = ?2, pay_amount_idr = ?3, pay_qris = ?4, pay_url = ?5, updated_at = ?6 WHERE id = ?1`,
    )
      .bind(k.id, payment.paymentId, payment.amountIdr, payment.qrString, payment.checkoutUrl, ctx.now())
      .run();
    await notify(ctx, k.advertiser_id, 'ad_status', {
      ...base,
      status: 'awaiting_payment',
      amountIdr: payment.amountIdr,
      creditUsedIdr: credit,
      qrUrl: payment.qrString
        ? await campaignQrUrl(ctx, { id: k.id, payment_id: payment.paymentId })
        : null,
      payUrl: payment.checkoutUrl,
    });
    return { sent: 'qris' };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    await ctx.env.NOTIFY_QUEUE.send({
      type: 'admin_alert',
      text: `QRIS untuk iklan "${title}" belum bisa dibuat (${why.slice(0, 200)}). Kirim ulang dari Admin → Iklan → Kampanye.`,
    });
    await notify(ctx, k.advertiser_id, 'ad_status', {
      ...base,
      status: 'awaiting_payment',
      amountIdr: total,
      qrUrl: null,
      payUrl: null,
    });
    return { sent: 'failed' };
  }
}

// ───────────────────────────── daily (cron 00:05 WIB) ─────────────────────────────

/** Paid campaigns start on their day, finished ones complete, unpaid ones past their first day expire. */
export async function runAdsDaily(
  ctx: Ctx,
): Promise<{ live: number; completed: number; expired: number }> {
  const today = wibDate(ctx.now());
  const now = ctx.now();
  const DB = ctx.env.DB;
  const [completed, live, expired] = await DB.batch([
    DB.prepare(
      `UPDATE ad_campaigns SET status = 'completed', updated_at = ?2 WHERE status IN ('live', 'paid') AND end_date < ?1`,
    ).bind(today, now),
    DB.prepare(
      `UPDATE ad_campaigns SET status = 'live', updated_at = ?2 WHERE status = 'paid' AND start_date <= ?1`,
    ).bind(today, now),
    DB.prepare(
      `UPDATE ad_campaigns SET status = 'expired', updated_at = ?2 WHERE status IN ('pending', 'awaiting_payment') AND start_date < ?1`,
    ).bind(today, now),
  ]);
  const out = {
    live: live?.meta.changes ?? 0,
    completed: completed?.meta.changes ?? 0,
    expired: expired?.meta.changes ?? 0,
  };
  if (out.live || out.completed) await bumpServeVersion(ctx);
  return out;
}

// ───────────────────────────── serving ─────────────────────────────

export interface AdDto {
  campaignId: string | null;
  creativeId: string | null;
  title: string;
  body: string;
  imageUrl: string | null;
  ctaLabel: string;
  clickUrl: string;
  label: string;
  /** Impression token (null for internal ads). */
  token: string | null;
  /** The area it was served for, which its impression is counted under. */
  area: string | null;
  internal: boolean;
}

interface Candidate {
  campaignId: string;
  creativeId: string;
  title: string;
  body: string;
  ctaType: AdCtaType;
  kind: AdvertiserRow['kind'];
}

const CTA_LABEL: Record<AdCtaType, string> = {
  web: 'Kunjungi',
  whatsapp: 'Chat WhatsApp',
  instagram: 'Lihat Instagram',
  tiktok: 'Lihat TikTok',
  shopee: 'Lihat di Shopee',
  tokopedia: 'Lihat di Tokopedia',
};

/** At most this many turns in one rotation the card is handed; it asks again at the end. */
const MAX_ROTATION = 40;

async function serveVersion(ctx: Ctx): Promise<string> {
  return (await ctx.env.CONFIG_KV.get('adv:ver')) ?? '0';
}

/** New version → every cached candidate list is ignored (after a campaign starts, ends or stops). */
async function bumpServeVersion(ctx: Ctx): Promise<void> {
  await ctx.env.CONFIG_KV.put('adv:ver', String(ctx.now()));
}

async function candidates(ctx: Ctx, date: string, area: string): Promise<Candidate[]> {
  const cfg = await ctx.config();
  const key = `adk:${await serveVersion(ctx)}:${date}:${area}`;
  const cached = await ctx.env.CONFIG_KV.get<Candidate[]>(key, 'json');
  if (cached) return cached;
  const { results } = await ctx.env.DB.prepare(
    `SELECT k.id AS campaignId, c.id AS creativeId, c.title, c.body, c.cta_type AS ctaType, a.kind
     FROM ad_campaign_areas ca JOIN ad_campaigns k ON k.id = ca.campaign_id
       JOIN ad_creatives c ON c.id = k.creative_id JOIN advertisers a ON a.user_id = k.advertiser_id
     WHERE ca.area_code = ?2 AND k.status = 'live' AND k.start_date <= ?1 AND k.end_date >= ?1
       AND c.status = 'approved' AND c.image_key IS NOT NULL`,
  )
    .bind(date, area)
    .all<Candidate>();
  await ctx.env.CONFIG_KV.put(key, JSON.stringify(results), {
    expirationTtl: Math.max(60, cfg.ad_candidates_cache_seconds),
  });
  return results;
}

async function impressionToken(ctx: Ctx, campaignId: string, date: string, area: string): Promise<string> {
  return hmacBase62(ctx.env.DOWNLOAD_SECRET, `adi|${campaignId}|${date}|${area}`, 22);
}

/** Should this viewer see ads at all? Plans decide (`plans.show_ads`); no plan → yes. */
export async function adsAllowedForUser(ctx: Ctx, userId: string | null): Promise<boolean> {
  const cfg = await ctx.config();
  if (!cfg.features.ads) return false;
  if (!userId) return true;
  const r = await ctx.env.DB.prepare(
    `SELECT p.show_ads FROM subscriptions s JOIN plans p ON p.code = s.plan_code
     JOIN storage_pools sp ON sp.id = s.pool_id
     WHERE s.status IN ('active', 'grace', 'readonly', 'suspended')
       AND (sp.owner_type = 'user' AND sp.owner_id = ?1
            OR sp.id IN (SELECT f.pool_id FROM families f JOIN family_members m ON m.family_id = f.id WHERE m.user_id = ?1))
     ORDER BY s.created_at DESC LIMIT 1`,
  )
    .bind(userId)
    .first<{ show_ads: number }>();
  return r ? r.show_ads === 1 : true;
}

/** Every live campaign for the viewer's areas (city first, then national), each once. */
async function pool(
  ctx: Ctx,
  chain: string[],
  exclude: string[],
): Promise<Array<Candidate & { area: string }>> {
  const date = wibDate(ctx.now());
  const seen = new Set<string>();
  const out: Array<Candidate & { area: string }> = [];
  for (const area of chain) {
    for (const x of await candidates(ctx, date, area)) {
      if (seen.has(x.campaignId) || exclude.includes(x.creativeId)) continue;
      seen.add(x.campaignId);
      out.push({ ...x, area });
    }
  }
  return out;
}

async function adDto(
  ctx: Ctx,
  x: Candidate & { area: string },
  index: AreaIndex,
): Promise<AdDto> {
  return {
    campaignId: x.campaignId,
    creativeId: x.creativeId,
    title: x.title,
    body: x.body,
    imageUrl: `/ad/img/${x.creativeId}`,
    ctaLabel: CTA_LABEL[x.ctaType],
    clickUrl: `/ad/c/${x.campaignId}?a=${encodeURIComponent(x.area)}`,
    label: `Iklan · ${x.area === 'ID' ? 'Indonesia' : (index.byCode.get(x.area)?.name ?? '')}`,
    token: await impressionToken(ctx, x.campaignId, wibDate(ctx.now()), x.area),
    area: x.area,
    internal: false,
  };
}

async function internalAd(ctx: Ctx): Promise<AdDto> {
  const cfg = await ctx.config();
  return {
    campaignId: null,
    creativeId: null,
    title: 'Pasang iklan di Zeiko',
    body: `Iklan lokal untuk usahamu, mulai Rp${cfg.ad_price_city_idr.toLocaleString('id-ID')}/hari. Hubungi ${AD_CONTACT}.`,
    imageUrl: null,
    ctaLabel: 'Hubungi kami',
    clickUrl: appPath(ctx.env, '/iklan'),
    label: 'Iklan · Zeiko',
    token: null,
    area: null,
    internal: true,
  };
}

const priority = (kind: string, weight: number) => (kind === 'lainnya' ? 1 : weight);

/**
 * The rotation the card plays (ADR-043): every candidate, UMKM/small business and student
 * advertisers `ad_priority_weight` times as often, spread out by smooth weighted round robin
 * from a random start so nobody is always first. Nothing live → the internal ad alone.
 */
export async function serveRotation(
  ctx: Ctx,
  placement: AdPlacement,
  chain: string[],
  exclude: string[] = [],
): Promise<{ ads: AdDto[]; rotateSeconds: number }> {
  const cfg = await ctx.config();
  const index = await areaIndex(ctx);
  const list = (await pool(ctx, chain, exclude)).sort(() => Math.random() - 0.5);
  if (!list.length) return { ads: [await internalAd(ctx)], rotateSeconds: cfg.ad_rotate_seconds };
  const dtos = await Promise.all(list.map((x) => adDto(ctx, x, index)));
  const weights = list.map((x) => priority(x.kind, cfg.ad_priority_weight));
  const total = weights.reduce((a, b) => a + b, 0);
  const current = weights.map(() => 0);
  const turns: AdDto[] = [];
  for (let i = 0; i < Math.min(total, MAX_ROTATION); i++) {
    let best = 0;
    for (let j = 0; j < weights.length; j++) {
      current[j]! += weights[j]!;
      if (current[j]! > current[best]!) best = j;
    }
    current[best]! -= total;
    turns.push(dtos[best]!);
  }
  const start = Math.floor(Math.random() * turns.length);
  track(ctx.env.ANALYTICS, 'ad_impression', { index: chain[0] ?? 'ID', blobs: ['served', placement] });
  return { ads: [...turns.slice(start), ...turns.slice(0, start)], rotateSeconds: cfg.ad_rotate_seconds };
}

/** One ad, for a page with no script to rotate it (the share pages): a weighted random pick. */
export async function serveAd(
  ctx: Ctx,
  placement: AdPlacement,
  chain: string[],
  exclude: string[] = [],
): Promise<AdDto | null> {
  const cfg = await ctx.config();
  const list = await pool(ctx, chain, exclude);
  if (!list.length) return internalAd(ctx);
  const weights = list.map((x) => priority(x.kind, cfg.ad_priority_weight));
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  let pick = list[0]!;
  for (let i = 0; i < list.length; i++) {
    r -= weights[i]!;
    if (r < 0) {
      pick = list[i]!;
      break;
    }
  }
  track(ctx.env.ANALYTICS, 'ad_impression', { index: chain[0] ?? 'ID', blobs: ['served', placement] });
  return adDto(ctx, pick, await areaIndex(ctx));
}

/** One more look at a campaign today, under the area it was served for (token-checked). */
export async function recordImpression(
  ctx: Ctx,
  campaignId: string,
  area: string,
  token: string,
): Promise<boolean> {
  const date = wibDate(ctx.now());
  if (!timingSafeEqual(token, await impressionToken(ctx, campaignId, date, area))) return false;
  const res = await ctx.env.DB.prepare(
    `INSERT INTO ad_campaign_stats (campaign_id, date, area_code, impressions)
     SELECT ?1, ?2, ?3, 1 WHERE EXISTS (SELECT 1 FROM ad_campaigns WHERE id = ?1 AND status = 'live')
     ON CONFLICT (campaign_id, date, area_code) DO UPDATE SET impressions = impressions + 1`,
  )
    .bind(campaignId, date, area)
    .run();
  if (res.meta.changes) track(ctx.env.ANALYTICS, 'ad_impression', { index: campaignId, blobs: ['viewed'] });
  return res.meta.changes === 1;
}

/** `/ad/c/{campaignId}?a=area` → count → destination. Unknown/ended campaigns go to the home page. */
export async function recordClick(ctx: Ctx, campaignId: string, area: string): Promise<string> {
  const row = await ctx.env.DB.prepare(
    `SELECT c.cta_type, c.cta_value, k.status FROM ad_campaigns k JOIN ad_creatives c ON c.id = k.creative_id WHERE k.id = ?1`,
  )
    .bind(campaignId)
    .first<{ cta_type: AdCtaType; cta_value: string; status: string }>();
  if (!row || !['live', 'completed'].includes(row.status)) return ctx.env.APP_ORIGIN;
  const cta = ctaUrl(row.cta_type, row.cta_value);
  if ('error' in cta) return ctx.env.APP_ORIGIN;
  if (row.status === 'live') {
    const known = area === 'ID' || (await areaIndex(ctx)).byCode.has(area) ? area : 'ID';
    await ctx.env.DB.prepare(
      `INSERT INTO ad_campaign_stats (campaign_id, date, area_code, clicks) VALUES (?1, ?2, ?3, 1)
       ON CONFLICT (campaign_id, date, area_code) DO UPDATE SET clicks = clicks + 1`,
    )
      .bind(campaignId, wibDate(ctx.now()), known)
      .run();
    track(ctx.env.ANALYTICS, 'ad_click', { index: campaignId, blobs: [row.cta_type] });
  }
  return cta.url;
}

export async function creativeImage(ctx: Ctx, creativeId: string): Promise<R2ObjectBody | null> {
  const c = await ctx.env.DB.prepare(
    `SELECT image_key FROM ad_creatives WHERE id = ?1 AND status = 'approved'`,
  )
    .bind(creativeId)
    .first<{ image_key: string | null }>();
  if (!c?.image_key) return null;
  return ctx.env.BUCKET.get(c.image_key);
}

/** Staff preview of any creative image (unchecked ones are not public). */
export async function reviewCreativeImage(
  ctx: Ctx,
  creativeId: string,
): Promise<R2ObjectBody | null> {
  const c = await ctx.env.DB.prepare('SELECT image_key FROM ad_creatives WHERE id = ?1')
    .bind(creativeId)
    .first<{ image_key: string | null }>();
  if (!c?.image_key) return null;
  return ctx.env.BUCKET.get(c.image_key);
}

/** The advertiser's own preview of their creative image, checked or not. */
export async function ownCreativeImage(
  ctx: Ctx,
  userId: string,
  creativeId: string,
): Promise<R2ObjectBody | null> {
  const c = await ctx.env.DB.prepare(
    'SELECT image_key FROM ad_creatives WHERE id = ?1 AND advertiser_id = ?2',
  )
    .bind(creativeId, userId)
    .first<{ image_key: string | null }>();
  if (!c?.image_key) return null;
  return ctx.env.BUCKET.get(c.image_key);
}

// ───────────────────────────── dashboards ─────────────────────────────

function creativeDto(c: CreativeRow) {
  return {
    id: c.id,
    title: c.title,
    body: c.body,
    hasImage: Boolean(c.image_key),
    ctaType: c.cta_type,
    ctaValue: c.cta_value,
    category: c.category,
    status: c.status,
    rejectReason: c.reject_reason,
    updatedAt: c.updated_at,
  };
}

/** An advertiser and what the operator has entered for them (the operator's form). */
export async function advertiserForOperator(ctx: Ctx, email: string) {
  const user = await driveUserByEmail(ctx, email);
  const adv = await getAdvertiser(ctx, user.id);
  const { results } = await ctx.env.DB.prepare(
    'SELECT * FROM ad_creatives WHERE advertiser_id = ?1 ORDER BY updated_at DESC LIMIT 50',
  )
    .bind(user.id)
    .all<CreativeRow>();
  return {
    user,
    advertiser: adv && { businessName: adv.business_name, kind: adv.kind, phone: adv.phone },
    creatives: results.map(creativeDto),
  };
}

/**
 * Rule 6 (ADR-043): an advertiser sees every campaign, what it costs, whether it waits for payment,
 * and how often it was seen and clicked, per day and per city.
 */
export async function advertiserDashboard(ctx: Ctx, userId: string) {
  const adv = await getAdvertiser(ctx, userId);
  if (!adv) return { advertiser: null, campaigns: [] };
  const index = await areaIndex(ctx);
  const DB = ctx.env.DB;
  const [{ results: campaigns }, { results: areas }, { results: stats }] = await Promise.all([
    DB.prepare(
      `SELECT k.*, c.title, c.status AS creative_status FROM ad_campaigns k JOIN ad_creatives c ON c.id = k.creative_id
       WHERE k.advertiser_id = ?1 AND k.status != 'cancelled' ORDER BY k.start_date DESC, k.created_at DESC LIMIT 100`,
    )
      .bind(userId)
      .all<CampaignRow & { title: string; creative_status: string }>(),
    DB.prepare(
      `SELECT ca.campaign_id, ca.area_code FROM ad_campaign_areas ca JOIN ad_campaigns k ON k.id = ca.campaign_id
       WHERE k.advertiser_id = ?1`,
    )
      .bind(userId)
      .all<{ campaign_id: string; area_code: string }>(),
    DB.prepare(
      `SELECT s.campaign_id, s.date, s.area_code, s.impressions, s.clicks FROM ad_campaign_stats s
       JOIN ad_campaigns k ON k.id = s.campaign_id WHERE k.advertiser_id = ?1 ORDER BY s.date`,
    )
      .bind(userId)
      .all<{ campaign_id: string; date: string; area_code: string; impressions: number; clicks: number }>(),
  ]);
  const ctr = (i: number, c: number) => (i ? c / i : 0);
  return {
    advertiser: { businessName: adv.business_name, kind: adv.kind },
    campaigns: await Promise.all(
      campaigns.map(async (k) => {
        const mine = stats.filter((s) => s.campaign_id === k.id);
        const byDay = new Map<string, { impressions: number; clicks: number }>();
        const byArea = new Map<string, { impressions: number; clicks: number }>();
        for (const s of mine) {
          for (const [m, key] of [
            [byDay, s.date],
            [byArea, s.area_code],
          ] as const) {
            const v = m.get(key) ?? { impressions: 0, clicks: 0 };
            v.impressions += s.impressions;
            v.clicks += s.clicks;
            m.set(key, v);
          }
        }
        const impressions = mine.reduce((t, s) => t + s.impressions, 0);
        const clicks = mine.reduce((t, s) => t + s.clicks, 0);
        return {
          ...campaignDto(k),
          title: k.title,
          payIdr: await withTax(ctx, k.total_idr),
          areas: areas.filter((a) => a.campaign_id === k.id).map((a) => areaRef(index, a.area_code)),
          impressions,
          clicks,
          ctr: ctr(impressions, clicks),
          byDay: [...byDay].map(([date, v]) => ({ date, ...v, ctr: ctr(v.impressions, v.clicks) })),
          byArea: [...byArea]
            .map(([code, v]) => ({ ...areaRef(index, code), ...v, ctr: ctr(v.impressions, v.clicks) }))
            .sort((a, b) => b.impressions - a.impressions),
        };
      }),
    ),
  };
}
