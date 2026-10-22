// Local, non-intrusive ads (SPEC §10, ADR-032): areas + daily inventory, self-serve advertisers,
// moderation, bookings with a 15-minute hold, and region-only serving (no user IDs in ad events).
import {
  AD_BODY_MAX,
  AD_TITLE_MAX,
  bannedTopic,
  type AdCategory,
  type AdCtaType,
  type AdPlacement,
} from '../../shared/ad-policy';
import { addDaysWib, wibDate } from '../../shared/time';
import type { Ctx } from '../context';
import { track } from '../lib/analytics';
import { hmacBase62, sha256Hex, timingSafeEqual } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { randomBase62, ulid } from '../lib/ids';
import {
  createTopup,
  invoiceStmts,
  afterInvoice,
  walletBalance,
  walletStmts,
  type TopupResult,
} from './billing';
import { notify } from './notify';

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

export async function areaName(ctx: Ctx, code: string): Promise<string | null> {
  return (await areaIndex(ctx)).byCode.get(code)?.name ?? null;
}

// ───────────────────────────── inventory (cron 00:05 WIB) ─────────────────────────────

function slotsCase(cfg: Awaited<ReturnType<Ctx['config']>>): { sql: string; binds: number[] } {
  const s = cfg.ad_slots_by_tier;
  return {
    sql: `CASE a.tier WHEN 'tier1' THEN ?2 WHEN 'tier2' THEN ?3 WHEN 'tier3' THEN ?4 WHEN 'province' THEN ?5 ELSE ?6 END`,
    binds: [s.tier1, s.tier2, s.tier3, s.province, s.national],
  };
}

const PLACEMENTS_SQL = `(SELECT 'explorer_sidebar' AS placement UNION ALL SELECT 'share_page')`;

/** Opens today … today+N for every area and placement (idempotent). */
export async function openInventory(ctx: Ctx): Promise<number> {
  const cfg = await ctx.config();
  const today = wibDate(ctx.now());
  const c = slotsCase(cfg);
  const stmts = Array.from({ length: cfg.ad_inventory_days_ahead + 1 }, (_, i) =>
    ctx.env.DB.prepare(
      `INSERT OR IGNORE INTO ad_inventory (date, area_code, placement, total_slots)
       SELECT ?1, a.code, p.placement, ${c.sql} FROM ad_areas a CROSS JOIN ${PLACEMENTS_SQL} p`,
    ).bind(addDaysWib(today, i), ...c.binds),
  );
  const res = await ctx.env.DB.batch(stmts);
  return res.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}

function ensureInventoryStmt(
  ctx: Ctx,
  cfg: Awaited<ReturnType<Ctx['config']>>,
  date: string,
  area: string,
  placement: AdPlacement,
): Stmt {
  const c = slotsCase(cfg);
  return ctx.env.DB.prepare(
    `INSERT OR IGNORE INTO ad_inventory (date, area_code, placement, total_slots)
     SELECT ?1, a.code, ?7, ${c.sql} FROM ad_areas a WHERE a.code = ?8`,
  ).bind(date, ...c.binds, placement, area);
}

/** Nightly: open inventory, start today's paid bookings, finish yesterday's, drop old rows. */
export async function runAdsDaily(
  ctx: Ctx,
): Promise<{ opened: number; live: number; completed: number }> {
  const opened = await openInventory(ctx);
  const today = wibDate(ctx.now());
  const now = ctx.now();
  const [live, completed] = await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `UPDATE ad_bookings SET status = 'live', updated_at = ?2 WHERE status = 'paid' AND date = ?1`,
    ).bind(today, now),
    ctx.env.DB.prepare(
      `UPDATE ad_bookings SET status = 'completed', updated_at = ?2 WHERE status IN ('live', 'paid') AND date < ?1`,
    ).bind(today, now),
    ctx.env.DB.prepare(`DELETE FROM ad_inventory WHERE date < ?1`).bind(addDaysWib(today, -60)),
  ]);
  return { opened, live: live?.meta.changes ?? 0, completed: completed?.meta.changes ?? 0 };
}

/** Hourly (and before reads): unpaid holds give their slot back. */
export async function releaseExpiredHolds(ctx: Ctx, limit = 500): Promise<number> {
  const now = ctx.now();
  const { results } = await ctx.env.DB.prepare(
    `SELECT id, date, area_code, placement FROM ad_bookings WHERE status = 'held' AND hold_expires_at < ?1 LIMIT ?2`,
  )
    .bind(now, limit)
    .all<{ id: string; date: string; area_code: string; placement: string }>();
  if (!results.length) return 0;
  // Slot first (guarded on "still held"), then the booking — both in one transaction.
  await ctx.env.DB.batch(
    results.flatMap((b) => [
      ctx.env.DB.prepare(
        `UPDATE ad_inventory SET booked_slots = MAX(0, booked_slots - 1) WHERE date = ?1 AND area_code = ?2 AND placement = ?3
           AND EXISTS (SELECT 1 FROM ad_bookings WHERE id = ?4 AND status = 'held' AND hold_expires_at < ?5)`,
      ).bind(b.date, b.area_code, b.placement, b.id, now),
      ctx.env.DB.prepare(
        `UPDATE ad_bookings SET status = 'cancelled', updated_at = ?2 WHERE id = ?1 AND status = 'held' AND hold_expires_at < ?2`,
      ).bind(b.id, now),
    ]),
  );
  return results.length;
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
  if (!a) throw new AppError('FORBIDDEN', 'NOT_ADVERTISER');
  return a;
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
       kind = excluded.kind, student_verified = CASE WHEN excluded.kind = 'mahasiswa' THEN student_verified ELSE 0 END`,
  )
    .bind(userId, name, p.kind, phone, ctx.now())
    .run();
  return (await getAdvertiser(ctx, userId))!;
}

/** Diskon mahasiswa: OTP ke email kampus `.ac.id` (SPEC §10.5). */
export async function requestStudentOtp(ctx: Ctx, userId: string, email: string): Promise<void> {
  const a = await requireAdvertiser(ctx, userId);
  if (a.kind !== 'mahasiswa') throw new AppError('BAD_REQUEST', 'NOT_STUDENT');
  const addr = email.trim().toLowerCase();
  if (!/^[^\s@]+@([a-z0-9-]+\.)+ac\.id$/.test(addr))
    throw new AppError('VALIDATION', 'campus email must end with .ac.id', { field: 'email' });
  const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 900000));
  await ctx.env.CONFIG_KV.put(
    `adst:${userId}`,
    JSON.stringify({ email: addr, hash: await sha256Hex(`adst|${userId}|${code}`), tries: 0 }),
    {
      expirationTtl: 600,
    },
  );
  await ctx.adapters.email.send({
    to: [addr],
    subject: `Kode verifikasi mahasiswa Zeiko: ${code}`,
    text: `Kode verifikasi email kampus untuk diskon iklan mahasiswa: ${code}\n\nBerlaku 10 menit. Abaikan email ini kalau kamu tidak memintanya.`,
    tag: 'otp',
  });
}

export async function verifyStudentOtp(ctx: Ctx, userId: string, code: string): Promise<boolean> {
  const key = `adst:${userId}`;
  const s = await ctx.env.CONFIG_KV.get<{ email: string; hash: string; tries: number }>(
    key,
    'json',
  );
  if (!s) throw new AppError('BAD_REQUEST', 'OTP_EXPIRED');
  if (!timingSafeEqual(s.hash, await sha256Hex(`adst|${userId}|${code.trim()}`))) {
    if (s.tries + 1 >= 5) await ctx.env.CONFIG_KV.delete(key);
    else
      await ctx.env.CONFIG_KV.put(key, JSON.stringify({ ...s, tries: s.tries + 1 }), {
        expirationTtl: 600,
      });
    return false;
  }
  await ctx.env.CONFIG_KV.delete(key);
  await ctx.env.DB.prepare(
    'UPDATE advertisers SET student_verified = 1, student_email = ?2 WHERE user_id = ?1',
  )
    .bind(userId, s.email)
    .run();
  return true;
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

async function hasUpcomingBookings(ctx: Ctx, creativeId: string): Promise<boolean> {
  const r = await ctx.env.DB.prepare(
    `SELECT 1 AS x FROM ad_bookings WHERE creative_id = ?1 AND status IN ('held', 'paid', 'live') LIMIT 1`,
  )
    .bind(creativeId)
    .first();
  return Boolean(r);
}

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
    if (await hasUpcomingBookings(ctx, c.id)) throw new AppError('CONFLICT', 'CREATIVE_IN_USE');
    if (c.status === 'suspended') throw new AppError('FORBIDDEN', 'CREATIVE_SUSPENDED');
    await ctx.env.DB.prepare(
      `UPDATE ad_creatives SET title = ?2, body = ?3, cta_type = ?4, cta_value = ?5, category = ?6, status = 'draft',
         reject_reason = NULL, updated_at = ?7 WHERE id = ?1`,
    )
      .bind(
        id,
        input.title.trim(),
        input.body.trim(),
        input.ctaType,
        input.ctaValue.trim(),
        input.category,
        now,
      )
      .run();
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
  if (await hasUpcomingBookings(ctx, c.id)) throw new AppError('CONFLICT', 'CREATIVE_IN_USE');
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
  await ctx.env.DB.prepare(
    `UPDATE ad_creatives SET image_key = ?2, status = 'draft', reject_reason = NULL, updated_at = ?3 WHERE id = ?1`,
  )
    .bind(c.id, key, ctx.now())
    .run();
  if (c.image_key) await ctx.env.BUCKET.delete(c.image_key);
  return requireCreative(ctx, userId, id);
}

/** Kirim ke moderasi: filter otomatis dulu, lalu antre untuk admin (SLA config). */
export async function submitCreative(ctx: Ctx, userId: string, id: string): Promise<CreativeRow> {
  const c = await requireCreative(ctx, userId, id);
  if (c.status !== 'draft' && c.status !== 'rejected')
    throw new AppError('CONFLICT', 'CREATIVE_STATE');
  if (!c.image_key) throw new AppError('VALIDATION', 'IMAGE_REQUIRED', { field: 'image' });
  const adv = await requireAdvertiser(ctx, userId);
  const topic = bannedTopic(c.title, c.body, c.cta_value, adv.business_name);
  const now = ctx.now();
  if (topic) {
    await ctx.env.DB.prepare(
      `UPDATE ad_creatives SET status = 'rejected', reject_reason = ?2, reviewed_by = NULL, reviewed_at = ?3, updated_at = ?3 WHERE id = ?1`,
    )
      .bind(id, `Otomatis: melanggar kebijakan (${topic})`, now)
      .run();
    return requireCreative(ctx, userId, id);
  }
  await ctx.env.DB.prepare(
    `UPDATE ad_creatives SET status = 'pending', reject_reason = NULL, updated_at = ?2 WHERE id = ?1`,
  )
    .bind(id, now)
    .run();
  await ctx.env.NOTIFY_QUEUE.send({
    type: 'admin_alert',
    text: `Materi iklan baru menunggu moderasi: "${c.title}" (${adv.business_name}).`,
  });
  return requireCreative(ctx, userId, id);
}

// ───────────────────────────── moderation (admin) ─────────────────────────────

async function auditAd(
  ctx: Ctx,
  actorId: string,
  action: string,
  targetId: string,
  meta: unknown,
): Promise<void> {
  await ctx.env.DB.prepare(
    `INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?1, ?2, ?3, 'ad_creative', ?4, ?5, ?6)`,
  )
    .bind(ulid(ctx.now()), actorId, action, targetId, JSON.stringify(meta ?? null), ctx.now())
    .run();
}

export async function listCreativesForReview(ctx: Ctx, status: CreativeRow['status'] = 'pending') {
  const { results } = await ctx.env.DB.prepare(
    `SELECT c.*, a.business_name, a.kind AS advertiser_kind,
       (SELECT COUNT(*) FROM abuse_reports r WHERE r.target_type = 'ad' AND r.target_id = c.id AND r.status = 'open') AS open_reports
     FROM ad_creatives c JOIN advertisers a ON a.user_id = c.advertiser_id
     WHERE c.status = ?1 ORDER BY c.updated_at ASC LIMIT 100`,
  )
    .bind(status)
    .all<CreativeRow & { business_name: string; advertiser_kind: string; open_reports: number }>();
  return results.map((c) => ({
    ...creativeDto(c),
    businessName: c.business_name,
    advertiserKind: c.advertiser_kind,
    openReports: c.open_reports,
  }));
}

export async function reviewCreative(
  ctx: Ctx,
  actorId: string,
  id: string,
  decision: 'approve' | 'reject',
  reason: string,
): Promise<void> {
  const now = ctx.now();
  const res = await ctx.env.DB.prepare(
    `UPDATE ad_creatives SET status = ?2, reject_reason = ?3, reviewed_by = ?4, reviewed_at = ?5, updated_at = ?5
     WHERE id = ?1 AND status = 'pending'`,
  )
    .bind(
      id,
      decision === 'approve' ? 'approved' : 'rejected',
      decision === 'reject' ? reason : null,
      actorId,
      now,
    )
    .run();
  if (!res.meta.changes) throw new AppError('CONFLICT', 'CREATIVE_STATE');
  await auditAd(ctx, actorId, `ad.${decision}`, id, { reason });
  const c = await ctx.env.DB.prepare('SELECT advertiser_id, title FROM ad_creatives WHERE id = ?1')
    .bind(id)
    .first<{ advertiser_id: string; title: string }>();
  if (c)
    await notify(ctx, c.advertiser_id, 'ad_status', {
      creativeId: id,
      title: c.title,
      status: decision === 'approve' ? 'approved' : 'rejected',
      reason,
    });
}

/**
 * Takedown of an approved creative (SPEC §10.5): upcoming/live bookings stop. The unused days are
 * refunded to Saldo unless the violation is severe and `ad_refund_on_suspend.severe` is false.
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
  const DB = ctx.env.DB;
  const c = await DB.prepare('SELECT * FROM ad_creatives WHERE id = ?1')
    .bind(id)
    .first<CreativeRow>();
  if (!c) throw new AppError('NOT_FOUND', 'creative not found');
  const refund = severe ? cfg.ad_refund_on_suspend.severe : cfg.ad_refund_on_suspend.other;
  const { results } = await DB.prepare(
    `SELECT id, price_idr, status FROM ad_bookings WHERE creative_id = ?1 AND status IN ('paid', 'live')`,
  )
    .bind(id)
    .all<{ id: string; price_idr: number; status: string }>();
  const amount = refund ? results.reduce((s, b) => s + b.price_idr, 0) : 0;
  const stmts: Stmt[] = [
    DB.prepare(
      `UPDATE ad_creatives SET status = 'suspended', reject_reason = ?2, reviewed_by = ?3, reviewed_at = ?4, updated_at = ?4 WHERE id = ?1`,
    ).bind(id, reason, actorId, now),
    DB.prepare(
      `UPDATE ad_bookings SET status = ?2, updated_at = ?3 WHERE creative_id = ?1 AND status IN ('paid', 'live')`,
    ).bind(id, refund ? 'refunded' : 'cancelled', now),
  ];
  if (amount > 0)
    stmts.push(...walletStmts(ctx, c.advertiser_id, amount, 'ad_refund', `suspend:${id}:${now}`));
  await DB.batch(stmts);
  await auditAd(ctx, actorId, 'ad.suspend', id, {
    severe,
    reason,
    refundedIdr: amount,
    bookings: results.length,
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

// ───────────────────────────── availability & booking ─────────────────────────────

async function priceFor(
  ctx: Ctx,
  area: AreaRow,
  placement: AdPlacement,
  adv: AdvertiserRow | null,
): Promise<number> {
  const p = await ctx.env.DB.prepare(
    'SELECT price_per_day_idr AS price FROM ad_prices WHERE area_level = ?1 AND tier = ?2 AND placement = ?3 AND active = 1',
  )
    .bind(area.level, area.tier, placement)
    .first<{ price: number }>();
  if (!p) throw new AppError('BAD_REQUEST', 'NO_PRICE');
  if (adv?.kind === 'mahasiswa' && adv.student_verified) {
    const cfg = await ctx.config();
    return Math.round((p.price * (100 - cfg.ad_student_discount_pct)) / 100);
  }
  return p.price;
}

async function requireArea(ctx: Ctx, code: string): Promise<AreaRow> {
  const a = (await areaIndex(ctx)).byCode.get(code);
  if (!a) throw new AppError('NOT_FOUND', 'area not found');
  return a;
}

export async function availability(
  ctx: Ctx,
  userId: string | null,
  areaCode: string,
  placement: AdPlacement,
) {
  const cfg = await ctx.config();
  const area = await requireArea(ctx, areaCode);
  await releaseExpiredHolds(ctx, 100);
  const today = wibDate(ctx.now());
  const dates = Array.from({ length: cfg.ad_inventory_days_ahead + 1 }, (_, i) =>
    addDaysWib(today, i),
  );
  await ctx.env.DB.batch(dates.map((d) => ensureInventoryStmt(ctx, cfg, d, area.code, placement)));
  const { results } = await ctx.env.DB.prepare(
    `SELECT date, total_slots, booked_slots FROM ad_inventory WHERE area_code = ?1 AND placement = ?2 AND date >= ?3 AND date <= ?4 ORDER BY date`,
  )
    .bind(area.code, placement, dates[0], dates[dates.length - 1])
    .all<{ date: string; total_slots: number; booked_slots: number }>();
  const adv = userId ? await getAdvertiser(ctx, userId) : null;
  const priceIdr = await priceFor(ctx, area, placement, adv);
  return {
    area: { code: area.code, name: area.name, level: area.level },
    placement,
    priceIdr,
    days: results.map((r) => ({
      date: r.date,
      remaining: r.total_slots - r.booked_slots,
      total: r.total_slots,
    })),
  };
}

export interface BookingRow {
  id: string;
  creative_id: string;
  area_code: string;
  placement: AdPlacement;
  date: string;
  price_idr: number;
  status: 'held' | 'paid' | 'live' | 'completed' | 'refunded' | 'cancelled';
  hold_expires_at: number | null;
  payment_id: string | null;
  impressions: number;
  clicks: number;
  created_at: number;
  updated_at: number;
}

/**
 * Holds one slot per date (first come, first served). All dates go in one transaction: the
 * `booked_slots <= total_slots` CHECK aborts it when any date is full, so nothing is overbooked.
 */
export async function holdBookings(
  ctx: Ctx,
  userId: string,
  p: { creativeId: string; areaCode: string; placement: AdPlacement; dates: string[] },
): Promise<{ bookingIds: string[]; totalIdr: number; holdExpiresAt: number }> {
  const cfg = await ctx.config();
  const adv = await requireAdvertiser(ctx, userId);
  const c = await requireCreative(ctx, userId, p.creativeId);
  if (c.status !== 'approved') throw new AppError('CONFLICT', 'CREATIVE_NOT_APPROVED');
  const area = await requireArea(ctx, p.areaCode);
  const today = wibDate(ctx.now());
  const last = addDaysWib(today, cfg.ad_inventory_days_ahead);
  const dates = [...new Set(p.dates)].sort();
  if (!dates.length || dates.length > cfg.ad_inventory_days_ahead + 1)
    throw new AppError('VALIDATION', 'dates', { field: 'dates' });
  if (dates.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d) || d < today || d > last))
    throw new AppError('VALIDATION', 'DATE_OUT_OF_RANGE', { field: 'dates' });
  await releaseExpiredHolds(ctx, 100);
  const price = await priceFor(ctx, area, p.placement, adv);
  const now = ctx.now();
  const holdExpiresAt = now + cfg.ad_hold_minutes * 60_000;
  const DB = ctx.env.DB;
  const ids: string[] = [];
  const stmts: Stmt[] = [];
  for (const date of dates) {
    const id = ulid(now);
    ids.push(id);
    stmts.push(
      ensureInventoryStmt(ctx, cfg, date, area.code, p.placement),
      DB.prepare(
        `INSERT INTO ad_bookings (id, creative_id, area_code, placement, date, price_idr, status, hold_expires_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'held', ?7, ?8, ?8)`,
      ).bind(id, c.id, area.code, p.placement, date, price, holdExpiresAt, now),
      DB.prepare(
        `UPDATE ad_inventory SET booked_slots = booked_slots + 1 WHERE date = ?1 AND area_code = ?2 AND placement = ?3`,
      ).bind(date, area.code, p.placement),
    );
  }
  try {
    await DB.batch(stmts);
  } catch (e) {
    if (!/CHECK constraint failed/i.test(String(e))) throw e;
    const { results } = await DB.prepare(
      `SELECT date FROM ad_inventory WHERE area_code = ?1 AND placement = ?2 AND booked_slots >= total_slots
       AND date IN (${dates.map((_, i) => `?${i + 3}`).join(', ')})`,
    )
      .bind(area.code, p.placement, ...dates)
      .all<{ date: string }>();
    throw new AppError('CONFLICT', 'SOLD_OUT', { dates: results.map((r) => r.date) });
  }
  return { bookingIds: ids, totalIdr: price * dates.length, holdExpiresAt };
}

async function heldBookings(ctx: Ctx, userId: string, ids: string[]): Promise<BookingRow[]> {
  if (!ids.length || ids.length > 100) throw new AppError('VALIDATION', 'bookingIds');
  const { results } = await ctx.env.DB.prepare(
    `SELECT b.* FROM ad_bookings b JOIN ad_creatives c ON c.id = b.creative_id
     WHERE c.advertiser_id = ?1 AND b.id IN (${ids.map((_, i) => `?${i + 2}`).join(', ')})`,
  )
    .bind(userId, ...ids)
    .all<BookingRow>();
  if (results.length !== new Set(ids).size) throw new AppError('NOT_FOUND', 'booking not found');
  if (results.some((b) => b.status !== 'held' || (b.hold_expires_at ?? 0) < ctx.now()))
    throw new AppError('CONFLICT', 'HOLD_EXPIRED');
  return results;
}

/** Pays held bookings from Saldo in one batch; today's bookings go live immediately. */
export async function payBookingsFromWallet(
  ctx: Ctx,
  userId: string,
  ids: string[],
): Promise<{ invoiceId: string; totalIdr: number }> {
  const bookings = await heldBookings(ctx, userId, ids);
  const index = await areaIndex(ctx);
  const lines = bookings.map((b) => ({
    label: `Iklan ${b.placement === 'share_page' ? 'halaman share' : 'explorer'} · ${index.byCode.get(b.area_code)?.name ?? b.area_code} · ${b.date}`,
    amountIdr: b.price_idr,
  }));
  const inv = await invoiceStmts(ctx, userId, lines, null);
  const now = ctx.now();
  const today = wibDate(now);
  const DB = ctx.env.DB;
  const placeholders = bookings.map((_, i) => `?${i + 4}`).join(', ');
  const stmts: Stmt[] = [
    // Aborts the batch (CHECK balance >= 0) if a hold expired in the meantime.
    DB.prepare(
      `UPDATE wallets SET balance_idr = -1 WHERE user_id = ?1
         AND (SELECT COUNT(*) FROM ad_bookings WHERE status = 'held' AND hold_expires_at >= ?2 AND id IN (${placeholders})) != ?3`,
    ).bind(userId, now, bookings.length, ...bookings.map((b) => b.id)),
    ...walletStmts(ctx, userId, -inv.total, 'ad_booking', inv.id),
    DB.prepare(
      `UPDATE ad_bookings SET status = CASE WHEN date = ?1 THEN 'live' ELSE 'paid' END, hold_expires_at = NULL, updated_at = ?2
       WHERE status = 'held' AND id IN (${bookings.map((_, i) => `?${i + 3}`).join(', ')})`,
    ).bind(today, now, ...bookings.map((b) => b.id)),
    ...inv.stmts,
  ];
  try {
    await DB.batch(stmts);
  } catch (e) {
    if (!/CHECK constraint failed/i.test(String(e))) throw e;
    await heldBookings(ctx, userId, ids); // throws HOLD_EXPIRED if that was the cause
    throw new AppError('INSUFFICIENT_BALANCE', 'saldo tidak cukup', { needIdr: inv.total });
  }
  await afterInvoice(ctx, userId, inv.id, `Iklan lokal (${bookings.length} hari).`);
  if (bookings.some((b) => b.date === today)) await bumpServeVersion(ctx);
  return { invoiceId: inv.id, totalIdr: inv.total };
}

/** Bayar: Saldo if it covers the total, otherwise a QRIS/VA top-up that pays on success. */
export async function checkoutBookings(
  ctx: Ctx,
  user: { id: string; email: string },
  ids: string[],
  method: string,
): Promise<{ paid: true; invoiceId: string } | { paid: false; topup: TopupResult }> {
  const bookings = await heldBookings(ctx, user.id, ids);
  const subtotal = bookings.reduce((s, b) => s + b.price_idr, 0);
  const cfg = await ctx.config();
  const total = subtotal + Math.round((subtotal * cfg.tax_rate_pct) / 100);
  const balance = await walletBalance(ctx, user.id);
  if (method === 'saldo' || balance >= total) {
    const r = await payBookingsFromWallet(ctx, user.id, ids);
    return { paid: true, invoiceId: r.invoiceId };
  }
  const topup = await createTopup(ctx, user, {
    amountIdr: Math.max(total - balance, cfg.min_topup_idr),
    method,
    then: { kind: 'ads', bookingIds: bookings.map((b) => b.id) },
  });
  return { paid: false, topup };
}

// ───────────────────────────── serving ─────────────────────────────

export interface AdDto {
  bookingId: string | null;
  creativeId: string | null;
  title: string;
  body: string;
  imageUrl: string | null;
  ctaLabel: string;
  clickUrl: string;
  label: string;
  /** Impression token (null for internal ads). */
  token: string | null;
  internal: boolean;
}

interface Candidate {
  bookingId: string;
  creativeId: string;
  title: string;
  body: string;
  ctaType: AdCtaType;
  impressions: number;
}

const CTA_LABEL: Record<AdCtaType, string> = {
  web: 'Kunjungi',
  whatsapp: 'Chat WhatsApp',
  instagram: 'Lihat Instagram',
  tiktok: 'Lihat TikTok',
  shopee: 'Lihat di Shopee',
  tokopedia: 'Lihat di Tokopedia',
};

async function serveVersion(ctx: Ctx): Promise<string> {
  return (await ctx.env.CONFIG_KV.get('adv:ver')) ?? '0';
}

/** New version → every cached candidate list is ignored (after a payment for today or a takedown). */
async function bumpServeVersion(ctx: Ctx): Promise<void> {
  await ctx.env.CONFIG_KV.put('adv:ver', String(ctx.now()));
}

async function candidates(
  ctx: Ctx,
  date: string,
  area: string,
  placement: AdPlacement,
): Promise<Candidate[]> {
  const cfg = await ctx.config();
  const key = `adc:${await serveVersion(ctx)}:${date}:${area}:${placement}`;
  const cached = await ctx.env.CONFIG_KV.get<Candidate[]>(key, 'json');
  if (cached) return cached;
  const { results } = await ctx.env.DB.prepare(
    `SELECT b.id AS bookingId, c.id AS creativeId, c.title, c.body, c.cta_type AS ctaType, b.impressions
     FROM ad_bookings b JOIN ad_creatives c ON c.id = b.creative_id
     WHERE b.date = ?1 AND b.area_code = ?2 AND b.placement = ?3 AND b.status = 'live' AND c.status = 'approved' AND c.image_key IS NOT NULL`,
  )
    .bind(date, area, placement)
    .all<Candidate>();
  await ctx.env.CONFIG_KV.put(key, JSON.stringify(results), {
    expirationTtl: Math.max(60, cfg.ad_candidates_cache_seconds),
  });
  return results;
}

async function impressionToken(ctx: Ctx, bookingId: string, date: string): Promise<string> {
  return hmacBase62(ctx.env.DOWNLOAD_SECRET, `adi|${bookingId}|${date}`, 22);
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

/**
 * Picks one ad for `placement` (SPEC §10.7): most specific area with a live booking wins; inside it
 * the booking with the fewest impressions so far, random among ties. Falls back to an internal ad.
 */
export async function serveAd(
  ctx: Ctx,
  placement: AdPlacement,
  chain: string[],
  exclude: string[] = [],
): Promise<AdDto | null> {
  const date = wibDate(ctx.now());
  const index = await areaIndex(ctx);
  for (const code of chain) {
    const list = (await candidates(ctx, date, code, placement)).filter(
      (x) => !exclude.includes(x.creativeId),
    );
    if (!list.length) continue;
    const min = Math.min(...list.map((x) => x.impressions));
    const tied = list.filter((x) => x.impressions === min);
    const pick = tied[Math.floor(Math.random() * tied.length)]!;
    track(ctx.env.ANALYTICS, 'ad_impression', { index: code, blobs: ['served', placement, code] });
    return {
      bookingId: pick.bookingId,
      creativeId: pick.creativeId,
      title: pick.title,
      body: pick.body,
      imageUrl: `/ad/img/${pick.creativeId}`,
      ctaLabel: CTA_LABEL[pick.ctaType],
      clickUrl: `/ad/c/${pick.bookingId}`,
      label: `Iklan · ${code === 'ID' ? 'Indonesia' : (index.byCode.get(code)?.name ?? '')}`,
      token: await impressionToken(ctx, pick.bookingId, date),
      internal: false,
    };
  }
  const cheapest = await ctx.env.DB.prepare(
    'SELECT MIN(price_per_day_idr) AS p FROM ad_prices WHERE active = 1',
  ).first<{ p: number | null }>();
  return {
    bookingId: null,
    creativeId: null,
    title: 'Pasang iklan di Zeiko',
    body: `Iklan lokal untuk usahamu, mulai Rp${(cheapest?.p ?? 0).toLocaleString('id-ID')}/hari. Tampil di kotamu saja.`,
    imageUrl: null,
    ctaLabel: 'Pasang iklan',
    clickUrl: '/iklan',
    label: 'Iklan · Zeiko',
    token: null,
    internal: true,
  };
}

export async function recordImpression(
  ctx: Ctx,
  bookingId: string,
  token: string,
): Promise<boolean> {
  const date = wibDate(ctx.now());
  if (!timingSafeEqual(token, await impressionToken(ctx, bookingId, date))) return false;
  const res = await ctx.env.DB.prepare(
    `UPDATE ad_bookings SET impressions = impressions + 1 WHERE id = ?1 AND status = 'live' AND date = ?2`,
  )
    .bind(bookingId, date)
    .run();
  if (res.meta.changes)
    track(ctx.env.ANALYTICS, 'ad_impression', { index: bookingId, blobs: ['viewed'] });
  return res.meta.changes === 1;
}

/** `/ad/c/{bookingId}` → count → destination. Unknown/ended bookings go to the home page. */
export async function recordClick(ctx: Ctx, bookingId: string): Promise<string> {
  const row = await ctx.env.DB.prepare(
    `SELECT c.cta_type, c.cta_value, b.status FROM ad_bookings b JOIN ad_creatives c ON c.id = b.creative_id WHERE b.id = ?1`,
  )
    .bind(bookingId)
    .first<{ cta_type: AdCtaType; cta_value: string; status: string }>();
  if (!row || !['live', 'completed'].includes(row.status)) return ctx.env.APP_ORIGIN;
  const cta = ctaUrl(row.cta_type, row.cta_value);
  if ('error' in cta) return ctx.env.APP_ORIGIN;
  if (row.status === 'live') {
    await ctx.env.DB.prepare(`UPDATE ad_bookings SET clicks = clicks + 1 WHERE id = ?1`)
      .bind(bookingId)
      .run();
    track(ctx.env.ANALYTICS, 'ad_click', { index: bookingId, blobs: [row.cta_type] });
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

/** Moderator preview of any creative image (pending ones are not public). */
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

/** Owner preview of their own (not yet approved) creative image. */
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

// ───────────────────────────── dashboard ─────────────────────────────

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

export async function advertiserDashboard(ctx: Ctx, userId: string) {
  const adv = await getAdvertiser(ctx, userId);
  if (!adv) return { advertiser: null, creatives: [], bookings: [] };
  await releaseExpiredHolds(ctx, 100);
  const index = await areaIndex(ctx);
  const [{ results: creatives }, { results: bookings }] = await Promise.all([
    ctx.env.DB.prepare(
      'SELECT * FROM ad_creatives WHERE advertiser_id = ?1 ORDER BY updated_at DESC',
    )
      .bind(userId)
      .all<CreativeRow>(),
    ctx.env.DB.prepare(
      `SELECT b.*, c.title FROM ad_bookings b JOIN ad_creatives c ON c.id = b.creative_id
       WHERE c.advertiser_id = ?1 AND b.status != 'cancelled' ORDER BY b.date DESC, b.created_at DESC LIMIT 300`,
    )
      .bind(userId)
      .all<BookingRow & { title: string }>(),
  ]);
  return {
    advertiser: {
      businessName: adv.business_name,
      kind: adv.kind,
      phone: adv.phone,
      studentVerified: adv.student_verified === 1,
      studentEmail: adv.student_email,
    },
    creatives: creatives.map(creativeDto),
    bookings: bookings.map((b) => ({
      id: b.id,
      creativeId: b.creative_id,
      title: b.title,
      areaCode: b.area_code,
      areaName: index.byCode.get(b.area_code)?.name ?? b.area_code,
      placement: b.placement,
      date: b.date,
      priceIdr: b.price_idr,
      status: b.status,
      holdExpiresAt: b.hold_expires_at,
      impressions: b.impressions,
      clicks: b.clicks,
      ctr: b.impressions ? b.clicks / b.impressions : 0,
    })),
  };
}

export async function cancelHeld(ctx: Ctx, userId: string, ids: string[]): Promise<void> {
  const bookings = await heldBookings(ctx, userId, ids);
  const now = ctx.now();
  await ctx.env.DB.batch(
    bookings.flatMap((b) => [
      ctx.env.DB.prepare(
        `UPDATE ad_inventory SET booked_slots = MAX(0, booked_slots - 1) WHERE date = ?1 AND area_code = ?2 AND placement = ?3
           AND EXISTS (SELECT 1 FROM ad_bookings WHERE id = ?4 AND status = 'held')`,
      ).bind(b.date, b.area_code, b.placement, b.id),
      ctx.env.DB.prepare(
        `UPDATE ad_bookings SET status = 'cancelled', updated_at = ?2 WHERE id = ?1 AND status = 'held'`,
      ).bind(b.id, now),
    ]),
  );
}
