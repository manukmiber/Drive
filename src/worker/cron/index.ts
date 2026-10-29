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

const utcHour = (cron: string) => Number(cron.split(' ')[1]);

/** The task lists a trigger stands for: itself, or for CRON.combined whatever is due this hour. */
function due(cron: string, at: number): string[] {
  if (cron !== CRON.combined) return [cron];
  const hour = new Date(at).getUTCHours();
  return [CRON.hourly, CRON.dailyAds, CRON.nightly].filter(
    (c) => c === CRON.hourly || utcHour(c) === hour,
  );
}

export async function runScheduled(
  cron: string,
  env: Env,
  scheduledTime?: number,
): Promise<{ ran: string[]; failed: string[] }> {
  const ctx = createCtx(env);
  const ran: string[] = [];
  const failed: string[] = [];
  for (const task of due(cron, scheduledTime ?? ctx.now()).flatMap((c) => tasks[c] ?? [])) {
    try {
      await task.run(ctx);
      ran.push(task.name);
    } catch (e) {
      failed.push(task.name);
      log.error('cron_task_failed', { cron, task: task.name, message: errorMessage(e) });
    }
  }
  await ctx.drain();
  log.info('cron_done', { cron, ran: ran.join(','), failed: failed.join(',') });
  return { ran, failed };
}
