// Scheduled jobs (SPEC §13.4). Cron expressions are UTC; see CRON in shared/constants.ts.
import { lt } from 'drizzle-orm';
import { CRON } from '../../shared/constants';
import { createCtx, type Ctx } from '../context';
import { schema } from '../db/client';
import type { Env } from '../env';
import { errorMessage, log } from '../lib/log';

export interface CronTask {
  name: string;
  run(ctx: Ctx): Promise<void>;
}

const tasks: Record<string, CronTask[]> = {
  [CRON.dailyAds]: [],
  [CRON.hourly]: [
    {
      name: 'usage_counters_gc',
      async run(ctx) {
        await ctx.db
          .delete(schema.usageCounters)
          .where(lt(schema.usageCounters.expiresAt, ctx.now()));
      },
    },
  ],
  [CRON.nightly]: [],
};

export function registerCronTask(cron: string, task: CronTask): void {
  (tasks[cron] ??= []).push(task);
}

export async function runScheduled(
  cron: string,
  env: Env,
): Promise<{ ran: string[]; failed: string[] }> {
  const ctx = createCtx(env);
  const ran: string[] = [];
  const failed: string[] = [];
  for (const task of tasks[cron] ?? []) {
    try {
      await task.run(ctx);
      ran.push(task.name);
    } catch (e) {
      failed.push(task.name);
      log.error('cron_task_failed', { cron, task: task.name, message: errorMessage(e) });
    }
  }
  log.info('cron_done', { cron, ran: ran.join(','), failed: failed.join(',') });
  return { ran, failed };
}
