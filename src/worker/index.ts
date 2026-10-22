import { createApp } from './app';
import './cron/tasks';
import './queues/handlers';
import { runScheduled } from './cron';
import type { Env } from './env';
import { handleQueue } from './queues';
import type { QueueMessage } from './queues/messages';

const app = createApp();

export default {
  fetch: (req, env, ctx) => app.fetch(req, env, ctx),
  queue: (batch, env) => handleQueue(batch, env),
  scheduled: (controller, env, ctx) => {
    ctx.waitUntil(runScheduled(controller.cron, env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env, QueueMessage>;
