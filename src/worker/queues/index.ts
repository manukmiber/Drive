// Queue consumer entry point. One Worker consumes all five queues; dispatch by queue name
// (names carry an env suffix, e.g. "zeiko-scan-staging").
import { QUEUE_NAMES, type QueueName } from '../../shared/constants';
import { createCtx, type Ctx } from '../context';
import type { Env } from '../env';
import { errorMessage, log } from '../lib/log';
import type { QueueMessage } from './messages';

export type QueueHandler = (ctx: Ctx, body: QueueMessage, attempts: number) => Promise<void>;

const handlers: Partial<Record<QueueName, QueueHandler>> = {};

export function registerQueueHandler(name: QueueName, handler: QueueHandler): void {
  handlers[name] = handler;
}

export function queueKind(queue: string): QueueName | null {
  for (const name of QUEUE_NAMES) {
    if (new RegExp(`(^|-)${name}(-|$)`).test(queue)) return name;
  }
  return null;
}

/** Exponential backoff for retried messages: 10 s, 40 s, 160 s, … capped at 1 h. */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(3600, 10 * 4 ** Math.max(0, attempts - 1));
}

export async function handleQueue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
  const kind = queueKind(batch.queue);
  const handler = kind ? handlers[kind] : undefined;
  const ctx = createCtx(env);
  for (const msg of batch.messages) {
    if (!handler) {
      log.warn('queue_no_handler', { queue: batch.queue });
      msg.ack();
      continue;
    }
    try {
      await handler(ctx, msg.body, msg.attempts);
      msg.ack();
    } catch (e) {
      log.error('queue_message_failed', {
        queue: batch.queue,
        attempts: msg.attempts,
        message: errorMessage(e),
      });
      msg.retry({ delaySeconds: retryDelaySeconds(msg.attempts) });
    }
  }
}
