// Paket keluarga (SPEC §9), modelled on Google One Family: one shared quota pool, every member
// keeps a private "Drive Saya" (invisible to the family owner) plus a shared "Drive Keluarga".
// Pool changes (create, join, leave, dissolve) move nodes, blobs and usage counters in one batch.
import { DAY_MS, SHARE_ID_LENGTH } from '../../shared/constants';
import { formatBytes, formatRupiah } from '../../shared/format';
import { addBillingMonth } from '../../shared/time';
import type { Ctx } from '../context';
import { guardStmt, isGuardFailure } from '../lib/batch-guard';
import { sha256Hex } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { randomBase62, ulid } from '../lib/ids';
import { nameKey } from '../lib/names';
import { ensurePersonalSpace, FAMILY_ROOT_NAME } from './accounts';
import {
  changePlanForPool,
  currentSubscription,
  grantPlanCredits,
  invoiceStmts,
  plan,
  poolLimitStmt,
  runMoneyBatch,
  walletStmts,
  wibAnchorDay,
  type PlanChange,
  type PlanRow,
} from './billing';
import { consumeUsage } from './share-send';
import { noticeEmail } from './email-templates';
import { strings, type Lang } from '../lib/lang';
import { notify } from './notify';
import { appUrl } from '../lib/paths';

type Stmt = D1PreparedStatement;

interface Membership {
  familyId: string;
  role: 'owner' | 'member';
  poolId: string;
  ownerId: string;
  name: string;
}

export async function membership(ctx: Ctx, userId: string): Promise<Membership | null> {
  return ctx.env.DB.prepare(
    `SELECT m.family_id AS familyId, m.role, f.pool_id AS poolId, f.owner_id AS ownerId, f.name
     FROM family_members m JOIN families f ON f.id = m.family_id WHERE m.user_id = ?1`,
  )
    .bind(userId)
    .first<Membership>();
}

async function personalPoolId(ctx: Ctx, userId: string): Promise<string> {
  await ensurePersonalSpace(ctx, userId);
  const p = await ctx.env.DB.prepare(
    `SELECT id FROM storage_pools WHERE owner_type = 'user' AND owner_id = ?1`,
  )
    .bind(userId)
    .first<{ id: string }>();
  if (!p) throw new Error('personal pool missing');
  return p.id;
}

async function audit(
  ctx: Ctx,
  actorId: string,
  action: string,
  targetId: string,
  meta: unknown,
): Promise<void> {
  await ctx.env.DB.prepare(
    `INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?1, ?2, ?3, 'family', ?4, ?5, ?6)`,
  )
    .bind(ulid(ctx.now()), actorId, action, targetId, JSON.stringify(meta ?? null), ctx.now())
    .run();
}

/** Uploads/scans in flight would leave reservations behind in the old pool. */
async function assertNothingInFlight(ctx: Ctx, poolId: string, userId: string): Promise<void> {
  const busy = await ctx.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM nodes WHERE pool_id = ?1 AND created_by = ?2 AND status IN ('uploading', 'scanning')`,
  )
    .bind(poolId, userId)
    .first<{ n: number }>();
  if ((busy?.n ?? 0) > 0)
    throw new AppError('CONFLICT', 'wait for uploads to finish', { reason: 'UPLOADS_IN_FLIGHT' });
}

/** Statements that move every node/blob/usage of `from` into `to` (whole personal pool). */
function movePoolStmts(ctx: Ctx, from: string, to: string): Stmt[] {
  const DB = ctx.env.DB;
  const now = ctx.now();
  return [
    DB.prepare(
      `UPDATE storage_pools SET used_bytes = used_bytes + (SELECT used_bytes FROM storage_pools WHERE id = ?2), updated_at = ?3 WHERE id = ?1`,
    ).bind(to, from, now),
    DB.prepare(
      'UPDATE storage_pools SET used_bytes = 0, reserved_bytes = 0, updated_at = ?2 WHERE id = ?1',
    ).bind(from, now),
    DB.prepare('UPDATE nodes SET pool_id = ?2 WHERE pool_id = ?1').bind(from, to),
    DB.prepare('UPDATE blobs SET pool_id = ?2 WHERE pool_id = ?1').bind(from, to),
  ];
}

/** Credit the unused part of an active personal plan (as credit, ADR-041) and end it (SPEC §9.3). */
async function convertPersonalPlan(
  ctx: Ctx,
  userId: string,
  poolId: string,
): Promise<{ creditIdr: number; stmts: Stmt[] }> {
  const sub = await currentSubscription(ctx, poolId);
  if (!sub) return { creditIdr: 0, stmts: [] };
  const DB = ctx.env.DB;
  const now = ctx.now();
  const stmts: Stmt[] = [
    DB.prepare(
      `UPDATE subscriptions SET status = 'cancelled', status_changed_at = ?2, updated_at = ?2 WHERE id = ?1`,
    ).bind(sub.id, now),
    DB.prepare(
      'UPDATE subscription_addons SET ends_at = ?2 WHERE subscription_id = ?1 AND ends_at IS NULL',
    ).bind(sub.id, now),
  ];
  let creditIdr = 0;
  const cfg = await ctx.config();
  if (sub.status === 'active' && cfg.family_join_convert_prorata) {
    const p = await DB.prepare('SELECT price_idr FROM plans WHERE code = ?1')
      .bind(sub.plan_code)
      .first<{ price_idr: number }>();
    creditIdr = Math.floor(
      ((p?.price_idr ?? 0) * Math.max(0, sub.period_end - now)) /
        Math.max(1, sub.period_end - sub.period_start),
    );
    if (creditIdr > 0)
      stmts.unshift(...walletStmts(ctx, userId, creditIdr, 'plan_convert', sub.id));
  }
  return { creditIdr, stmts };
}

// ───────────────────────── buying / changing the family plan ─────────────────────────
export async function chooseFamilyPlan(ctx: Ctx, userId: string, p: PlanRow): Promise<PlanChange> {
  const m = await membership(ctx, userId);
  if (m && m.role !== 'owner')
    throw new AppError('FORBIDDEN', 'only the family owner pays for the family plan', {
      reason: 'FAMILY_MEMBER',
    });
  if (m) return changePlanForPool(ctx, userId, m.poolId, p);
  return createFamily(ctx, userId, p);
}

async function createFamily(ctx: Ctx, ownerId: string, p: PlanRow): Promise<PlanChange> {
  const personal = await personalPoolId(ctx, ownerId);
  await assertNothingInFlight(ctx, personal, ownerId);
  const usage = await ctx.env.DB.prepare('SELECT used_bytes FROM storage_pools WHERE id = ?1')
    .bind(personal)
    .first<{ used_bytes: number }>();
  if ((usage?.used_bytes ?? 0) > p.storage_bytes) {
    throw new AppError('QUOTA_FULL', 'your files do not fit in this family plan', {
      needBytes: usage?.used_bytes,
      limitBytes: p.storage_bytes,
    });
  }
  const user = await ctx.env.DB.prepare('SELECT name, email FROM users WHERE id = ?1')
    .bind(ownerId)
    .first<{ name: string; email: string }>();
  const DB = ctx.env.DB;
  const now = ctx.now();
  const familyId = ulid(now);
  const poolId = ulid(now);
  const subId = ulid(now);
  const anchor = wibAnchorDay(now);
  const periodEnd = addBillingMonth(now, anchor);
  const convert = await convertPersonalPlan(ctx, ownerId, personal);
  const inv = await invoiceStmts(
    ctx,
    ownerId,
    [
      {
        label: `Paket ${p.name} (${formatBytes(p.storage_bytes)}, ${p.max_members} anggota) · 1 bulan`,
        amountIdr: p.price_idr,
      },
    ],
    null,
  );
  await runMoneyBatch(
    ctx,
    [
      DB.prepare(
        `INSERT INTO storage_pools (id, owner_type, owner_id, updated_at) VALUES (?1, 'family', ?2, ?3)`,
      ).bind(poolId, familyId, now),
      DB.prepare(
        'INSERT INTO families (id, owner_id, pool_id, name, created_at) VALUES (?1, ?2, ?3, ?4, ?5)',
      ).bind(
        familyId,
        ownerId,
        poolId,
        `Keluarga ${(user?.name || user?.email.split('@')[0] || '').slice(0, 40)}`.trim(),
        now,
      ),
      DB.prepare(
        `INSERT INTO family_members (family_id, user_id, role, joined_at) VALUES (?1, ?2, 'owner', ?3)`,
      ).bind(familyId, ownerId, now),
      DB.prepare(
        `INSERT INTO nodes (id, pool_id, space, family_id, owner_id, created_by, parent_id, kind, name, name_key, status, created_at, updated_at)
         VALUES (?1, ?2, 'family', ?3, ?4, ?4, NULL, 'folder', ?5, ?6, 'ready', ?7, ?7)`,
      ).bind(
        ulid(now),
        poolId,
        familyId,
        ownerId,
        FAMILY_ROOT_NAME,
        nameKey(FAMILY_ROOT_NAME),
        now,
      ),
      ...movePoolStmts(ctx, personal, poolId),
      ...convert.stmts,
      ...walletStmts(ctx, ownerId, -inv.total, 'plan', inv.id),
      DB.prepare(
        `INSERT INTO subscriptions (id, pool_id, payer_user_id, plan_code, status, period_start, period_end, anchor_day,
           auto_renew, cancel_at_period_end, status_changed_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?6, ?7, 1, 0, ?5, ?5, ?5)`,
      ).bind(subId, poolId, ownerId, p.code, now, periodEnd, anchor),
      poolLimitStmt(ctx, poolId),
      poolLimitStmt(ctx, personal),
      ...inv.stmts,
    ],
    inv.total,
  );
  await grantPlanCredits(ctx, ownerId, p, periodEnd, subId);
  await audit(ctx, ownerId, 'family.create', familyId, {
    plan: p.code,
    convertedIdr: convert.creditIdr,
  });
  return { kind: 'subscribed', chargedIdr: inv.total, invoiceId: inv.id };
}

// ───────────────────────── invites ─────────────────────────
const INVITE_TTL = 7 * DAY_MS;

async function familyPlan(ctx: Ctx, poolId: string): Promise<PlanRow | null> {
  const sub = await currentSubscription(ctx, poolId);
  return sub ? plan(ctx, sub.plan_code).catch(() => null) : null;
}

export async function createInvite(
  ctx: Ctx,
  ownerId: string,
  channel: string,
): Promise<{ id: string; url: string; expiresAt: number }> {
  const m = await membership(ctx, ownerId);
  if (!m || m.role !== 'owner') throw new AppError('FORBIDDEN', 'only the family owner can invite');
  const sub = await currentSubscription(ctx, m.poolId);
  if (!sub || sub.status !== 'active')
    throw new AppError('READ_ONLY', 'the family plan is not active');
  const token = randomBase62(SHARE_ID_LENGTH / 2);
  const now = ctx.now();
  const id = ulid(now);
  await ctx.env.DB.prepare(
    `INSERT INTO family_invites (id, family_id, token_hash, invited_by, channel, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(
      id,
      m.familyId,
      await sha256Hex(`fi|${token}`),
      ownerId,
      channel.slice(0, 20),
      now + INVITE_TTL,
      now,
    )
    .run();
  await audit(ctx, ownerId, 'family.invite', m.familyId, { inviteId: id, channel });
  return { id, url: appUrl(ctx.env, `/keluarga/gabung/${token}`), expiresAt: now + INVITE_TTL };
}

export async function emailInvite(ctx: Ctx, ownerId: string, to: string): Promise<{ url: string }> {
  if (!/^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(to))
    throw new AppError('VALIDATION', 'invalid email');
  const cfg = await ctx.config();
  if (
    !(await consumeUsage(
      ctx,
      `family_invite:${ownerId}:${new Date(ctx.now()).toISOString().slice(0, 10)}`,
      1,
      cfg.share_email_daily_limit,
      DAY_MS,
    ))
  ) {
    throw new AppError('RATE_LIMITED', 'daily invite limit reached');
  }
  const invite = await createInvite(ctx, ownerId, 'email');
  const owner = await ctx.env.DB.prepare('SELECT name, email, locale FROM users WHERE id = ?1')
    .bind(ownerId)
    .first<{ name: string; email: string; locale: Lang }>();
  // The invitee may have no account yet: the invitation is in the owner's language.
  const lang = owner?.locale ?? 'id';
  const m = strings(lang).mail;
  await ctx.adapters.email.send({
    to: [to],
    tag: 'family_invite',
    replyTo: owner?.email,
    ...noticeEmail(lang, {
      title: m.familyInviteTitle(owner?.name || owner?.email || ''),
      paragraphs: [m.familyInviteBody, m.familyInviteValid],
      cta: { label: m.ctaInvite, url: invite.url },
    }),
  });
  return { url: invite.url };
}

async function findInvite(ctx: Ctx, token: string) {
  if (!/^[0-9A-Za-z]{32}$/.test(token)) return null;
  return ctx.env.DB.prepare(
    `SELECT i.*, f.name AS family_name, f.owner_id, f.pool_id, u.name AS owner_name, u.email AS owner_email
     FROM family_invites i JOIN families f ON f.id = i.family_id JOIN users u ON u.id = f.owner_id WHERE i.token_hash = ?1`,
  )
    .bind(await sha256Hex(`fi|${token}`))
    .first<{
      id: string;
      family_id: string;
      expires_at: number;
      accepted_at: number | null;
      revoked_at: number | null;
      family_name: string;
      owner_id: string;
      pool_id: string;
      owner_name: string;
      owner_email: string;
    }>();
}

async function cooldownUntil(ctx: Ctx, userId: string): Promise<number | null> {
  const cfg = await ctx.config();
  const last = await ctx.env.DB.prepare(
    `SELECT MAX(created_at) AS at FROM audit_logs WHERE target_type = 'family' AND action IN ('family.join', 'family.leave')
       AND (actor_id = ?1 OR meta_json LIKE '%"userId":"' || ?1 || '"%')`,
  )
    .bind(userId)
    .first<{ at: number | null }>();
  if (!last?.at) return null;
  const until = last.at + cfg.family_switch_cooldown_months * 30 * DAY_MS;
  return until > ctx.now() ? until : null;
}

export async function previewInvite(ctx: Ctx, token: string, userId: string | null) {
  const inv = await findInvite(ctx, token);
  const now = ctx.now();
  if (!inv) throw new AppError('NOT_FOUND', 'invite not found');
  const state = inv.revoked_at
    ? 'revoked'
    : inv.accepted_at
      ? 'used'
      : inv.expires_at < now
        ? 'expired'
        : 'valid';
  const p = await familyPlan(ctx, inv.pool_id);
  const members = await ctx.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM family_members WHERE family_id = ?1',
  )
    .bind(inv.family_id)
    .first<{ n: number }>();
  const out: Record<string, unknown> = {
    state,
    familyName: inv.family_name,
    ownerName: inv.owner_name || inv.owner_email.replace(/^(.{2}).*(@.*)$/, '$1***$2'),
    planName: p?.name ?? null,
    storageBytes: p?.storage_bytes ?? 0,
    members: members?.n ?? 0,
    maxMembers: p?.max_members ?? 0,
  };
  if (userId) {
    const mine = await membership(ctx, userId);
    const personal = await personalPoolId(ctx, userId);
    const sub = await currentSubscription(ctx, personal);
    const pool = await ctx.env.DB.prepare('SELECT used_bytes FROM storage_pools WHERE id = ?1')
      .bind(personal)
      .first<{ used_bytes: number }>();
    const fam = await ctx.env.DB.prepare(
      'SELECT limit_bytes, used_bytes, reserved_bytes FROM storage_pools WHERE id = ?1',
    )
      .bind(inv.pool_id)
      .first<{ limit_bytes: number; used_bytes: number; reserved_bytes: number }>();
    const cur = sub?.status === 'active' ? await plan(ctx, sub.plan_code).catch(() => null) : null;
    out.you = {
      inFamily: mine ? (mine.familyId === inv.family_id ? 'this' : 'other') : null,
      cooldownUntil: await cooldownUntil(ctx, userId),
      personalPlan: cur?.name ?? null,
      convertCreditIdr:
        cur && sub
          ? Math.floor(
              (cur.price_idr * Math.max(0, sub.period_end - now)) /
                Math.max(1, sub.period_end - sub.period_start),
            )
          : 0,
      usedBytes: pool?.used_bytes ?? 0,
      fits:
        (pool?.used_bytes ?? 0) <=
        (fam ? fam.limit_bytes - fam.used_bytes - fam.reserved_bytes : 0),
    };
  }
  return out;
}

export async function acceptInvite(
  ctx: Ctx,
  userId: string,
  token: string,
  convertPlan: boolean,
): Promise<{ familyId: string; convertedIdr: number }> {
  const inv = await findInvite(ctx, token);
  const now = ctx.now();
  if (!inv || inv.revoked_at || inv.accepted_at || inv.expires_at < now)
    throw new AppError('NOT_FOUND', 'invite is not valid any more');
  if (await membership(ctx, userId))
    throw new AppError('CONFLICT', 'you are already in a family', { reason: 'ALREADY_IN_FAMILY' });
  const until = await cooldownUntil(ctx, userId);
  if (until)
    throw new AppError('CONFLICT', 'family switch cooldown', { reason: 'FAMILY_COOLDOWN', until });
  const famSub = await currentSubscription(ctx, inv.pool_id);
  if (!famSub || famSub.status !== 'active')
    throw new AppError('READ_ONLY', 'the family plan is not active');
  const p = await plan(ctx, famSub.plan_code);
  const members = await ctx.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM family_members WHERE family_id = ?1',
  )
    .bind(inv.family_id)
    .first<{ n: number }>();
  if ((members?.n ?? 0) >= p.max_members)
    throw new AppError('CONFLICT', 'the family is full', {
      reason: 'FAMILY_FULL',
      max: p.max_members,
    });
  const personal = await personalPoolId(ctx, userId);
  await assertNothingInFlight(ctx, personal, userId);
  const sub = await currentSubscription(ctx, personal);
  if (sub?.status === 'active' && !convertPlan) {
    const cur = await plan(ctx, sub.plan_code).catch(() => null);
    throw new AppError('CONFLICT', 'you still have an active personal plan', {
      reason: 'NEEDS_CONVERT',
      creditIdr: Math.floor(
        ((cur?.price_idr ?? 0) * Math.max(0, sub.period_end - now)) /
          Math.max(1, sub.period_end - sub.period_start),
      ),
    });
  }
  const [mine, fam] = await Promise.all([
    ctx.env.DB.prepare('SELECT used_bytes FROM storage_pools WHERE id = ?1')
      .bind(personal)
      .first<{ used_bytes: number }>(),
    ctx.env.DB.prepare(
      'SELECT limit_bytes, used_bytes, reserved_bytes FROM storage_pools WHERE id = ?1',
    )
      .bind(inv.pool_id)
      .first<{ limit_bytes: number; used_bytes: number; reserved_bytes: number }>(),
  ]);
  const free = fam ? fam.limit_bytes - fam.used_bytes - fam.reserved_bytes : 0;
  if ((mine?.used_bytes ?? 0) > free) {
    throw new AppError('QUOTA_FULL', 'your files do not fit in the family storage', {
      reason: 'FAMILY_QUOTA',
      needBytes: mine?.used_bytes,
      freeBytes: free,
    });
  }
  const convert = await convertPersonalPlan(ctx, userId, personal);
  const DB = ctx.env.DB;
  try {
    await DB.batch([
      DB.prepare(
        `UPDATE family_invites SET accepted_by = ?2, accepted_at = ?3 WHERE id = ?1 AND accepted_at IS NULL`,
      ).bind(inv.id, userId, now),
      DB.prepare(
        `INSERT INTO family_members (family_id, user_id, role, joined_at) VALUES (?1, ?2, 'member', ?3)`,
      ).bind(inv.family_id, userId, now),
      // The checks above ran before the batch: two people accepting at once must not both get in
      // on one invite, nor past the plan's member limit (ADR-056).
      guardStmt(
        DB,
        `(SELECT accepted_by FROM family_invites WHERE id = ?1) = ?2
           AND (SELECT COUNT(*) FROM family_members WHERE family_id = ?3) <= ?4`,
        inv.id,
        userId,
        inv.family_id,
        p.max_members,
      ),
      ...movePoolStmts(ctx, personal, inv.pool_id),
      ...convert.stmts,
      poolLimitStmt(ctx, personal),
    ]);
  } catch (e) {
    if (!isGuardFailure(e)) throw e;
    throw new AppError('CONFLICT', 'the invite was just used or the family is full', {
      reason: 'FAMILY_FULL',
      max: p.max_members,
    });
  }
  await audit(ctx, userId, 'family.join', inv.family_id, {
    userId,
    inviteId: inv.id,
    convertedIdr: convert.creditIdr,
  });
  await notify(ctx, inv.owner_id, 'family_invite', { joined: true, userId });
  return { familyId: inv.family_id, convertedIdr: convert.creditIdr };
}

export async function revokeInvite(ctx: Ctx, ownerId: string, inviteId: string): Promise<void> {
  const m = await membership(ctx, ownerId);
  if (!m || m.role !== 'owner')
    throw new AppError('FORBIDDEN', 'only the family owner can revoke invites');
  await ctx.env.DB.prepare(
    'UPDATE family_invites SET revoked_at = ?3 WHERE id = ?1 AND family_id = ?2 AND accepted_at IS NULL',
  )
    .bind(inviteId, m.familyId, ctx.now())
    .run();
}

// ───────────────────────── leaving ─────────────────────────
/**
 * Member leaves (or is removed): their private files go back to their own pool, items they made in
 * Drive Keluarga stay and pass to the family owner (SPEC §9.3). Without a plan their own pool is
 * read-only, then the dunning cycle applies.
 */
export async function removeMember(ctx: Ctx, actorId: string, memberId: string): Promise<void> {
  const actor = await membership(ctx, actorId);
  const target = await membership(ctx, memberId);
  if (!actor || !target || actor.familyId !== target.familyId)
    throw new AppError('NOT_FOUND', 'member not found');
  if (actorId !== memberId && actor.role !== 'owner')
    throw new AppError('FORBIDDEN', 'only the family owner can remove members');
  if (target.role === 'owner')
    throw new AppError('BAD_REQUEST', 'the owner cannot leave; dissolve the family instead', {
      reason: 'FAMILY_OWNER',
    });
  await assertNothingInFlight(ctx, target.poolId, memberId);
  const DB = ctx.env.DB;
  const now = ctx.now();
  const personal = await personalPoolId(ctx, memberId);

  // Blobs shared between their private files and family items (via "Buat salinan") get their own
  // copy, so no blob ends up shared across pools.
  const { results: shared } = await DB.prepare(
    `SELECT DISTINCT b.id, b.r2_key, b.size, b.sha256, b.crc32, b.sniffed_mime, b.scan_status, b.scanned_at
     FROM nodes n JOIN blobs b ON b.id = n.blob_id
     WHERE n.pool_id = ?1 AND n.space = 'personal' AND n.owner_id = ?2
       AND EXISTS (SELECT 1 FROM nodes o WHERE o.blob_id = b.id AND NOT (o.space = 'personal' AND o.owner_id = ?2))`,
  )
    .bind(target.poolId, memberId)
    .all<{
      id: string;
      r2_key: string;
      size: number;
      sha256: string | null;
      crc32: number | null;
      sniffed_mime: string | null;
      scan_status: string;
      scanned_at: number | null;
    }>();
  for (const b of shared) {
    const obj = await ctx.env.BUCKET.get(b.r2_key);
    if (!obj) continue;
    const newId = ulid(now);
    const key = `u/${memberId}/${newId}`;
    await ctx.env.BUCKET.put(key, obj.body, { httpMetadata: obj.httpMetadata });
    const mineCount = await DB.prepare(
      `SELECT COUNT(*) AS n FROM nodes WHERE blob_id = ?1 AND space = 'personal' AND owner_id = ?2`,
    )
      .bind(b.id, memberId)
      .first<{ n: number }>();
    await DB.batch([
      DB.prepare(
        `INSERT INTO blobs (id, pool_id, r2_key, size, sha256, crc32, sniffed_mime, uploader_id, refcount, scan_status, scanned_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      ).bind(
        newId,
        target.poolId,
        key,
        b.size,
        b.sha256,
        b.crc32,
        b.sniffed_mime,
        memberId,
        mineCount?.n ?? 1,
        b.scan_status,
        b.scanned_at,
        now,
      ),
      DB.prepare(`UPDATE blobs SET refcount = MAX(0, refcount - ?2) WHERE id = ?1`).bind(
        b.id,
        mineCount?.n ?? 1,
      ),
      DB.prepare(
        `UPDATE nodes SET blob_id = ?2 WHERE blob_id = ?1 AND space = 'personal' AND owner_id = ?3`,
      ).bind(b.id, newId, memberId),
    ]);
  }

  const moving = await DB.prepare(
    `SELECT COALESCE(SUM(size), 0) AS bytes FROM nodes WHERE pool_id = ?1 AND space = 'personal' AND owner_id = ?2 AND kind = 'file' AND status = 'ready'`,
  )
    .bind(target.poolId, memberId)
    .first<{ bytes: number }>();
  const bytes = moving?.bytes ?? 0;
  const cheapest = await DB.prepare(
    `SELECT code FROM plans WHERE kind = 'personal' AND active = 1 ORDER BY price_idr LIMIT 1`,
  ).first<{ code: string }>();
  const hasSub = await currentSubscription(ctx, personal);
  await DB.batch([
    DB.prepare(
      `UPDATE blobs SET pool_id = ?2 WHERE pool_id = ?1 AND id IN (SELECT blob_id FROM nodes WHERE pool_id = ?1 AND space = 'personal' AND owner_id = ?3 AND blob_id IS NOT NULL)`,
    ).bind(target.poolId, personal, memberId),
    DB.prepare(
      `UPDATE nodes SET pool_id = ?2 WHERE pool_id = ?1 AND space = 'personal' AND owner_id = ?3`,
    ).bind(target.poolId, personal, memberId),
    DB.prepare(
      'UPDATE storage_pools SET used_bytes = MAX(0, used_bytes - ?2), updated_at = ?3 WHERE id = ?1',
    ).bind(target.poolId, bytes, now),
    DB.prepare(
      'UPDATE storage_pools SET used_bytes = used_bytes + ?2, updated_at = ?3 WHERE id = ?1',
    ).bind(personal, bytes, now),
    DB.prepare(
      `UPDATE nodes SET owner_id = ?3 WHERE family_id = ?1 AND space = 'family' AND owner_id = ?2`,
    ).bind(target.familyId, memberId, target.ownerId),
    DB.prepare(
      `UPDATE shares SET revoked_at = ?3 WHERE created_by = ?1 AND revoked_at IS NULL
         AND id IN (SELECT si.share_id FROM share_items si JOIN nodes n ON n.id = si.node_id WHERE n.family_id = ?2)`,
    ).bind(memberId, target.familyId, now),
    DB.prepare('DELETE FROM family_members WHERE family_id = ?1 AND user_id = ?2').bind(
      target.familyId,
      memberId,
    ),
    // No own plan → read-only now; the normal dunning cycle (suspend/delete) follows.
    ...(!hasSub && cheapest
      ? [
          DB.prepare(
            `INSERT INTO subscriptions (id, pool_id, payer_user_id, plan_code, status, period_start, period_end, anchor_day,
               auto_renew, cancel_at_period_end, status_changed_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'readonly', ?5, ?5, ?6, 0, 1, ?5, ?5, ?5)`,
          ).bind(ulid(now), personal, memberId, cheapest.code, now, wibAnchorDay(now)),
        ]
      : []),
    poolLimitStmt(ctx, personal),
  ]);
  await audit(ctx, actorId, 'family.leave', target.familyId, {
    userId: memberId,
    removedBy: actorId === memberId ? null : actorId,
    movedBytes: bytes,
  });
}

/** Owner ends the family (only when nobody else is in it): everything returns to their own pool. */
export async function dissolveFamily(ctx: Ctx, ownerId: string): Promise<{ creditIdr: number }> {
  const m = await membership(ctx, ownerId);
  if (!m || m.role !== 'owner')
    throw new AppError('FORBIDDEN', 'only the family owner can do this');
  const others = await ctx.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM family_members WHERE family_id = ?1 AND user_id != ?2',
  )
    .bind(m.familyId, ownerId)
    .first<{ n: number }>();
  if ((others?.n ?? 0) > 0)
    throw new AppError('CONFLICT', 'remove the other members first', {
      reason: 'FAMILY_HAS_MEMBERS',
    });
  await assertNothingInFlight(ctx, m.poolId, ownerId);
  const DB = ctx.env.DB;
  const personal = await personalPoolId(ctx, ownerId);
  const personalRoot = await DB.prepare(
    `SELECT id FROM nodes WHERE owner_id = ?1 AND space = 'personal' AND parent_id IS NULL`,
  )
    .bind(ownerId)
    .first<{ id: string }>();
  const famRoot = await DB.prepare(
    `SELECT id FROM nodes WHERE family_id = ?1 AND space = 'family' AND parent_id IS NULL`,
  )
    .bind(m.familyId)
    .first<{ id: string }>();
  const { uniqueName } = await import('./nodes');
  const folderName = await uniqueName(ctx, personalRoot!.id, FAMILY_ROOT_NAME);
  const convert = await convertPersonalPlan(ctx, ownerId, m.poolId);
  await DB.batch([
    // Drive Keluarga becomes an ordinary folder inside Drive Saya.
    DB.prepare(`UPDATE nodes SET parent_id = ?2, name = ?3, name_key = ?4 WHERE id = ?1`).bind(
      famRoot!.id,
      personalRoot!.id,
      folderName,
      nameKey(folderName),
    ),
    DB.prepare(
      `UPDATE nodes SET space = 'personal', family_id = NULL, owner_id = ?2 WHERE family_id = ?1`,
    ).bind(m.familyId, ownerId),
    ...movePoolStmts(ctx, m.poolId, personal),
    ...convert.stmts,
    DB.prepare('DELETE FROM family_invites WHERE family_id = ?1').bind(m.familyId),
    DB.prepare('DELETE FROM family_members WHERE family_id = ?1').bind(m.familyId),
    poolLimitStmt(ctx, personal),
  ]);
  await audit(ctx, ownerId, 'family.dissolve', m.familyId, { creditIdr: convert.creditIdr });
  return { creditIdr: convert.creditIdr };
}

// ───────────────────────── members & caps ─────────────────────────
export async function setMemberCap(
  ctx: Ctx,
  ownerId: string,
  memberId: string,
  capBytes: number | null,
): Promise<void> {
  const m = await membership(ctx, ownerId);
  if (!m || m.role !== 'owner')
    throw new AppError('FORBIDDEN', 'only the family owner can set limits');
  const res = await ctx.env.DB.prepare(
    'UPDATE family_members SET cap_bytes = ?3 WHERE family_id = ?1 AND user_id = ?2',
  )
    .bind(m.familyId, memberId, capBytes)
    .run();
  if (!res.meta.changes) throw new AppError('NOT_FOUND', 'member not found');
  await audit(ctx, ownerId, 'family.cap', m.familyId, { userId: memberId, capBytes });
}

/** Optional per-member cap inside a family pool (soft: checked at upload start). */
export async function assertMemberCap(
  ctx: Ctx,
  poolId: string,
  userId: string,
  bytes: number,
): Promise<void> {
  const row = await ctx.env.DB.prepare(
    `SELECT m.cap_bytes FROM family_members m JOIN families f ON f.id = m.family_id WHERE f.pool_id = ?1 AND m.user_id = ?2`,
  )
    .bind(poolId, userId)
    .first<{ cap_bytes: number | null }>();
  if (!row || row.cap_bytes === null) return;
  const used = await ctx.env.DB.prepare(
    `SELECT COALESCE(SUM(size), 0) AS n FROM nodes WHERE pool_id = ?1 AND created_by = ?2 AND kind = 'file' AND status != 'rejected'`,
  )
    .bind(poolId, userId)
    .first<{ n: number }>();
  if ((used?.n ?? 0) + bytes > row.cap_bytes) {
    throw new AppError('QUOTA_FULL', 'your family storage limit is reached', {
      reason: 'MEMBER_CAP',
      capBytes: row.cap_bytes,
      usedBytes: used?.n ?? 0,
    });
  }
}

export async function familyOverview(ctx: Ctx, userId: string) {
  const m = await membership(ctx, userId);
  if (!m) return { family: null };
  const DB = ctx.env.DB;
  const [members, pool, invites, sub] = await Promise.all([
    // Per-member totals only — never names of private files (SPEC §9.1).
    DB.prepare(
      `SELECT u.id, u.name, u.email, m.role, m.cap_bytes AS capBytes, m.joined_at AS joinedAt,
              (SELECT COALESCE(SUM(size), 0) FROM nodes n WHERE n.pool_id = ?2 AND n.created_by = u.id AND n.kind = 'file' AND n.status = 'ready') AS usedBytes
       FROM family_members m JOIN users u ON u.id = m.user_id WHERE m.family_id = ?1 ORDER BY m.role DESC, m.joined_at`,
    )
      .bind(m.familyId, m.poolId)
      .all(),
    DB.prepare(
      'SELECT limit_bytes AS limitBytes, used_bytes AS usedBytes, reserved_bytes AS reservedBytes FROM storage_pools WHERE id = ?1',
    )
      .bind(m.poolId)
      .first(),
    m.role === 'owner'
      ? DB.prepare(
          `SELECT id, channel, expires_at AS expiresAt, created_at AS createdAt FROM family_invites WHERE family_id = ?1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?2 ORDER BY created_at DESC`,
        )
          .bind(m.familyId, ctx.now())
          .all()
      : Promise.resolve({ results: [] }),
    currentSubscription(ctx, m.poolId),
  ]);
  const p = sub ? await plan(ctx, sub.plan_code).catch(() => null) : null;
  return {
    family: {
      id: m.familyId,
      name: m.name,
      role: m.role,
      ownerId: m.ownerId,
      plan: p && {
        code: p.code,
        name: p.name,
        maxMembers: p.max_members,
        priceIdr: p.price_idr,
        priceText: formatRupiah(p.price_idr),
      },
      subscriptionStatus: sub?.status ?? null,
      storage: pool,
      members: members.results,
      invites: invites.results,
    },
  };
}

export async function renameFamily(ctx: Ctx, ownerId: string, name: string): Promise<void> {
  const m = await membership(ctx, ownerId);
  if (!m || m.role !== 'owner') throw new AppError('FORBIDDEN', 'only the family owner can rename');
  await ctx.env.DB.prepare('UPDATE families SET name = ?2 WHERE id = ?1')
    .bind(m.familyId, name.trim().slice(0, 60))
    .run();
}
