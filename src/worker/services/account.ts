// Account rights under UU PDP (SPEC §14.5): export personal data, delete account after a waiting
// period. Invoices and the wallet ledger are kept (accounting obligations) but de-identified.
import { DAY_MS } from '../../shared/constants';
import type { Ctx } from '../context';
import { AppError } from '../lib/errors';
import { ulid } from '../lib/ids';
import { log } from '../lib/log';
import { ensurePersonalSpace } from './accounts';
import { notify } from './notify';

export async function exportData(ctx: Ctx, userId: string): Promise<Record<string, unknown>> {
  const DB = ctx.env.DB;
  const q = async (sql: string, ...binds: unknown[]) =>
    (
      await DB.prepare(sql)
        .bind(...binds)
        .all()
    ).results;
  const space = await ensurePersonalSpace(ctx, userId);
  return {
    exportedAt: new Date(ctx.now()).toISOString(),
    note: 'Isi file tidak termasuk di sini; unduh lewat "Unduh semua file (ZIP)".',
    account: (
      await q(
        'SELECT id, email, name, status, ad_city_code, ad_city, ad_postal_code, created_at, updated_at FROM users WHERE id = ?1',
        userId,
      )
    )[0],
    sessions: await q(
      'SELECT created_at, updated_at, expires_at, user_agent FROM sessions WHERE user_id = ?1',
      userId,
    ),
    storage: (
      await q(
        'SELECT limit_bytes, used_bytes, bonus_bytes FROM storage_pools WHERE id = ?1',
        space.poolId,
      )
    )[0],
    subscriptions: await q(
      'SELECT plan_code, status, period_start, period_end, created_at FROM subscriptions WHERE payer_user_id = ?1',
      userId,
    ),
    wallet: (await q('SELECT balance_idr FROM wallets WHERE user_id = ?1', userId))[0] ?? {
      balance_idr: 0,
    },
    walletLedger: await q(
      'SELECT delta_idr, balance_after, reason, created_at FROM wallet_ledger WHERE user_id = ?1 ORDER BY created_at',
      userId,
    ),
    payments: await q(
      'SELECT method, amount_idr, status, created_at, paid_at FROM payments WHERE user_id = ?1',
      userId,
    ),
    invoices: await q(
      'SELECT number, lines_json, total_idr, issued_at FROM invoices WHERE user_id = ?1',
      userId,
    ),
    files: await q(
      `SELECT id, parent_id, kind, name, size, mime, created_at, updated_at, trashed_at FROM nodes
       WHERE owner_id = ?1 AND space = 'personal' ORDER BY created_at LIMIT 100000`,
      userId,
    ),
    shares: await q(
      'SELECT title, kind, expires_at, download_count, revoked_at, created_at FROM shares WHERE created_by = ?1',
      userId,
    ),
    shareSends: await q(
      'SELECT channel, mode, recipient_masked, status, created_at FROM share_sends WHERE user_id = ?1',
      userId,
    ),
    notifications: await q(
      'SELECT type, payload_json, read_at, created_at FROM notifications WHERE user_id = ?1',
      userId,
    ),
    telegram:
      (
        await q(
          'SELECT username_lower, allow_receive, linked_at FROM telegram_links WHERE user_id = ?1',
          userId,
        )
      )[0] ?? null,
    // Zeiko S3 (ADR-044): the account, key ids (never the secrets) and buckets. Objects are listed
    // through the S3 API itself.
    s3: {
      account:
        (
          await q(
            'SELECT status, billing_state, limit_bytes, used_bytes, created_at FROM s3_accounts WHERE user_id = ?1',
            userId,
          )
        )[0] ?? null,
      keys: await q(
        'SELECT id, label, created_at, last_used_at, revoked_at FROM s3_keys WHERE user_id = ?1',
        userId,
      ),
      buckets: await q(
        'SELECT name, public, created_at FROM s3_buckets WHERE user_id = ?1',
        userId,
      ),
      plan:
        (
          await q(
            'SELECT gb, replicas, period_start, period_end, next_gb, next_replicas FROM s3_subscriptions WHERE user_id = ?1',
            userId,
          )
        )[0] ?? null,
      url:
        (
          await q(
            'SELECT hostname, kind, status, created_at FROM s3_urls WHERE user_id = ?1',
            userId,
          )
        )[0] ?? null,
      egress: await q(
        'SELECT period_start, egress_bytes, billed_blocks FROM s3_usage WHERE user_id = ?1 ORDER BY period_start',
        userId,
      ),
    },
  };
}

export async function requestDeletion(
  ctx: Ctx,
  user: { id: string; email: string },
  confirmEmail: string,
): Promise<{ deleteAt: number }> {
  if (confirmEmail.trim().toLowerCase() !== user.email.toLowerCase())
    throw new AppError('VALIDATION', 'email does not match', { field: 'confirmEmail' });
  const fam = await ctx.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM family_members m JOIN families f ON f.id = m.family_id WHERE f.owner_id = ?1 AND m.user_id != ?1`,
  )
    .bind(user.id)
    .first<{ n: number }>();
  if ((fam?.n ?? 0) > 0)
    throw new AppError('CONFLICT', 'remove family members first', { reason: 'FAMILY_OWNER' });
  const cfg = await ctx.config();
  const now = ctx.now();
  await ctx.env.DB.prepare(
    'UPDATE users SET delete_requested_at = ?2, updated_at = ?2 WHERE id = ?1',
  )
    .bind(user.id, now)
    .run();
  return { deleteAt: now + cfg.account_delete_wait_days * DAY_MS };
}

export async function cancelDeletion(ctx: Ctx, userId: string): Promise<void> {
  await ctx.env.DB.prepare(
    'UPDATE users SET delete_requested_at = NULL, updated_at = ?2 WHERE id = ?1',
  )
    .bind(userId, ctx.now())
    .run();
}

/** Nightly: deletes accounts whose waiting period is over. Content goes, legal-hold blobs stay. */
export async function processAccountDeletions(ctx: Ctx, limit = 20): Promise<number> {
  const cfg = await ctx.config();
  const DB = ctx.env.DB;
  const { results } = await DB.prepare(
    `SELECT id FROM users WHERE delete_requested_at IS NOT NULL AND delete_requested_at <= ?1 AND status != 'deleted' LIMIT ?2`,
  )
    .bind(ctx.now() - cfg.account_delete_wait_days * DAY_MS, limit)
    .all<{ id: string }>();
  const { deleteSubtree } = await import('./nodes');
  for (const { id } of results) {
    const pool = await DB.prepare(
      `SELECT id FROM storage_pools WHERE owner_type = 'user' AND owner_id = ?1`,
    )
      .bind(id)
      .first<{ id: string }>();
    if (pool) {
      const { results: top } = await DB.prepare(
        `SELECT n.id FROM nodes n JOIN nodes p ON p.id = n.parent_id WHERE n.pool_id = ?1 AND p.parent_id IS NULL`,
      )
        .bind(pool.id)
        .all<{ id: string }>();
      for (const n of top) await deleteSubtree(ctx, n.id);
    }
    // Zeiko S3 goes too: keys at once, objects a batch at a time (ADR-044).
    const { purgeS3Account } = await import('./s3-objects');
    if (!(await purgeS3Account(ctx, id)))
      await ctx.env.CLEANUP_QUEUE.send({ type: 's3_purge', userId: id });
    const now = ctx.now();
    await DB.batch([
      DB.prepare(
        `UPDATE subscriptions SET status = 'cancelled', status_changed_at = ?2, updated_at = ?2 WHERE payer_user_id = ?1 AND status != 'cancelled'`,
      ).bind(id, now),
      DB.prepare(
        `UPDATE shares SET revoked_at = ?2 WHERE created_by = ?1 AND revoked_at IS NULL`,
      ).bind(id, now),
      DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(id),
      DB.prepare('DELETE FROM accounts WHERE user_id = ?1').bind(id),
      DB.prepare('DELETE FROM passkeys WHERE user_id = ?1').bind(id),
      DB.prepare('DELETE FROM two_factors WHERE user_id = ?1').bind(id),
      DB.prepare('DELETE FROM telegram_links WHERE user_id = ?1').bind(id),
      DB.prepare('DELETE FROM notifications WHERE user_id = ?1').bind(id),
      DB.prepare(
        `UPDATE users SET email = 'deleted+' || id || '@deleted.invalid', name = '', avatar_url = NULL, ad_city_code = NULL, ad_city = NULL, ad_postal_code = NULL,
           status = 'deleted', updated_at = ?2 WHERE id = ?1`,
      ).bind(id, now),
      DB.prepare(
        `INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?1, ?2, 'account.deleted', 'user', ?2, NULL, ?3)`,
      ).bind(ulid(now), id, now),
    ]);
    log.info('account_deleted', { userId: id });
  }
  return results.length;
}

/** Reminder the day before deletion. */
export async function deletionReminders(ctx: Ctx): Promise<void> {
  const cfg = await ctx.config();
  const wait = cfg.account_delete_wait_days * DAY_MS;
  const { results } = await ctx.env.DB.prepare(
    `SELECT id, delete_requested_at FROM users WHERE delete_requested_at IS NOT NULL AND status != 'deleted'
       AND delete_requested_at <= ?1 AND delete_requested_at > ?2`,
  )
    .bind(ctx.now() - wait + DAY_MS, ctx.now() - wait)
    .all<{ id: string; delete_requested_at: number }>();
  for (const u of results)
    await notify(ctx, u.id, 'account_delete', { deleteAt: u.delete_requested_at + wait });
}
