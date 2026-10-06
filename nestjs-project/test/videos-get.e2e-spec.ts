import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type { Queue } from 'bullmq';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { emptyBucket, requestPresigned } from '../src/test/presigned-request';
import { VIDEO_PROCESSING_QUEUE } from '../src/video-processing/video-processing.constants';
import type { ProcessVideoJobData } from '../src/video-processing/video-processing.types';
import { VideosService } from '../src/videos/videos.service';
import { registerConfirmAndLogin } from './support/auth';
import { createVideoStates, type VideoStates } from './support/video-states';
import {
  createVideosTestApp,
  E2E_THUMBNAILS_BUCKET,
  E2E_VIDEOS_BUCKET,
  type VideosTestApp,
} from './support/videos-app';

interface VideoBody {
  status: string;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  container_format: string | null;
  processing_error: string | null;
  thumbnail_url: string | null;
}

interface ErrorBody {
  error: string;
}

describe('GET /videos/:publicId (e2e)', () => {
  let testApp: VideosTestApp;
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let queue: Queue<ProcessVideoJobData>;
  let videosService: VideosService;
  let throttlerStorage: ThrottlerStorageService;
  let uploadToProcessing: VideoStates['uploadToProcessing'];
  let seedReady: VideoStates['seedReady'];
  let findVideo: VideoStates['findVideo'];
  let counter = 0;

  beforeAll(async () => {
    testApp = await createVideosTestApp();
    app = testApp.app;
    dataSource = testApp.moduleRef.get(DataSource);
    queue = testApp.moduleRef.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    videosService = testApp.moduleRef.get(VideosService);
    throttlerStorage =
      testApp.moduleRef.get<ThrottlerStorageService>(ThrottlerStorage);
    ({ uploadToProcessing, seedReady, findVideo } =
      await createVideoStates(testApp));
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await emptyBucket(E2E_VIDEOS_BUCKET);
    await emptyBucket(E2E_THUMBNAILS_BUCKET);
    await testApp.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await emptyBucket(E2E_VIDEOS_BUCKET);
    await emptyBucket(E2E_THUMBNAILS_BUCKET);
    await queue.obliterate({ force: true });
    throttlerStorage.storage.clear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const login = (): Promise<string> =>
    registerConfirmAndLogin(app, `videos_get_${++counter}@example.com`);

  const getVideo = (publicId: string, token?: string) => {
    const req = request(app.getHttpServer()).get(`/videos/${publicId}`);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req;
  };

  describe('Ler o vídeo próprio em cada estado', () => {
    it('get-video-ready-com-thumbnail', async () => {
      const token = await login();
      const publicId = await uploadToProcessing(token);
      await seedReady(publicId);

      const res = await getVideo(publicId, token).expect(200);

      const body = res.body as VideoBody;
      expect(body.status).toBe('ready');
      expect(body.duration_seconds).not.toBeNull();
      expect(body.width).toBe(320);
      expect(body.height).toBe(240);
      expect(body.video_codec).not.toBeNull();
      expect(body.audio_codec).not.toBeNull();
      expect(body.container_format).not.toBeNull();
      expect(body.processing_error).toBeNull();
      expect(new URL(body.thumbnail_url!).host).toBe(
        new URL(process.env.S3_PUBLIC_ENDPOINT!).host,
      );
      expect(res.body).not.toHaveProperty('id');
      expect(res.body).not.toHaveProperty('channel_id');
      expect(res.body).not.toHaveProperty('upload_id');

      const thumbnail = await requestPresigned(body.thumbnail_url!, {
        method: 'GET',
      });
      expect(thumbnail.status).toBe(200);
      expect(thumbnail.headers['content-type']).toBe('image/jpeg');
      expect([...thumbnail.body.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    });

    it('get-video-processing', async () => {
      const token = await login();
      const publicId = await uploadToProcessing(token);

      const res = await getVideo(publicId, token).expect(200);

      const body = res.body as VideoBody;
      expect(body.status).toBe('processing');
      expect(body.thumbnail_url).toBeNull();
    });

    it('get-video-failed', async () => {
      const token = await login();
      const publicId = await uploadToProcessing(token);
      const { id } = await findVideo(publicId);
      expect(await videosService.markFailed(id, 'NO_VIDEO_STREAM')).toBe(true);

      const res = await getVideo(publicId, token).expect(200);

      const body = res.body as VideoBody;
      expect(body.status).toBe('failed');
      expect(body.processing_error).toBe('NO_VIDEO_STREAM');
      expect(body.thumbnail_url).toBeNull();
    });
  });

  describe('Autorização e validação', () => {
    it('get-nao-dono-indistinguivel-de-inexistente', async () => {
      const ownerToken = await login();
      const strangerToken = await login();
      const publicId = await uploadToProcessing(ownerToken);

      const foreign = await getVideo(publicId, strangerToken).expect(404);
      const missing = await getVideo('AAAAAAAAAAA', strangerToken).expect(404);

      expect((foreign.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
      expect(missing.text).toBe(foreign.text);
    });

    it('get-public-id-malformado', async () => {
      const token = await login();

      const res = await getVideo('abc', token).expect(400);

      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });

    it('get-sem-token', async () => {
      const token = await login();
      const publicId = await uploadToProcessing(token);

      await getVideo(publicId).expect(401);
    });
  });
});
