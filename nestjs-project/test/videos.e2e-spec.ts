import {
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import type { INestApplication } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  createTestS3Client,
  emptyBucket,
  requestPresigned,
} from '../src/test/presigned-request';
import {
  getVideoFixture,
  type VideoFixtureKind,
} from '../src/test/video-fixtures';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from '../src/video-processing/video-processing.constants';
import type { ProcessVideoJobData } from '../src/video-processing/video-processing.types';
import { VideoResponseDto } from '../src/videos/dto/video-response.dto';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { videoThumbnailKey } from '../src/videos/video-object-keys';
import { registerConfirmAndLogin } from './support/auth';
import { E2E_THUMBNAILS_BUCKET, E2E_VIDEOS_BUCKET } from './support/videos-app';
import {
  createVideosFlowApp,
  type VideosFlowApp,
} from './support/videos-test-app';

interface PresignedUrlBody {
  url: string;
}

interface ErrorBody {
  error: string;
}

const SETTLE_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 200;

describe('Videos: upload → processing → playback (e2e, real worker)', () => {
  let flow: VideosFlowApp;
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let s3: S3Client;
  let counter = 0;

  beforeAll(async () => {
    flow = await createVideosFlowApp();
    app = flow.testApp.app;
    dataSource = flow.testApp.moduleRef.get(DataSource);
    throttlerStorage =
      flow.testApp.moduleRef.get<ThrottlerStorageService>(ThrottlerStorage);
    s3 = createTestS3Client();
  });

  afterAll(async () => {
    s3.destroy();
    await flow.close();
  });

  beforeEach(() => {
    throttlerStorage.storage.clear();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await cleanAllTables(dataSource);
    await emptyBucket(E2E_VIDEOS_BUCKET);
    await emptyBucket(E2E_THUMBNAILS_BUCKET);
  });

  const login = (): Promise<string> =>
    registerConfirmAndLogin(app, `videos_flow_${++counter}@example.com`);

  const api = () => request(app.getHttpServer());

  /** POST /videos → PUT of the single part straight to storage. */
  const initiateAndPut = async (
    token: string,
    fixture: Buffer,
  ): Promise<string> => {
    const created = await api()
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        filename: 'aula.mp4',
        mime_type: 'video/mp4',
        size_bytes: fixture.length,
      })
      .expect(201);
    const publicId = (created.body as { video: VideoResponseDto }).video
      .public_id;

    const urls = await api()
      .post(`/videos/${publicId}/upload/part-urls`)
      .set('Authorization', `Bearer ${token}`)
      .send({ part_numbers: [1] })
      .expect(200);
    const [part] = (urls.body as { parts: { url: string }[] }).parts;
    const put = await requestPresigned(part.url, {
      method: 'PUT',
      body: fixture,
    });
    expect(put.status).toBe(200);
    return publicId;
  };

  const uploadAndComplete = async (
    token: string,
    fixture: Buffer,
  ): Promise<string> => {
    const publicId = await initiateAndPut(token, fixture);
    const completed = await api()
      .post(`/videos/${publicId}/upload/complete`)
      .set('Authorization', `Bearer ${token}`)
      .expect(202);
    expect((completed.body as VideoResponseDto).status).toBe(
      VideoStatus.Processing,
    );
    return publicId;
  };

  /** Polls GET /videos/:publicId until the worker settles the video. */
  const waitUntilSettled = async (
    token: string,
    publicId: string,
  ): Promise<VideoResponseDto> => {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const res = await api()
        .get(`/videos/${publicId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const video = res.body as VideoResponseDto;
      if (video.status !== VideoStatus.Processing) return video;
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(
      `video ${publicId} still processing after ${SETTLE_TIMEOUT_MS} ms`,
    );
  };

  const loadFixture = async (kind: VideoFixtureKind): Promise<Buffer> =>
    readFile(await getVideoFixture(kind));

  const findVideo = (publicId: string): Promise<Video> =>
    dataSource.getRepository(Video).findOneByOrFail({ public_id: publicId });

  const playback = (
    route: 'stream' | 'download',
    publicId: string,
    token: string,
  ) =>
    api()
      .get(`/videos/${publicId}/${route}`)
      .set('Authorization', `Bearer ${token}`);

  it('fluxo-feliz-upload-processamento-reproducao', async () => {
    const fixture = await loadFixture('mp4-with-audio');
    const token = await login();
    flow.resetApiBytes();

    const publicId = await uploadAndComplete(token, fixture);
    const video = await waitUntilSettled(token, publicId);

    expect(video).toMatchObject({
      status: VideoStatus.Ready,
      size_bytes: fixture.length,
      width: 320,
      height: 240,
      video_codec: 'h264',
      audio_codec: 'aac',
      processing_error: null,
    });
    expect(video.duration_seconds).toBeCloseTo(3, 0);
    expect(video.container_format).toEqual(expect.any(String));

    const thumbnail = await requestPresigned(video.thumbnail_url!, {
      method: 'GET',
    });
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers['content-type']).toBe('image/jpeg');
    const { id } = await findVideo(publicId);
    await expect(
      s3.send(
        new HeadObjectCommand({
          Bucket: E2E_THUMBNAILS_BUCKET,
          Key: videoThumbnailKey(id),
        }),
      ),
    ).resolves.toBeDefined();

    const stream = await playback('stream', publicId, token).expect(200);
    const ranged = await requestPresigned(
      (stream.body as PresignedUrlBody).url,
      { method: 'GET', headers: { Range: 'bytes=0-1023' } },
    );
    expect(ranged.status).toBe(206);
    expect(ranged.body.equals(fixture.subarray(0, 1024))).toBe(true);

    const download = await playback('download', publicId, token).expect(200);
    const file = await requestPresigned(
      (download.body as PresignedUrlBody).url,
      { method: 'GET' },
    );
    expect(file.status).toBe(200);
    expect(file.headers['content-disposition']).toMatch(/^attachment;/);
    expect(file.body.equals(fixture)).toBe(true);

    // AMB-3: the video bytes went to storage, never through the API.
    expect(flow.apiBytes()).toBeLessThan(fixture.length * 0.1);
  }, 60_000);

  it('fluxo-falha-not-media', async () => {
    const fixture = await loadFixture('not-media');
    const token = await login();

    const publicId = await uploadAndComplete(token, fixture);
    const video = await waitUntilSettled(token, publicId);

    expect(video.status).toBe(VideoStatus.Failed);
    expect(video.processing_error).toBe('NO_VIDEO_STREAM');
    expect(video.thumbnail_url).toBeNull();
    const thumbnails = await s3.send(
      new ListObjectsV2Command({ Bucket: E2E_THUMBNAILS_BUCKET }),
    );
    expect(thumbnails.KeyCount).toBe(0);

    const stream = await playback('stream', publicId, token).expect(409);
    expect((stream.body as ErrorBody).error).toBe('VIDEO_NOT_READY');
  }, 60_000);

  it('fluxo-sem-audio', async () => {
    const fixture = await loadFixture('mp4-video-only');
    const token = await login();

    const publicId = await uploadAndComplete(token, fixture);
    const video = await waitUntilSettled(token, publicId);

    expect(video.status).toBe(VideoStatus.Ready);
    expect(video.video_codec).toBe('h264');
    expect(video.audio_codec).toBeNull();
  }, 60_000);

  it('fluxo-cancelamento', async () => {
    const fixture = await loadFixture('mp4-with-audio');
    const token = await login();
    const publicId = await initiateAndPut(token, fixture);

    await api()
      .delete(`/videos/${publicId}/upload`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    const res = await api()
      .get(`/videos/${publicId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
    expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
    const objects = await s3.send(
      new ListObjectsV2Command({ Bucket: E2E_VIDEOS_BUCKET }),
    );
    expect(objects.KeyCount).toBe(0);
    const uploads = await s3.send(
      new ListMultipartUploadsCommand({ Bucket: E2E_VIDEOS_BUCKET }),
    );
    expect(uploads.Uploads ?? []).toHaveLength(0);
  });

  it('job-de-outro-prefixo-fica-intocado', async () => {
    // A job under a prefix no worker listens to stays waiting while this
    // suite's worker, on its own prefix, processes a video end to end.
    const foreign = new Queue<ProcessVideoJobData>(VIDEO_PROCESSING_QUEUE, {
      connection: {
        host: process.env.REDIS_HOST ?? 'redis',
        port: Number(process.env.REDIS_PORT ?? 6379),
      },
      prefix: `test-${randomUUID()}`,
    });
    try {
      const job = await foreign.add(PROCESS_VIDEO_JOB, {
        videoId: randomUUID(),
      });
      const fixture = await loadFixture('mp4-video-only');
      const token = await login();

      const publicId = await uploadAndComplete(token, fixture);
      const video = await waitUntilSettled(token, publicId);

      expect(video.status).toBe(VideoStatus.Ready);
      expect(foreign.opts.prefix).not.toBe(flow.testApp.queuePrefix);
      expect(await job.getState()).toBe('waiting');
      const stored = await foreign.getJob(job.id!);
      expect(stored!.attemptsMade).toBe(0);
    } finally {
      await foreign.obliterate({ force: true });
      await foreign.close();
    }
  }, 60_000);
});
