import type { Job } from 'bullmq';

/**
 * True while the current attempt is the last one BullMQ will run.
 * `attemptsMade` counts only the attempts that already finished.
 */
export function isFinalAttempt(
  job: Pick<Job, 'attemptsMade' | 'opts'>,
): boolean {
  return job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
}
