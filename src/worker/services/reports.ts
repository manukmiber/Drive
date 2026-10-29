// Abuse reports & takedown (SPEC §13.1, §14.3). SLA per Permenkominfo 5/2020: urgent 4 h, normal
// 24 h (config). A CSAM report from someone accountable (signed in, or past Turnstile) acts at once
// on the content: links off, quarantine + legal hold. Freezing the uploader's account is the
// operator's call, never automatic: a report is only a claim (ADR-056). Rejecting a report undoes
// what it switched off. The operator works from the relay's Zeiko Drive screen (ops API, ADR-057).
import type { Ctx } from '../context';
import { markBlobOwnersDirty } from './drive-index-sync';
import { AppError } from '../lib/errors';
import { ulid } from '../lib/ids';
import { disableSharesForNode } from './shares';

export const REPORT_CATEGORIES = [
  'csam',
  'terrorism',
  'violence',
  'malware',
  'phishing',
  'copyright',
  'privacy',
  'spam',
  'other',
] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];
const URGENT: ReportCategory[] = ['csam', 'terrorism', 'violence'];

export const REPORT_ACTIONS = [
  'disable_links',
  'quarantine',
  'unquarantine',
  'legal_hold',
  'delete',
  'ban_uploader',
  'blocklist',
  'resolve',
  'reject',
] as const;
export type ReportAction = (typeof REPORT_ACTIONS)[number];

interface Target {
  nodeIds: string[];
  blobIds: string[];
  uploaderIds: string[];
}

/** Resolves a report target (share r64, node id, or blob id) to the affected rows. */
async function resolveTarget(ctx: Ctx, type: string, id: string): Promise<Target> {
  const DB = ctx.env.DB;
  let nodeIds: string[] = [];
  if (type === 'share') {
    const { results } = await DB.prepare('SELECT node_id FROM share_items WHERE share_id = ?1')
      .bind(id)
      .all<{ node_id: string }>();
    // Folder shares: everything inside counts.
    for (const r of results) {
      const { results: sub } = await DB.prepare(
        `WITH RECURSIVE t(id) AS (SELECT ?1 UNION ALL SELECT n.id FROM nodes n JOIN t ON n.parent_id = t.id) SELECT id FROM t LIMIT 5000`,
      )
        .bind(r.node_id)
        .all<{ id: string }>();
      nodeIds.push(...sub.map((x) => x.id));
    }
  } else if (type === 'node') nodeIds = [id];
  else if (type === 'blob') {
    const { results } = await DB.prepare('SELECT id FROM nodes WHERE blob_id = ?1')
      .bind(id)
      .all<{ id: string }>();
    nodeIds = results.map((r) => r.id);
  }
  const blobIds = new Set<string>(type === 'blob' ? [id] : []);
  const uploaderIds = new Set<string>();
  for (let i = 0; i < nodeIds.length; i += 90) {
    const chunk = nodeIds.slice(i, i + 90);
    const { results } = await DB.prepare(
      `SELECT n.blob_id, n.created_by FROM nodes n WHERE n.id IN (${chunk.map((_, j) => `?${j + 1}`).join(', ')})`,
    )
      .bind(...chunk)
      .all<{ blob_id: string | null; created_by: string }>();
    for (const r of results) {
      if (r.blob_id) blobIds.add(r.blob_id);
      uploaderIds.add(r.created_by);
    }
  }
  return { nodeIds, blobIds: [...blobIds], uploaderIds: [...uploaderIds] };
}

async function audit(
  ctx: Ctx,
  actorId: string | null,
  action: string,
  targetType: string,
  targetId: string,
  meta: unknown,
): Promise<void> {
  await ctx.env.DB.prepare(
    `INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(
      ulid(ctx.now()),
      actorId,
      action,
      targetType,
      targetId,
      JSON.stringify(meta ?? null),
      ctx.now(),
    )
    .run();
}

export async function createReport(
  ctx: Ctx,
  input: {
    targetType: 'share' | 'node' | 'ad';
    targetId: string;
    category: ReportCategory;
    details?: string | undefined;
    contact?: string | undefined;
    reporterUserId?: string | null;
    /** Signed in, or a human by Turnstile: only then does a CSAM report act before review. */
    accountable?: boolean;
  },
): Promise<{ id: string; priority: string; slaDueAt: number }> {
  const cfg = await ctx.config();
  const table = { share: 'shares', node: 'nodes', ad: 'ad_creatives' }[input.targetType];
  const exists = await ctx.env.DB.prepare(`SELECT 1 AS x FROM ${table} WHERE id = ?1`)
    .bind(input.targetId)
    .first();
  if (!exists) throw new AppError('NOT_FOUND', 'reported item not found');
  const urgent = URGENT.includes(input.category);
  const now = ctx.now();
  const id = ulid(now);
  const slaDueAt =
    now + (urgent ? cfg.takedown_sla_hours.urgent : cfg.takedown_sla_hours.normal) * 3600_000;
  await ctx.env.DB.prepare(
    `INSERT INTO abuse_reports (id, target_type, target_id, category, priority, reporter_user_id, reporter_contact, details, status, sla_due_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'open', ?9, ?10)`,
  )
    .bind(
      id,
      input.targetType,
      input.targetId,
      input.category,
      urgent ? 'urgent' : 'normal',
      input.reporterUserId ?? null,
      input.contact?.slice(0, 200) ?? null,
      input.details?.slice(0, 2000) ?? null,
      slaDueAt,
      now,
    )
    .run();
  if (input.category === 'csam' && input.targetType !== 'ad' && input.accountable) {
    // The content goes dark before anyone looks (SPEC §14.3); the account waits for a moderator.
    await applyActions(
      ctx,
      null,
      id,
      ['disable_links', 'quarantine', 'legal_hold'],
      'auto: laporan CSAM',
    );
  }
  await ctx.env.NOTIFY_QUEUE.send({
    type: 'admin_alert',
    text: `Laporan ${urgent ? 'MENDESAK ' : ''}${input.category} masuk (${input.targetType} ${input.targetId.slice(0, 12)}…), SLA ${urgent ? cfg.takedown_sla_hours.urgent : cfg.takedown_sla_hours.normal} jam.`,
  });
  return { id, priority: urgent ? 'urgent' : 'normal', slaDueAt };
}

export async function applyActions(
  ctx: Ctx,
  actorId: string | null,
  reportId: string,
  actions: ReportAction[],
  note: string,
): Promise<void> {
  const DB = ctx.env.DB;
  const report = await DB.prepare('SELECT * FROM abuse_reports WHERE id = ?1')
    .bind(reportId)
    .first<{
      id: string;
      target_type: string;
      target_id: string;
      category: string;
      status: string;
    }>();
  if (!report) throw new AppError('NOT_FOUND', 'report not found');
  const target = await resolveTarget(ctx, report.target_type, report.target_id);
  const now = ctx.now();
  // Marks carry the report, so rejecting it undoes exactly what it switched off.
  const mark = `abuse:${reportId}`;
  for (const action of actions) {
    switch (action) {
      case 'disable_links':
        if (report.target_type === 'share')
          await DB.prepare(`UPDATE shares SET disabled_reason = ?2 WHERE id = ?1`)
            .bind(report.target_id, mark)
            .run();
        for (const n of target.nodeIds.slice(0, 500)) await disableSharesForNode(ctx, n, mark);
        break;
      case 'quarantine':
        for (const b of target.blobIds)
          await DB.prepare(
            `UPDATE blobs SET scan_status = 'quarantined', scan_detail = ?2 WHERE id = ?1`,
          )
            .bind(b, mark)
            .run();
        await markBlobOwnersDirty(ctx, target.blobIds);
        break;
      case 'unquarantine':
        for (const b of target.blobIds) {
          await DB.prepare(
            `UPDATE blobs SET scan_status = 'clean', scan_detail = NULL WHERE id = ?1 AND scan_status = 'quarantined'`,
          )
            .bind(b)
            .run();
        }
        await markBlobOwnersDirty(ctx, target.blobIds);
        break;
      case 'legal_hold':
        for (const b of target.blobIds) {
          await DB.prepare(
            `INSERT INTO legal_holds (blob_id, reason, created_by, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT DO NOTHING`,
          )
            .bind(b, `report:${reportId}`, actorId ?? 'auto', now)
            .run();
        }
        break;
      case 'delete': {
        const held = await DB.prepare(
          `SELECT COUNT(*) AS n FROM legal_holds WHERE blob_id IN (${target.blobIds.map((_, i) => `?${i + 1}`).join(', ') || "''"})`,
        )
          .bind(...target.blobIds)
          .first<{ n: number }>();
        if ((held?.n ?? 0) > 0)
          throw new AppError('CONFLICT', 'content is under legal hold', { reason: 'LEGAL_HOLD' });
        const { deleteSubtree } = await import('./nodes');
        for (const n of target.nodeIds) {
          const node = await DB.prepare('SELECT id, parent_id FROM nodes WHERE id = ?1')
            .bind(n)
            .first<{ id: string; parent_id: string | null }>();
          if (node?.parent_id) await deleteSubtree(ctx, node.id);
        }
        break;
      }
      case 'ban_uploader':
        for (const u of target.uploaderIds) await setUserStatus(ctx, u, 'suspended');
        break;
      case 'blocklist':
        for (const b of target.blobIds) {
          await DB.prepare(
            `INSERT INTO blocked_hashes (sha256, reason, created_by, created_at) SELECT sha256, ?2, ?3, ?4 FROM blobs WHERE id = ?1 AND sha256 IS NOT NULL ON CONFLICT DO NOTHING`,
          )
            .bind(b, `report:${reportId}`, actorId, now)
            .run();
        }
        break;
      case 'resolve':
      case 'reject': {
        const close = DB.prepare(
          // resolved_by names a Drive user; the operator is not one, so who acted is the audit row.
          `UPDATE abuse_reports SET status = ?2, resolved_at = ?3, action = ?4 WHERE id = ?1`,
        ).bind(reportId, action === 'resolve' ? 'resolved' : 'rejected', now, note.slice(0, 500));
        if (action === 'resolve') await close.run();
        // A rejected report was wrong: put back what it switched off (only its own marks).
        else
          await DB.batch([
            close,
            DB.prepare(`UPDATE shares SET disabled_reason = NULL WHERE disabled_reason = ?1`).bind(
              mark,
            ),
            DB.prepare(
              `UPDATE blobs SET scan_status = 'clean', scan_detail = NULL WHERE scan_detail = ?1 AND scan_status = 'quarantined'`,
            ).bind(mark),
            DB.prepare(`DELETE FROM legal_holds WHERE reason = ?1`).bind(`report:${reportId}`),
          ]);
        if (action !== 'resolve') await markBlobOwnersDirty(ctx, target.blobIds);
        break;
      }
    }
  }
  if (report.status === 'open' && !actions.includes('resolve') && !actions.includes('reject')) {
    await DB.prepare(
      `UPDATE abuse_reports SET status = 'in_review' WHERE id = ?1 AND status = 'open'`,
    )
      .bind(reportId)
      .run();
  }
  await audit(ctx, actorId, 'report.action', 'report', reportId, {
    actions,
    note,
    nodes: target.nodeIds.length,
    blobs: target.blobIds.length,
  });
}

export async function setUserStatus(
  ctx: Ctx,
  userId: string,
  status: 'active' | 'suspended',
): Promise<void> {
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('UPDATE users SET status = ?2, updated_at = ?3 WHERE id = ?1').bind(
      userId,
      status,
      ctx.now(),
    ),
    // Suspension signs the user out everywhere.
    ...(status === 'suspended'
      ? [ctx.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(userId)]
      : []),
  ]);
}

export async function listReports(ctx: Ctx, status: string) {
  const { results } = await ctx.env.DB.prepare(
    `SELECT id, target_type AS targetType, target_id AS targetId, category, priority, details, reporter_contact AS reporterContact,
            status, sla_due_at AS slaDueAt, resolved_at AS resolvedAt, action, created_at AS createdAt
     FROM abuse_reports WHERE (?1 = 'all' OR status = ?1 OR (?1 = 'active' AND status IN ('open', 'in_review')))
     ORDER BY CASE priority WHEN 'urgent' THEN 0 ELSE 1 END, sla_due_at LIMIT 200`,
  )
    .bind(status)
    .all();
  return results;
}

export async function reportDetail(ctx: Ctx, id: string) {
  const r = await ctx.env.DB.prepare('SELECT * FROM abuse_reports WHERE id = ?1')
    .bind(id)
    .first<{ target_type: string; target_id: string }>();
  if (!r) throw new AppError('NOT_FOUND', 'report not found');
  const target = await resolveTarget(ctx, r.target_type, r.target_id);
  const { results: files } = target.nodeIds.length
    ? await ctx.env.DB.prepare(
        `SELECT n.id, n.name, n.kind, n.size, n.mime, n.created_by AS createdBy, b.scan_status AS scanStatus, b.sha256,
                (SELECT 1 FROM legal_holds h WHERE h.blob_id = n.blob_id) AS held
         FROM nodes n LEFT JOIN blobs b ON b.id = n.blob_id WHERE n.id IN (${target.nodeIds
           .slice(0, 90)
           .map((_, i) => `?${i + 1}`)
           .join(', ')})`,
      )
        .bind(...target.nodeIds.slice(0, 90))
        .all()
    : { results: [] };
  return { report: r, files, uploaders: target.uploaderIds };
}

/**
 * Content review for a reported file: a short-lived preview URL, always written to the audit log
 * (SPEC §13.1 — there is no general "view user files" button).
 */
export async function reviewPreview(
  ctx: Ctx,
  actorId: string,
  reportId: string,
  nodeId: string,
): Promise<{ url: string }> {
  const { files } = await reportDetail(ctx, reportId);
  const f = (files as Array<{ id: string; kind: string }>).find(
    (x) => x.id === nodeId && x.kind === 'file',
  );
  if (!f) throw new AppError('NOT_FOUND', 'file is not part of this report');
  const node = await ctx.env.DB.prepare('SELECT id, name, blob_id FROM nodes WHERE id = ?1')
    .bind(nodeId)
    .first<{ id: string; name: string; blob_id: string }>();
  const { createDownloadToken } = await import('./download');
  const exp = ctx.now() + 5 * 60_000;
  // The reviewer is the relay's operator, not a Drive user (ADR-057): a review token carries the
  // report where other tokens carry the user, and opens only while that report exists.
  const token = await createDownloadToken(
    ctx.env.PREVIEW_SECRET,
    { blobId: node!.blob_id, nodeId, userId: reportId, exp },
    'a',
  );
  await audit(ctx, actorId, 'report.content_view', 'node', nodeId, { reportId });
  return {
    url: `${new URL(ctx.env.USERCONTENT_ORIGIN).origin}/p/${token}/${encodeURIComponent(node!.name)}`,
  };
}
