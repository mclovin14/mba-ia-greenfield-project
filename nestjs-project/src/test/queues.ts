import { getQueueToken } from '@nestjs/bullmq';
import type { TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { VIDEO_PROCESSING_QUEUE } from '../video-processing/video-processing.constants';

/**
 * Closing a module whose BullMQ queue is still connecting makes the Redis
 * connection reject with "Connection is closed" after the test ends; nothing
 * listens to the queue's `error` event, so the error surfaces as an unhandled
 * error in whichever suite runs next. Specs that only compile (never `init()`)
 * a module with the queue must wait for it before `module.close()`.
 */
export async function waitForVideoProcessingQueue(
  module: TestingModule,
): Promise<void> {
  await module
    .get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE))
    .waitUntilReady();
}
