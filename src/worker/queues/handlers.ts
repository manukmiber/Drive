// Registers queue consumers. Imported once by the Worker entry point.
import { deleteOrphanBlob, processScan } from '../services/scan';
import { registerQueueHandler } from '.';
import { log } from '../lib/log';

registerQueueHandler('scan', async (ctx, body) => {
  if (body.type !== 'scan') return;
  await processScan(ctx, body.blobId);
});

registerQueueHandler('cleanup', async (ctx, body) => {
  if (body.type === 'delete_blob') await deleteOrphanBlob(ctx, body.blobId);
});

registerQueueHandler('notify', async (_ctx, body) => {
  // Email/Telegram delivery lands in Fase 5; admin alerts are logged until then.
  if (body.type === 'admin_alert') log.warn('admin_alert', { text: body.text });
});
