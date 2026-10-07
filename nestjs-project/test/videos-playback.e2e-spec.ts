import { createHash } from 'node:crypto';
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

interface PresignedUrlBody {
  url: string;
  expires_at: string;
}

interface ErrorBody {
  error: string;
}

type PlaybackRoute = 'stream' | 'download';
const ROUTES: PlaybackRoute[] = ['stream', 'download'];

const sha256 = (data: Buffer): string =>
  createHash('sha256').update(data).digest('hex');

describe('GET /videos/:publicId/stream e /download (e2e)', () => {
  let testApp: VideosTestApp;
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let queue: Queue<ProcessVideoJobData>;
  let videosService: VideosService;
  let throttlerStorage: ThrottlerStorageService;
  let states: VideoStates;
  let counter = 0;

  beforeAll(async () => {
    testApp = await createVideosTestApp();
    app = testApp.app;
    dataSource = testApp.moduleRef.get(DataSource);
    queue = testApp.moduleRef.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    videosService = testApp.moduleRef.get(VideosService);
    throttlerStorage =
      testApp.moduleRef.get<ThrottlerStorageService>(ThrottlerStorage);
    states = await createVideoStates(testApp);
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
    registerConfirmAndLogin(app, `videos_playback_${++counter}@example.com`);

  const readyVideo = async (
    token: string,
    filename?: string,
  ): Promise<string> => {
    const publicId = await states.uploadToProcessing(token, filename);
    await states.seedReady(publicId);
    return publicId;
  };

  const playback = (route: PlaybackRoute, publicId: string, token?: string) => {
    const req = request(app.getHttpServer()).get(
      `/videos/${publicId}/${route}`,
    );
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req;
  };

  /** expires_at must be within ±10 s of now + ttl. */
  const expectExpiresIn = (expiresAt: string, ttlSeconds: number): void => {
    const deltaSeconds = (Date.parse(expiresAt) - Date.now()) / 1000;
    expect(deltaSeconds).toBeGreaterThan(ttlSeconds - 10);
    expect(deltaSeconds).toBeLessThan(ttlSeconds + 10);
  };

  describe('Streaming e download de vídeo pronto', () => {
    it('stream-url-com-range', async () => {
      const token = await login();
      const publicId = await readyVideo(token);

      const res = await playback('stream', publicId, token).expect(200);

      const body = res.body as PresignedUrlBody;
      expect(new URL(body.url).host).toBe(
        new URL(process.env.S3_PUBLIC_ENDPOINT!).host,
      );
      expectExpiresIn(body.expires_at, 21600);

      const ranged = await requestPresigned(body.url, {
        method: 'GET',
        headers: { Range: 'bytes=0-1023' },
      });
      expect(ranged.status).toBe(206);
      expect(ranged.headers['content-range']).toBe(
        `bytes 0-1023/${states.fixture.length}`,
      );
      expect(ranged.headers['content-type']).toBe('video/mp4');
      expect(ranged.body.equals(states.fixture.subarray(0, 1024))).toBe(true);
    });

    it('download-url-com-attachment', async () => {
      const token = await login();
      const publicId = await readyVideo(token);

      const res = await playback('download', publicId, token).expect(200);

      const body = res.body as PresignedUrlBody;
      expectExpiresIn(body.expires_at, 900);

      const download = await requestPresigned(body.url, { method: 'GET' });
      expect(download.status).toBe(200);
      expect(download.headers['content-disposition']).toMatch(/^attachment;/);
      expect(sha256(download.body)).toBe(sha256(states.fixture));
    });

    it('download-nome-nao-ascii', async () => {
      const filename = "aula 1 — introdução (parte 'a').mp4";
      const token = await login();
      const publicId = await readyVideo(token, filename);

      const res = await playback('download', publicId, token).expect(200);
      const download = await requestPresigned(
        (res.body as PresignedUrlBody).url,
        { method: 'GET' },
      );

      const disposition = download.headers['content-disposition']!;
      expect(disposition).toContain(
        'filename="aula 1 _ introdu__o _parte _a__.mp4"',
      );
      const [, encoded] = disposition.split("filename*=UTF-8''");
      expect(encoded).toBeDefined();
      expect(encoded).not.toContain("'");
      expect(decodeURIComponent(encoded)).toBe(filename);
    });
  });

  describe('Vídeo ainda não pronto', () => {
    it('stream-e-download-de-video-processing', async () => {
      const token = await login();
      const publicId = await states.uploadToProcessing(token);

      for (const route of ROUTES) {
        const res = await playback(route, publicId, token).expect(409);
        expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_READY');
      }
    });

    it('stream-e-download-de-video-failed', async () => {
      const token = await login();
      const publicId = await states.uploadToProcessing(token);
      const { id } = await states.findVideo(publicId);
      expect(await videosService.markFailed(id, 'NO_VIDEO_STREAM')).toBe(true);

      for (const route of ROUTES) {
        const res = await playback(route, publicId, token).expect(409);
        expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_READY');
      }
    });
  });

  describe('Autorização e validação', () => {
    it('playback-nao-dono', async () => {
      const ownerToken = await login();
      const strangerToken = await login();
      const publicId = await readyVideo(ownerToken);

      for (const route of ROUTES) {
        const res = await playback(route, publicId, strangerToken).expect(404);
        expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
      }
    });

    it('playback-sem-token-e-param-malformado', async () => {
      const token = await login();
      const publicId = await readyVideo(token);

      for (const route of ROUTES) {
        await playback(route, publicId).expect(401);
        const malformed = await playback(route, 'abc', token).expect(400);
        expect((malformed.body as ErrorBody).error).toBe('VALIDATION_ERROR');
      }
    });
  });
});
