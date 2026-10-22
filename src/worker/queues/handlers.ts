// Registers queue consumers. Imported once by the Worker entry point.
import { deleteOrphanBlob, processScan } from '../services/scan';
import { registerQueueHandler } from '.';
import { log } from '../lib/log';
import { deliverShareEmail, deliverShareTelegram } from '../services/share-send';
import { purgePool } from '../services/billing';
import { deliverNotification } from '../services/notify';
import { processCompressJob } from '../services/compress';

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
  if (body.type === 'share_telegram') return deliverShareTelegram(ctx, body.sendId, body.chatId);
  if (body.type === 'admin_alert') {
    log.warn('admin_alert', { text: body.text });
    const chat = ctx.env.ADMIN_ALERT_TELEGRAM_CHAT_ID;
    if (chat) await ctx.adapters.telegram.sendMessage(chat, `⚠️ Zeiko: ${body.text}`);
  }
});

registerQueueHandler('compress', async (ctx, body) => {
  if (body.type !== 'compress') return;
  await processCompressJob(ctx, body.jobId);
});
