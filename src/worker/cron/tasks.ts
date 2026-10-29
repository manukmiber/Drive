// Registers cron tasks (SPEC §13.4). Imported once by the Worker entry point.
import { CRON, DAY_MS, HOUR_MS } from '../../shared/constants';
import { log } from '../lib/log';
import {
  expireStalePayments,
  reconcilePayments,
  renewDueSubscriptions,
  runDunning,
  sendRenewalReminders,
} from '../services/billing';
import { purgeExpiredTrash } from '../services/nodes';
import { flushDirtyIndexes } from '../services/drive-index-sync';
import { deletionReminders, processAccountDeletions } from '../services/account';
import { reconcilePools } from '../services/quota';
import { expireUploads } from '../services/uploads';
import { purgeStandalone } from '../services/compress';
import { expireArchives } from '../services/archives';
import { runAdsDaily } from '../services/ads';
import { expireS3Uploads, reconcileS3 } from '../services/s3-objects';
import { remindS3Renewals, renewS3FromCredit, runS3Dunning } from '../services/s3-billing';
import { sweepReplication } from '../services/s3-replicas';
import { deliverS3Logs } from '../services/s3-stats';
import { runS3Lifecycle } from '../services/s3-lifecycle';
import { refreshPendingUrls, releaseLapsedUrls } from '../services/s3-urls';
import { cleanupVirusTotal } from '../services/virustotal';
import { moveNoticesToRelay } from '../services/notify';
import { registerCronTask } from '.';

// Drive indexes a request didn't finish writing (R3, ADR-074).
registerCronTask(CRON.hourly, {
  name: 'drive_index_flush',
  async run(ctx) {
    const r = await flushDirtyIndexes(ctx);
    if (r.written || r.failed) log.info('drive_index_flush', r);
  },
});

registerCronTask(CRON.hourly, {
  name: 'expire_uploads',
  run: async (ctx) => void (await expireUploads(ctx)),
});

// Zeiko S3 multipart uploads nobody finished (ADR-044).
registerCronTask(CRON.hourly, {
  name: 's3_expire_uploads',
  run: async (ctx) => void (await expireS3Uploads(ctx)),
});

// Bucket lifecycle rules (ADR-072): expired objects and forgotten uploads, a few buckets an hour.
registerCronTask(CRON.hourly, {
  name: 's3_lifecycle',
  async run(ctx) {
    const r = await runS3Lifecycle(ctx);
    if (r.deleted || r.aborted) log.info('s3_lifecycle', r);
  },
});

// Bucket access logs (ADR-060): waiting lines become log objects in their target buckets.
registerCronTask(CRON.hourly, {
  name: 's3_deliver_logs',
  run: async (ctx) => void (await deliverS3Logs(ctx)),
});

registerCronTask(CRON.nightly, {
  name: 's3_reconcile',
  run: async (ctx) => void (await reconcileS3(ctx)),
});

// Zeiko S3 plans (ADR-047): one that just ran out renews itself from credit.
// Own domains waiting for their CNAME (ADR-048).
registerCronTask(CRON.hourly, {
  name: 's3_url_refresh',
  run: async (ctx) => void (await refreshPendingUrls(ctx)),
});

registerCronTask(CRON.hourly, {
  name: 's3_renew_from_credit',
  async run(ctx) {
    const renewed = await renewS3FromCredit(ctx);
    if (renewed) log.info('s3_renewed_from_credit', { renewed });
  },
});

// 02:00 WIB: renewal reminders, plans not renewed along the dunning cycle, missed copies.
registerCronTask(CRON.nightly, {
  name: 's3_billing',
  async run(ctx) {
    await remindS3Renewals(ctx);
    const r = await runS3Dunning(ctx);
    if (r.dryRun.length) {
      await ctx.env.NOTIFY_QUEUE.send({
        type: 'admin_alert',
        text: `Dry-run hapus Zeiko S3 yang tidak diperpanjang: ${r.dryRun.length} akun. Ubah dunning_delete_mode ke "live" untuk benar-benar menghapus.`,
      });
    }
    await sweepReplication(ctx);
    await releaseLapsedUrls(ctx);
  },
});

registerCronTask(CRON.nightly, {
  name: 'virustotal_cleanup',
  run: async (ctx) => void (await cleanupVirusTotal(ctx)),
});

registerCronTask(CRON.hourly, {
  name: 'purge_standalone_compress',
  run: async (ctx) => void (await purgeStandalone(ctx)),
});

registerCronTask(CRON.hourly, {
  name: 'expire_archives',
  run: async (ctx) => void (await expireArchives(ctx)),
});

// 00:05 WIB: paid campaigns start, finished ones complete, unpaid ones expire (ADR-043).
registerCronTask(CRON.dailyAds, {
  name: 'ads_daily',
  run: async (ctx) => void (await runAdsDaily(ctx)),
});

// Log/PII retention (SPEC §14.5, `log_retention_days`). Audit logs are kept (moderation/legal, ADR-034).
registerCronTask(CRON.nightly, {
  name: 'purge_old_logs',
  async run(ctx) {
    const cfg = await ctx.config();
    const cutoff = ctx.now() - cfg.log_retention_days * DAY_MS;
    const DB = ctx.env.DB;
    await DB.batch([
      DB.prepare('DELETE FROM share_sends WHERE created_at < ?1').bind(cutoff),
      DB.prepare('DELETE FROM notifications WHERE created_at < ?1 AND read_at IS NOT NULL').bind(
        cutoff,
      ),
      DB.prepare('DELETE FROM usage_counters WHERE expires_at < ?1').bind(ctx.now()),
      // Better Auth judges expiry by the system clock, so expired rows are judged the same way.
      DB.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(Date.now()),
      DB.prepare('DELETE FROM verifications WHERE expires_at < ?1').bind(Date.now()),
      DB.prepare(
        `DELETE FROM compress_jobs WHERE updated_at < ?1 AND status IN ('done', 'failed', 'skipped') AND source_key IS NULL AND out_key IS NULL`,
      ).bind(cutoff),
      DB.prepare(`DELETE FROM archive_jobs WHERE updated_at < ?1 AND out_key IS NULL`).bind(cutoff),
      // Idempotency-Key answers are kept a day (ADR-062).
      DB.prepare('DELETE FROM api_idempotency WHERE created_at < ?1').bind(ctx.now() - DAY_MS),
      // OAuth codes live a minute (ADR-063); the rows go after a day.
      DB.prepare('DELETE FROM oauth_codes WHERE expires_at < ?1').bind(ctx.now() - DAY_MS),
    ]);
  },
});

registerCronTask(CRON.nightly, {
  name: 'purge_trash',
  run: async (ctx) => void (await purgeExpiredTrash(ctx)),
});

registerCronTask(CRON.nightly, {
  name: 'orphan_blobs',
  async run(ctx) {
    const { results } = await ctx.env.DB.prepare(
      `SELECT id FROM blobs WHERE refcount = 0 AND created_at < ?1 LIMIT 500`,
    )
      .bind(ctx.now() - HOUR_MS)
      .all<{ id: string }>();
    for (const r of results)
      await ctx.env.CLEANUP_QUEUE.send({ type: 'delete_blob', blobId: r.id });
  },
});

registerCronTask(CRON.nightly, {
  name: 'reconcile_quota',
  async run(ctx) {
    const drift = await reconcilePools(ctx);
    if (drift.length) {
      log.warn('quota_drift', { pools: drift.length });
      await ctx.env.NOTIFY_QUEUE.send({
        type: 'admin_alert',
        text: `Selisih kuota di ${drift.length} pool: ${drift
          .slice(0, 5)
          .map((d) => `${d.poolId} used ${d.usedDrift} reserved ${d.reservedDrift}`)
          .join('; ')}`,
      });
    }
  },
});

// ── Billing (SPEC §12.4–12.5) ──
registerCronTask(CRON.hourly, {
  name: 'renew_subscriptions',
  async run(ctx) {
    const r = await renewDueSubscriptions(ctx);
    if (r.renewed || r.failed) log.info('renewals', r);
  },
});

registerCronTask(CRON.hourly, {
  name: 'reconcile_payments',
  async run(ctx) {
    const n = await reconcilePayments(ctx);
    if (n) log.info('payments_reconciled', { n });
  },
});

registerCronTask(CRON.hourly, {
  name: 'expire_payments',
  run: async (ctx) => void (await expireStalePayments(ctx)),
});

registerCronTask(CRON.nightly, {
  name: 'dunning',
  async run(ctx) {
    const r = await runDunning(ctx);
    if (r.dryRun.length) {
      await ctx.env.NOTIFY_QUEUE.send({
        type: 'admin_alert',
        text: `Dry-run hapus akun menunggak: ${r.dryRun.length} pool (${r.dryRun.reduce((s, x) => s + x.files, 0)} file). Ubah dunning_delete_mode ke "live" untuk benar-benar menghapus.`,
      });
    }
  },
});

registerCronTask(CRON.nightly, {
  name: 'renewal_reminders',
  run: async (ctx) => void (await sendRenewalReminders(ctx)),
});

// ── Account deletion (UU PDP, SPEC §14.5) ──
registerCronTask(CRON.nightly, {
  name: 'account_deletions',
  async run(ctx) {
    await deletionReminders(ctx);
    await processAccountDeletions(ctx);
  },
});

// ADR-064: notices live on the relay. Old D1 rows move over a few batches an hour (a relay that is
// not answering just means next hour), and read notices past retention are pruned there.
registerCronTask(CRON.hourly, {
  name: 'move_notices_to_relay',
  async run(ctx) {
    for (let i = 0; i < 3; i++) if (!(await moveNoticesToRelay(ctx))) break;
  },
});

registerCronTask(CRON.nightly, {
  name: 'prune_notices',
  async run(ctx) {
    const cfg = await ctx.config();
    await ctx.adapters.notices.prune(ctx.now() - cfg.log_retention_days * DAY_MS);
  },
});
