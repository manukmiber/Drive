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

registerQueueHandler('scan', async (ctx, body) => {
  if (body.type !== 'scan') return;
  await processScan(ctx, body.blobId);
});

registerQueueHandler('cleanup', async (ctx, body) => {
  if (body.type === 'delete_blob') await deleteOrphanBlob(ctx, body.blobId);
  if (body.type === 'purge_pool' && !body.dryRun) await purgePool(ctx, body.poolId);
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
