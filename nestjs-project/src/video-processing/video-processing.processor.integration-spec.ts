import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Job, Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { FfmpegService } from '../media/ffmpeg.service';
import { QueueModule } from '../queue/queue.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { emptyBucket } from '../test/presigned-request';
import {
  seedProcessingVideo,
  uploadOriginal,
} from '../test/processing-fixtures';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
  videoProcessingJobId,
} from './video-processing.constants';
import { VideoProcessingWorkerModule } from './video-processing-worker.module';
import type { ProcessVideoJobData } from './video-processing.types';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const VIDEOS_BUCKET = 'it-processor-videos';
const THUMBNAILS_BUCKET = 'it-processor-thumbnails';
const SETTLE_TIMEOUT_MS = 20_000;

describe('VideoProcessingProcessor × Redis (real BullMQ worker)', () => {
  let module: TestingModule;
  let queue: Queue<ProcessVideoJobData>;
  let dataSource: DataSource;
  let storage: StorageService;
  let ffmpeg: FfmpegService;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    process.env.S3_VIDEOS_BUCKET = VIDEOS_BUCKET;
    process.env.S3_THUMBNAILS_BUCKET = THUMBNAILS_BUCKET;
    // Unique prefix: only this suite's worker sees these jobs.
    process.env.QUEUE_PREFIX = `test-${randomUUID()}`;
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        QueueModule,
        VideoProcessingWorkerModule,
      ],
    }).compile();
    await module.init();
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    dataSource = module.get(DataSource);
    storage = module.get(StorageService);
    ffmpeg = module.get(FfmpegService);
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await emptyBucket(VIDEOS_BUCKET);
    await emptyBucket(THUMBNAILS_BUCKET);
    await module.close();
    process.env = originalEnv;
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await emptyBucket(VIDEOS_BUCKET);
    await emptyBucket(THUMBNAILS_BUCKET);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** Enqueues with the production options (attempts 3, exponential backoff). */
  const enqueue = (videoId: string) =>
    queue.add(
      PROCESS_VIDEO_JOB,
      { videoId },
      { ...VIDEO_PROCESSING_JOB_OPTIONS, jobId: videoProcessingJobId(videoId) },
    );

  const waitForFailed = async (
    job: Job<ProcessVideoJobData>,
  ): Promise<Job<ProcessVideoJobData>> => {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if ((await job.getState()) === 'failed') {
        return (await queue.getJob(job.id!))!;
      }
      await sleep(100);
    }
    throw new Error(
      `job ${job.id} did not fail within ${SETTLE_TIMEOUT_MS} ms`,
    );
  };

  const findVideo = (id: string): Promise<Video> =>
    dataSource.getRepository(Video).findOneByOrFail({ id });

  it('should fail with PROCESSING_FAILED after exactly 3 attempts of a persistent transient error', async () => {
    const video = await seedProcessingVideo(dataSource);
    await uploadOriginal(storage, video.id, 'mp4-with-audio');
    const extractFrame = jest
      .spyOn(ffmpeg, 'extractFrame')
      .mockRejectedValue(new Error('simulated transient failure'));

    const failed = await waitForFailed(await enqueue(video.id));

    expect(failed.attemptsMade).toBe(3);
    expect(extractFrame).toHaveBeenCalledTimes(3);
    const stored = await findVideo(video.id);
    expect(stored.status).toBe(VideoStatus.Failed);
    expect(stored.processing_error).toBe('PROCESSING_FAILED');
  }, 30_000);

  it('should keep the video processing between transient attempts', async () => {
    const video = await seedProcessingVideo(dataSource);
    await uploadOriginal(storage, video.id, 'mp4-with-audio');
    const statuses: VideoStatus[] = [];
    jest.spyOn(ffmpeg, 'extractFrame').mockImplementation(async () => {
      statuses.push((await findVideo(video.id)).status);
      throw new Error('simulated transient failure');
    });

    await waitForFailed(await enqueue(video.id));

    expect(statuses).toEqual([
      VideoStatus.Processing,
      VideoStatus.Processing,
      VideoStatus.Processing,
    ]);
  }, 30_000);

  it.each([
    ['not-media', 'NO_VIDEO_STREAM'],
    ['audio-only', 'NO_VIDEO_STREAM'],
  ] as const)(
    'should fail a %s upload with %s after a single attempt',
    async (kind, code) => {
      const video = await seedProcessingVideo(dataSource);
      await uploadOriginal(storage, video.id, kind);

      const failed = await waitForFailed(await enqueue(video.id));

      expect(failed.attemptsMade).toBe(1);
      const stored = await findVideo(video.id);
      expect(stored.status).toBe(VideoStatus.Failed);
      expect(stored.processing_error).toBe(code);
    },
  );

  it('should fail with SOURCE_OBJECT_MISSING after a single attempt when the original was removed', async () => {
    const video = await seedProcessingVideo(dataSource);

    const failed = await waitForFailed(await enqueue(video.id));

    expect(failed.attemptsMade).toBe(1);
    const stored = await findVideo(video.id);
    expect(stored.status).toBe(VideoStatus.Failed);
    expect(stored.processing_error).toBe('SOURCE_OBJECT_MISSING');
  });
});
