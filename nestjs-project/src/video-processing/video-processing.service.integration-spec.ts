import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { FfmpegService } from '../media/ffmpeg.service';
import { MediaModule } from '../media/media.module';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { createTestS3Client, emptyBucket } from '../test/presigned-request';
import {
  seedProcessingVideo,
  uploadOriginal,
} from '../test/processing-fixtures';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { VideosCoreModule } from '../videos/videos-core.module';
import { VideoProcessingTerminalError } from './video-processing.errors';
import { VideoProcessingService } from './video-processing.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
// Dedicated buckets so the suite never touches development data.
const VIDEOS_BUCKET = 'it-processing-videos';
const THUMBNAILS_BUCKET = 'it-processing-thumbnails';

describe('VideoProcessingService × MinIO + Postgres + ffmpeg', () => {
  let module: TestingModule;
  let service: VideoProcessingService;
  let storage: StorageService;
  let ffmpeg: FfmpegService;
  let dataSource: DataSource;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    process.env.S3_VIDEOS_BUCKET = VIDEOS_BUCKET;
    process.env.S3_THUMBNAILS_BUCKET = THUMBNAILS_BUCKET;
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosCoreModule,
        StorageModule,
        MediaModule,
      ],
      providers: [VideoProcessingService],
    }).compile();
    await module.init();
    service = module.get(VideoProcessingService);
    storage = module.get(StorageService);
    ffmpeg = module.get(FfmpegService);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
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

  const findVideo = (id: string): Promise<Video> =>
    dataSource.getRepository(Video).findOneByOrFail({ id });

  const headThumbnail = async (id: string) => {
    const client = createTestS3Client();
    try {
      return await client.send(
        new HeadObjectCommand({
          Bucket: THUMBNAILS_BUCKET,
          Key: `${id}/thumbnail.jpg`,
        }),
      );
    } finally {
      client.destroy();
    }
  };

  const expectTerminal = async (id: string, code: string): Promise<void> => {
    const error: unknown = await service.process(id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VideoProcessingTerminalError);
    expect((error as VideoProcessingTerminalError).code).toBe(code);
  };

  it('should move an MP4 with audio to ready with metadata and a JPEG thumbnail', async () => {
    const video = await seedProcessingVideo(dataSource);
    await uploadOriginal(storage, video.id, 'mp4-with-audio');

    await expect(service.process(video.id)).resolves.toBe('ready');

    const stored = await findVideo(video.id);
    expect(stored.status).toBe(VideoStatus.Ready);
    expect(stored.processing_error).toBeNull();
    expect(stored.duration_seconds).toBeCloseTo(3, 0);
    expect(stored.width).toBe(320);
    expect(stored.height).toBe(240);
    expect(stored.video_codec).toBe('h264');
    expect(stored.audio_codec).toBe('aac');
    expect(stored.container_format).toContain('mp4');
    const thumbnail = await headThumbnail(video.id);
    expect(thumbnail.ContentType).toBe('image/jpeg');
    expect(thumbnail.ContentLength).toBeGreaterThan(0);
  });

  it('should store a null audio_codec for a video-only MP4', async () => {
    const video = await seedProcessingVideo(dataSource);
    await uploadOriginal(storage, video.id, 'mp4-video-only');

    await service.process(video.id);

    const stored = await findVideo(video.id);
    expect(stored.status).toBe(VideoStatus.Ready);
    expect(stored.audio_codec).toBeNull();
    expect(stored.video_codec).toBe('h264');
  });

  it('should take the thumbnail from the first frame of a short video', async () => {
    const video = await seedProcessingVideo(dataSource);
    await uploadOriginal(storage, video.id, 'mp4-short');
    const extractFrame = jest.spyOn(ffmpeg, 'extractFrame');

    await service.process(video.id);

    expect(extractFrame).toHaveBeenCalledWith(expect.any(String), 0);
    expect((await headThumbnail(video.id)).ContentType).toBe('image/jpeg');
  });

  it.each(['audio-only', 'not-media'] as const)(
    'should fail a %s upload with the terminal NO_VIDEO_STREAM',
    async (kind) => {
      const video = await seedProcessingVideo(dataSource);
      await uploadOriginal(storage, video.id, kind);

      await expectTerminal(video.id, 'NO_VIDEO_STREAM');

      expect((await findVideo(video.id)).status).toBe(VideoStatus.Processing);
      await expect(headThumbnail(video.id)).rejects.toMatchObject({
        $metadata: { httpStatusCode: 404 },
      });
    },
  );

  it('should fail with the terminal SOURCE_OBJECT_MISSING when the original is gone', async () => {
    const video = await seedProcessingVideo(dataSource);

    await expectTerminal(video.id, 'SOURCE_OBJECT_MISSING');
  });

  it('should leave a ready video and its thumbnail untouched on a second run', async () => {
    const video = await seedProcessingVideo(dataSource);
    await uploadOriginal(storage, video.id, 'mp4-with-audio');
    await service.process(video.id);
    const before = await findVideo(video.id);
    const thumbnailBefore = await headThumbnail(video.id);

    await expect(service.process(video.id)).resolves.toBe('skipped');

    expect(await findVideo(video.id)).toEqual(before);
    const thumbnailAfter = await headThumbnail(video.id);
    expect(thumbnailAfter.ETag).toBe(thumbnailBefore.ETag);
    expect(thumbnailAfter.LastModified).toEqual(thumbnailBefore.LastModified);
  });
});
