import {
  HeadObjectCommand,
  ListMultipartUploadsCommand,
} from '@aws-sdk/client-s3';
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type { Queue } from 'bullmq';
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
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from '../src/video-processing/video-processing.constants';
import type { ProcessVideoJobData } from '../src/video-processing/video-processing.types';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import * as videosConstants from '../src/videos/videos.constants';
import { registerConfirmAndLogin } from './support/auth';
import {
  createVideosTestApp,
  E2E_THUMBNAILS_BUCKET,
  E2E_VIDEOS_BUCKET,
  type VideosTestApp,
} from './support/videos-app';

const MIN_PART_SIZE = 5_242_880;
const LAST_PART_SIZE = 1024;
const TOTAL_SIZE = MIN_PART_SIZE + LAST_PART_SIZE;
// 16 MiB + 1 byte: the smallest declared size with part_count = 2.
const TWO_PART_DECLARED_SIZE = 16_777_217;

interface VideoBody {
  status: string;
  size_bytes: number;
  thumbnail_url: string | null;
}

interface ErrorBody {
  error: string;
}

describe('POST /videos/:publicId/upload/complete (e2e)', () => {
  let testApp: VideosTestApp;
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let queue: Queue<ProcessVideoJobData>;
  let throttlerStorage: ThrottlerStorageService;
  let counter = 0;

  beforeAll(async () => {
    testApp = await createVideosTestApp();
    app = testApp.app;
    dataSource = testApp.moduleRef.get(DataSource);
    queue = testApp.moduleRef.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    throttlerStorage =
      testApp.moduleRef.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await emptyBucket(E2E_VIDEOS_BUCKET);
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
    registerConfirmAndLogin(app, `videos_complete_${++counter}@example.com`);

  const createDraft = async (token: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        filename: 'aula.mp4',
        mime_type: 'video/mp4',
        size_bytes: TWO_PART_DECLARED_SIZE,
      })
      .expect(201);
    return (res.body as { video: { public_id: string } }).video.public_id;
  };

  const putParts = async (
    token: string,
    publicId: string,
    sizes: Record<number, number>,
  ): Promise<void> => {
    const partNumbers = Object.keys(sizes).map(Number);
    const res = await request(app.getHttpServer())
      .post(`/videos/${publicId}/upload/part-urls`)
      .set('Authorization', `Bearer ${token}`)
      .send({ part_numbers: partNumbers })
      .expect(200);
    const { parts } = res.body as {
      parts: { part_number: number; url: string }[];
    };
    for (const part of parts) {
      const put = await requestPresigned(part.url, {
        method: 'PUT',
        body: Buffer.alloc(sizes[part.part_number], 1),
      });
      expect(put.status).toBe(200);
    }
  };

  const putBothParts = (token: string, publicId: string) =>
    putParts(token, publicId, { 1: MIN_PART_SIZE, 2: LAST_PART_SIZE });

  const complete = (publicId: string, token?: string) => {
    const req = request(app.getHttpServer()).post(
      `/videos/${publicId}/upload/complete`,
    );
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req;
  };

  const findVideo = (publicId: string): Promise<Video> =>
    dataSource.getRepository(Video).findOneByOrFail({ public_id: publicId });

  const headOriginal = async (id: string): Promise<number | undefined> => {
    const client = createTestS3Client();
    try {
      const head = await client.send(
        new HeadObjectCommand({
          Bucket: E2E_VIDEOS_BUCKET,
          Key: `${id}/original`,
        }),
      );
      return head.ContentLength;
    } finally {
      client.destroy();
    }
  };

  const listOpenUploadKeys = async (): Promise<string[]> => {
    const client = createTestS3Client();
    try {
      const page = await client.send(
        new ListMultipartUploadsCommand({ Bucket: E2E_VIDEOS_BUCKET }),
      );
      return (page.Uploads ?? []).map((upload) => upload.Key!);
    } finally {
      client.destroy();
    }
  };

  const pendingJobs = () => queue.getJobs(['waiting', 'delayed', 'active']);

  describe('Concluir upload e enfileirar processamento', () => {
    it('complete-move-para-processing-e-enfileira', async () => {
      const token = await login();
      const publicId = await createDraft(token);
      await putBothParts(token, publicId);

      const res = await complete(publicId, token).expect(202);

      const body = res.body as VideoBody;
      expect(body.status).toBe('processing');
      expect(body.size_bytes).toBe(TOTAL_SIZE);
      expect(body.thumbnail_url).toBeNull();
      const stored = await findVideo(publicId);
      expect(stored.status).toBe(VideoStatus.Processing);
      expect(stored.upload_id).toBeNull();
      expect(Number(stored.size_bytes)).toBe(TOTAL_SIZE);
      expect(await headOriginal(stored.id)).toBe(TOTAL_SIZE);
      const jobs = await pendingJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].name).toBe(PROCESS_VIDEO_JOB);
      expect(jobs[0].id).toBe(`video-${stored.id}`);
      expect(jobs[0].data).toEqual({ videoId: stored.id });
    });

    it('complete-repetido-e-idempotente', async () => {
      const token = await login();
      const publicId = await createDraft(token);
      await putBothParts(token, publicId);

      await complete(publicId, token).expect(202);
      const again = await complete(publicId, token).expect(202);

      expect((again.body as VideoBody).status).toBe('processing');
      const { id } = await findVideo(publicId);
      const jobs = (await pendingJobs()).filter(
        (job) => job.id === `video-${id}`,
      );
      expect(jobs).toHaveLength(1);
    });
  });

  describe('Upload incompleto e estados inválidos', () => {
    it('complete-com-parte-faltando', async () => {
      const token = await login();
      const publicId = await createDraft(token);
      await putParts(token, publicId, { 1: MIN_PART_SIZE });
      const before = await findVideo(publicId);

      const res = await complete(publicId, token).expect(409);

      expect((res.body as ErrorBody).error).toBe('UPLOAD_INCOMPLETE');
      const after = await findVideo(publicId);
      expect(after.status).toBe(VideoStatus.Uploading);
      expect(after.upload_id).toBe(before.upload_id);
      const parts = await request(app.getHttpServer())
        .get(`/videos/${publicId}/upload/parts`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(
        (parts.body as { parts: { part_number: number }[] }).parts.map(
          (part) => part.part_number,
        ),
      ).toEqual([1]);

      await putParts(token, publicId, { 2: LAST_PART_SIZE });
      await complete(publicId, token).expect(202);
    });

    it('complete-com-parte-nao-final-pequena', async () => {
      const token = await login();
      const publicId = await createDraft(token);
      await putParts(token, publicId, { 1: 1024, 2: LAST_PART_SIZE });

      const res = await complete(publicId, token).expect(409);

      expect((res.body as ErrorBody).error).toBe('UPLOAD_INCOMPLETE');
      expect((await findVideo(publicId)).status).toBe(VideoStatus.Uploading);
    });

    it('complete-de-video-ready-ou-failed', async () => {
      const token = await login();
      const publicId = await createDraft(token);
      const repository = dataSource.getRepository(Video);

      await repository.update(
        { public_id: publicId },
        { status: VideoStatus.Ready, upload_id: null },
      );
      const ready = await complete(publicId, token).expect(409);
      await repository.update(
        { public_id: publicId },
        { status: VideoStatus.Failed, processing_error: 'PROCESSING_FAILED' },
      );
      const failed = await complete(publicId, token).expect(409);

      expect((ready.body as ErrorBody).error).toBe('INVALID_UPLOAD_STATE');
      expect((failed.body as ErrorBody).error).toBe('INVALID_UPLOAD_STATE');
      expect(await pendingJobs()).toHaveLength(0);
    });
  });

  describe('Teto de tamanho', () => {
    it('complete-acima-do-teto', async () => {
      const token = await login();
      const publicId = await createDraft(token);
      await putBothParts(token, publicId);
      // The cap is a module constant, not a provider: lower only its value,
      // after POST /videos so the DTO @Max keeps the real limit.
      jest.replaceProperty(
        videosConstants,
        'VIDEO_MAX_SIZE_BYTES',
        MIN_PART_SIZE,
      );

      const res = await complete(publicId, token).expect(422);

      expect((res.body as ErrorBody).error).toBe('VIDEO_FILE_TOO_LARGE');
      const stored = await findVideo(publicId);
      expect(stored.status).toBe(VideoStatus.Failed);
      expect(stored.processing_error).toBe('FILE_TOO_LARGE');
      expect(stored.upload_id).toBeNull();
      await expect(headOriginal(stored.id)).rejects.toMatchObject({
        $metadata: { httpStatusCode: 404 },
      });
      expect(await pendingJobs()).toHaveLength(0);
    });
  });

  describe('Autorização e validação de param', () => {
    it('complete-nao-dono', async () => {
      const ownerToken = await login();
      const strangerToken = await login();
      const publicId = await createDraft(ownerToken);
      await putBothParts(ownerToken, publicId);

      const res = await complete(publicId, strangerToken).expect(404);

      expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
      const stored = await findVideo(publicId);
      expect(stored.status).toBe(VideoStatus.Uploading);
      expect(stored.upload_id).not.toBeNull();
      expect(await listOpenUploadKeys()).toContain(`${stored.id}/original`);
      expect(await pendingJobs()).toHaveLength(0);
    });

    it('complete-param-e-token', async () => {
      const token = await login();
      const publicId = await createDraft(token);

      const malformed = await complete('abc', token).expect(400);
      await complete(publicId).expect(401);

      expect((malformed.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });
  });
});
