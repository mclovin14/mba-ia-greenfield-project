import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import queueConfig from '../config/queue.config';
import { QueueModule } from '../queue/queue.module';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';
import { VideoProcessingQueueModule } from './video-processing-queue.module';
import { VideoProcessingQueue } from './video-processing.queue';
import type { ProcessVideoJobData } from './video-processing.types';

describe('VideoProcessingQueue × Redis', () => {
  let module: TestingModule;
  let producer: VideoProcessingQueue;
  let queue: Queue<ProcessVideoJobData>;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    // Unique prefix: a running video-worker (prefix "bull") never sees these jobs.
    process.env.QUEUE_PREFIX = `test-${randomUUID()}`;
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
        VideoProcessingQueueModule,
      ],
    }).compile();
    await module.init();

    producer = module.get(VideoProcessingQueue);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterEach(async () => {
    await queue.drain(true);
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await module.close();
    process.env = originalEnv;
  });

  it('should enqueue a process-video job with the videoId payload and a deterministic id', async () => {
    const videoId = randomUUID();

    await producer.enqueue(videoId);

    const job = await queue.getJob(`video-${videoId}`);
    expect(job).toBeDefined();
    expect(job!.name).toBe(PROCESS_VIDEO_JOB);
    expect(job!.data).toEqual({ videoId });
    expect(job!.opts).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86400 },
    });
  });

  it('should keep exactly one job when the same videoId is enqueued twice', async () => {
    const videoId = randomUUID();

    await producer.enqueue(videoId);
    await producer.enqueue(videoId);

    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs.filter((j) => j.data.videoId === videoId)).toHaveLength(1);
  });

  it('should register no worker on the queue (producer only)', async () => {
    await expect(queue.getWorkersCount()).resolves.toBe(0);
  });
});
