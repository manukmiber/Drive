// Registers queue consumers. Imported once by the Worker entry point.
import { deleteOrphanBlob, processScan } from '../services/scan';
import { registerQueueHandler } from '.';
import { log } from '../lib/log';
import { OPERATOR_EMAIL } from '../../shared/constants';
import { deliverShareEmail } from '../services/share-send';
import { purgePool } from '../services/billing';
import { deliverNotification } from '../services/notify';
import { processCompressJob } from '../services/compress';
import { processArchiveJob } from '../services/archives';
import { processS3Scan, purgeS3Account } from '../services/s3-objects';
import { replicateAccount, unreplicateAccount } from '../services/s3-replicas';

registerQueueHandler('scan', async (ctx, body, attempts) => {
  if (body.type === 'scan') await processScan(ctx, body.blobId, body.vt);
  if (body.type === 's3_scan') await processS3Scan(ctx, body, attempts);
});

registerQueueHandler('cleanup', async (ctx, body) => {
  if (body.type === 'delete_blob') await deleteOrphanBlob(ctx, body.blobId);
  if (body.type === 'purge_pool' && !body.dryRun) await purgePool(ctx, body.poolId);
  if (body.type === 's3_purge' && !(await purgeS3Account(ctx, body.userId)))
    await ctx.env.CLEANUP_QUEUE.send({ type: 's3_purge', userId: body.userId });
  if (body.type === 's3_replicate' && !(await replicateAccount(ctx, body.userId)))
    await ctx.env.CLEANUP_QUEUE.send({ type: 's3_replicate', userId: body.userId });
  if (body.type === 's3_unreplicate' && !(await unreplicateAccount(ctx, body.userId)))
    await ctx.env.CLEANUP_QUEUE.send({ type: 's3_unreplicate', userId: body.userId });
});

registerQueueHandler('notify', async (ctx, body) => {
  if (body.type === 'notification') return deliverNotification(ctx, body.notificationId);
  if (body.type === 'share_email') return deliverShareEmail(ctx, body.sendId, body.to);
  if (body.type === 'admin_alert') {
    // By email, like every other notice (ADR-041).
    log.warn('admin_alert', { text: body.text });
    await ctx.adapters.email.send({
      to: [OPERATOR_EMAIL],
      subject: `Zeiko Drive: ${body.text.slice(0, 80)}`,
      text: body.text,
      tag: 'admin_alert',
    });
  }
});

registerQueueHandler('compress', async (ctx, body) => {
  if (body.type !== 'compress') return;
  await processCompressJob(ctx, body.jobId);
});

registerQueueHandler('archive', async (ctx, body) => {
  if (body.type !== 'archive') return;
  await processArchiveJob(ctx, body.jobId);
});
