// Registers cron tasks (SPEC §13.4). Imported once by the Worker entry point.
import { CRON, HOUR_MS } from '../../shared/constants';
import { log } from '../lib/log';
import {
  expireStalePayments,
  renewDueSubscriptions,
  runDunning,
  sendRenewalReminders,
} from '../services/billing';
import { purgeExpiredTrash } from '../services/nodes';
import { reconcilePools } from '../services/quota';
import { expireUploads } from '../services/uploads';
import { registerCronTask } from '.';

registerCronTask(CRON.hourly, {
  name: 'expire_uploads',
  run: async (ctx) => void (await expireUploads(ctx)),
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
