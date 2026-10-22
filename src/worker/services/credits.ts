// Compress credits (SPEC §11): grants (plan quota for the period, packs with a TTL, refunds) carry a
// `remaining` count; usage takes from the plan quota first, then from the pack that expires soonest.
import type { Ctx } from '../context';
import { ulid } from '../lib/ids';

const LIVE = `user_id = ?1 AND delta > 0 AND remaining > 0 AND (expires_at IS NULL OR expires_at > ?2)`;

export async function creditBalance(ctx: Ctx, userId: string): Promise<number> {
  const r = await ctx.env.DB.prepare(
    `SELECT COALESCE(SUM(remaining), 0) AS n FROM credit_ledger WHERE ${LIVE}`,
  )
    .bind(userId, ctx.now())
    .first<{ n: number }>();
  return r?.n ?? 0;
}

/** Takes `n` credits for `ref` (a job id). All-or-nothing; returns false when not enough. */
export async function consumeCredits(
  ctx: Ctx,
  userId: string,
  n: number,
  ref: string,
): Promise<boolean> {
  const DB = ctx.env.DB;
  const now = ctx.now();
  const taken: Array<{ grant: string; take: number }> = [];
  let left = n;
  for (let guard = 0; left > 0 && guard < 50; guard++) {
    const g = await DB.prepare(
      `SELECT id, remaining FROM credit_ledger WHERE ${LIVE}
       ORDER BY CASE source WHEN 'plan' THEN 0 ELSE 1 END, COALESCE(expires_at, 9e15), created_at LIMIT 1`,
    )
      .bind(userId, now)
      .first<{ id: string; remaining: number }>();
    if (!g) break;
    const take = Math.min(left, g.remaining);
    const res = await DB.prepare(
      'UPDATE credit_ledger SET remaining = remaining - ?2 WHERE id = ?1 AND remaining >= ?2',
    )
      .bind(g.id, take)
      .run();
    if (res.meta.changes !== 1) continue; // raced; pick again
    taken.push({ grant: g.id, take });
    left -= take;
  }
  if (left > 0) {
    for (const t of taken)
      await DB.prepare('UPDATE credit_ledger SET remaining = remaining + ?2 WHERE id = ?1')
        .bind(t.grant, t.take)
        .run();
    return false;
  }
  await DB.batch(
    taken.map((t) =>
      DB.prepare(
        `INSERT INTO credit_ledger (id, user_id, delta, remaining, source, ref, created_at) VALUES (?1, ?2, ?3, 0, 'usage', ?4, ?5)`,
      ).bind(ulid(now), userId, -t.take, `${ref}|${t.grant}`, now),
    ),
  );
  return true;
}

/** Gives back what `ref` took (once). Expired grants are refunded as a fresh 7-day grant. */
export async function refundCredits(ctx: Ctx, userId: string, ref: string): Promise<number> {
  const DB = ctx.env.DB;
  const now = ctx.now();
  const done = await DB.prepare(
    `SELECT 1 AS x FROM credit_ledger WHERE user_id = ?1 AND source = 'refund' AND ref = ?2`,
  )
    .bind(userId, ref)
    .first();
  if (done) return 0;
  const { results } = await DB.prepare(
    `SELECT delta, ref FROM credit_ledger WHERE user_id = ?1 AND source = 'usage' AND ref LIKE ?2`,
  )
    .bind(userId, `${ref}|%`)
    .all<{ delta: number; ref: string }>();
  let total = 0;
  const stmts: D1PreparedStatement[] = [];
  for (const u of results) {
    const grant = u.ref.split('|')[1]!;
    const amount = -u.delta;
    total += amount;
    stmts.push(
      DB.prepare(
        `UPDATE credit_ledger SET remaining = remaining + ?2 WHERE id = ?1 AND (expires_at IS NULL OR expires_at > ?3)`,
      ).bind(grant, amount, now),
    );
  }
  if (!total) return 0;
  // One audit row for the refund; if a grant had expired its credits come back as a new grant.
  const expired = await DB.prepare(
    `SELECT COALESCE(SUM(-u.delta), 0) AS n FROM credit_ledger u JOIN credit_ledger g ON g.id = substr(u.ref, instr(u.ref, '|') + 1)
     WHERE u.user_id = ?1 AND u.source = 'usage' AND u.ref LIKE ?2 AND g.expires_at IS NOT NULL AND g.expires_at <= ?3`,
  )
    .bind(userId, `${ref}|%`, now)
    .first<{ n: number }>();
  stmts.push(
    DB.prepare(
      `INSERT INTO credit_ledger (id, user_id, delta, remaining, source, ref, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, 'refund', ?5, ?6, ?7)`,
    ).bind(ulid(now), userId, total, expired?.n ?? 0, ref, now + 7 * 86_400_000, now),
  );
  await DB.batch(stmts);
  return total;
}
