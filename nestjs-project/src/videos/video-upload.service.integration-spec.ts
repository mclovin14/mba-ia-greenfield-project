import {
  HeadObjectCommand,
  ListMultipartUploadsCommand,
} from '@aws-sdk/client-s3';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsModule } from '../channels/channels.module';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import {
  createTestS3Client,
  emptyBucket,
  requestPresigned,
} from '../test/presigned-request';
import { User } from '../users/entities/user.entity';
import { VIDEO_PROCESSING_QUEUE } from '../video-processing/video-processing.constants';
import { VideoProcessingQueueModule } from '../video-processing/video-processing-queue.module';
import type { ProcessVideoJobData } from '../video-processing/video-processing.types';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoUploadService } from './video-upload.service';
import { VideosCoreModule } from './videos-core.module';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
// Dedicated buckets so the suite never touches development data.
const VIDEOS_BUCKET = 'it-upload-videos';
const THUMBNAILS_BUCKET = 'it-upload-thumbnails';
const MIN_PART_SIZE = 5 * 1024 * 1024;
// Two 16 MiB parts, so part_count = 2.
const DRAFT_SIZE = 20 * 1024 * 1024;

describe('VideoUploadService × MinIO + Postgres + Redis', () => {
  let module: TestingModule;
  let service: VideoUploadService;
  let dataSource: DataSource;
  let queue: Queue<ProcessVideoJobData>;
  let counter = 0;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    process.env.S3_VIDEOS_BUCKET = VIDEOS_BUCKET;
    process.env.S3_THUMBNAILS_BUCKET = THUMBNAILS_BUCKET;
    // Unique prefix: a running video-worker never consumes these jobs.
    process.env.QUEUE_PREFIX = `test-${randomUUID()}`;
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosCoreModule,
        ChannelsModule,
        StorageModule,
        QueueModule,
        VideoProcessingQueueModule,
      ],
      providers: [VideoUploadService],
    }).compile();
    await module.init();
    service = module.get(VideoUploadService);
    dataSource = module.get(DataSource);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await emptyBucket(VIDEOS_BUCKET);
    await module.close();
    process.env = originalEnv;
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await emptyBucket(VIDEOS_BUCKET);
    await queue.obliterate({ force: true });
  });

  const createOwnerDraft = async (): Promise<{
    userId: string;
    publicId: string;
  }> => {
    const user = await dataSource.getRepository(User).save({
      email: `video_upload_${++counter}@example.com`,
      password: 'hashed',
    });
    await dataSource.getRepository(Channel).save({
      name: 'Owner',
      nickname: `videoupload${counter}`,
      user_id: user.id,
    });
    const { video } = await service.initiate(user.id, {
      filename: 'clip.mp4',
      mime_type: 'video/mp4',
      size_bytes: DRAFT_SIZE,
    });
    return { userId: user.id, publicId: video.public_id };
  };

  const listOpenUploadKeys = async (): Promise<string[]> => {
    const client = createTestS3Client();
    try {
      const page = await client.send(
        new ListMultipartUploadsCommand({ Bucket: VIDEOS_BUCKET }),
      );
      return (page.Uploads ?? []).map((upload) => upload.Key!);
    } finally {
      client.destroy();
    }
  };

  it('should issue URLs that accept a real PUT and list the stored part with its ETag', async () => {
    const { userId, publicId } = await createOwnerDraft();

    const { parts } = await service.presignPartUrls(userId, publicId, [2, 1]);
    const put = await requestPresigned(parts[1].url, {
      method: 'PUT',
      body: Buffer.alloc(MIN_PART_SIZE, 1),
    });
    const listed = await service.listUploadedParts(userId, publicId);

    expect(parts.map((part) => part.part_number)).toEqual([2, 1]);
    expect(put.status).toBe(200);
    expect(listed.parts).toEqual([
      { part_number: 1, size_bytes: MIN_PART_SIZE, etag: put.headers.etag },
    ]);
  });

  it('should remove the row and the multipart upload on cancel', async () => {
    const { userId, publicId } = await createOwnerDraft();
    const { id } = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: publicId });

    await service.cancel(userId, publicId);

    expect(await dataSource.getRepository(Video).findOneBy({ id })).toBeNull();
    expect(await listOpenUploadKeys()).not.toContain(`${id}/original`);
  });

  it('should assemble the object, move the row to processing and enqueue exactly one job', async () => {
    const { userId, publicId } = await createOwnerDraft();
    const { parts } = await service.presignPartUrls(userId, publicId, [1, 2]);
    for (const [index, size] of [MIN_PART_SIZE, 1024].entries()) {
      const put = await requestPresigned(parts[index].url, {
        method: 'PUT',
        body: Buffer.alloc(size, 1),
      });
      expect(put.status).toBe(200);
    }

    const result = await service.complete(userId, publicId);
    await service.complete(userId, publicId);

    const stored = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: publicId });
    const client = createTestS3Client();
    const head = await client
      .send(
        new HeadObjectCommand({
          Bucket: VIDEOS_BUCKET,
          Key: `${stored.id}/original`,
        }),
      )
      .finally(() => client.destroy());
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    expect(result.status).toBe(VideoStatus.Processing);
    expect(stored.status).toBe(VideoStatus.Processing);
    expect(Number(stored.size_bytes)).toBe(MIN_PART_SIZE + 1024);
    expect(stored.upload_id).toBeNull();
    expect(head.ContentLength).toBe(MIN_PART_SIZE + 1024);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe(`video-${stored.id}`);
    expect(jobs[0].data).toEqual({ videoId: stored.id });
  });
});
