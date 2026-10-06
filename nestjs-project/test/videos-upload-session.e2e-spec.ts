import { ListMultipartUploadsCommand } from '@aws-sdk/client-s3';
import type { INestApplication } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  createTestS3Client,
  emptyBucket,
  requestPresigned,
} from '../src/test/presigned-request';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { registerConfirmAndLogin } from './support/auth';
import {
  createVideosTestApp,
  E2E_THUMBNAILS_BUCKET,
  E2E_VIDEOS_BUCKET,
  type VideosTestApp,
} from './support/videos-app';

const MIN_PART_SIZE = 5_242_880;
const TWO_PART_SIZE = 20_971_520;
const UNKNOWN_PUBLIC_ID = 'doesNotExst';

interface PartUrlsBody {
  parts: { part_number: number; url: string }[];
  expires_at: string;
}

interface PartsBody {
  parts: { part_number: number; size_bytes: number; etag: string }[];
}

interface ErrorBody {
  error: string;
}

type Route = 'part-urls' | 'parts' | 'cancel';
const ROUTES: Route[] = ['part-urls', 'parts', 'cancel'];

describe('Upload session routes (e2e)', () => {
  let testApp: VideosTestApp;
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let counter = 0;

  beforeAll(async () => {
    testApp = await createVideosTestApp();
    app = testApp.app;
    dataSource = testApp.moduleRef.get(DataSource);
    throttlerStorage =
      testApp.moduleRef.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await emptyBucket(E2E_VIDEOS_BUCKET);
    await testApp.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await emptyBucket(E2E_VIDEOS_BUCKET);
    await emptyBucket(E2E_THUMBNAILS_BUCKET);
    throttlerStorage.storage.clear();
  });

  const login = (): Promise<string> =>
    registerConfirmAndLogin(app, `videos_session_${++counter}@example.com`);

  const createDraft = async (
    token: string,
    sizeBytes = TWO_PART_SIZE,
  ): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        filename: 'aula.mp4',
        mime_type: 'video/mp4',
        size_bytes: sizeBytes,
      })
      .expect(201);
    return (res.body as { video: { public_id: string } }).video.public_id;
  };

  const call = (
    route: Route,
    token: string | undefined,
    publicId: string,
    partNumbers: unknown = [1],
  ) => {
    const server = app.getHttpServer();
    const base = `/videos/${publicId}/upload`;
    const req =
      route === 'part-urls'
        ? request(server).post(`${base}/part-urls`)
        : route === 'parts'
          ? request(server).get(`${base}/parts`)
          : request(server).delete(base);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return route === 'part-urls'
      ? req.send({ part_numbers: partNumbers })
      : req;
  };

  const putPart = async (token: string, publicId: string) => {
    const res = await call('part-urls', token, publicId, [1]).expect(200);
    const { url } = (res.body as PartUrlsBody).parts[0];
    return {
      url,
      put: await requestPresigned(url, {
        method: 'PUT',
        body: Buffer.alloc(MIN_PART_SIZE, 1),
      }),
    };
  };

  const findVideo = (publicId: string): Promise<Video | null> =>
    dataSource.getRepository(Video).findOneBy({ public_id: publicId });

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

  describe('Emitir URLs presignadas de partes', () => {
    it('part-urls-ordem-do-request', async () => {
      const token = await login();
      const publicId = await createDraft(token);
      const now = Date.now();

      const res = await call('part-urls', token, publicId, [2, 1]).expect(200);

      const body = res.body as PartUrlsBody;
      expect(body.parts.map((part) => part.part_number)).toEqual([2, 1]);
      const publicHost = new URL(process.env.S3_PUBLIC_ENDPOINT!).host;
      for (const part of body.parts) {
        expect(new URL(part.url).host).toBe(publicHost);
      }
      const expiresAt = Date.parse(body.expires_at);
      expect(expiresAt).toBeGreaterThanOrEqual(now + 3590_000);
      expect(expiresAt).toBeLessThanOrEqual(now + 3610_000);
    });

    it('part-urls-fora-do-intervalo', async () => {
      const token = await login();
      const publicId = await createDraft(token);

      const res = await call('part-urls', token, publicId, [3]).expect(400);

      expect((res.body as ErrorBody).error).toBe('PART_NUMBER_OUT_OF_RANGE');
    });

    it('part-urls-validacao-do-body', async () => {
      const token = await login();
      const publicId = await createDraft(token);
      const tooMany = Array.from({ length: 101 }, (_, i) => i + 1);

      const duplicated = await call(
        'part-urls',
        token,
        publicId,
        [1, 1],
      ).expect(400);
      const oversized = await call(
        'part-urls',
        token,
        publicId,
        tooMany,
      ).expect(400);

      expect((duplicated.body as ErrorBody).error).toBe('VALIDATION_ERROR');
      expect((oversized.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });
  });

  describe('Listar partes enviadas', () => {
    it('parts-reflete-put-real', async () => {
      const token = await login();
      const publicId = await createDraft(token, MIN_PART_SIZE + 1024);

      const { url, put } = await putPart(token, publicId);
      const res = await call('parts', token, publicId).expect(200);

      expect(put.status).toBe(200);
      expect(put.headers.etag).toBeDefined();
      expect((res.body as PartsBody).parts).toEqual([
        { part_number: 1, size_bytes: MIN_PART_SIZE, etag: put.headers.etag },
      ]);
      // The bytes went to the storage host, never through the API.
      expect(new URL(url).host).toBe(
        new URL(process.env.S3_PUBLIC_ENDPOINT!).host,
      );
    });
  });

  describe('Cancelar upload', () => {
    it('cancel-remove-linha-e-upload', async () => {
      const token = await login();
      const publicId = await createDraft(token);
      await putPart(token, publicId);
      const { id } = (await findVideo(publicId))!;

      const res = await call('cancel', token, publicId).expect(204);
      const again = await call('cancel', token, publicId).expect(404);

      expect(res.body).toEqual({});
      expect(res.text).toBe('');
      expect(await findVideo(publicId)).toBeNull();
      expect(await listOpenUploadKeys()).not.toContain(`${id}/original`);
      expect((again.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('Autorização, validação de param e estado', () => {
    it('rotas-de-upload-nao-dono', async () => {
      const ownerToken = await login();
      const strangerToken = await login();
      const publicId = await createDraft(ownerToken);

      for (const route of ROUTES) {
        const stranger = await call(route, strangerToken, publicId).expect(404);
        const unknown = await call(
          route,
          strangerToken,
          UNKNOWN_PUBLIC_ID,
        ).expect(404);

        expect((stranger.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
        expect(stranger.body).toEqual(unknown.body);
      }
      await call('parts', ownerToken, publicId).expect(200);
    });

    it('rotas-de-upload-public-id-malformado', async () => {
      const token = await login();

      for (const route of ROUTES) {
        const res = await call(route, token, 'abc').expect(400);

        expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
      }
    });

    it('rotas-de-upload-fora-de-uploading', async () => {
      const token = await login();
      const publicId = await createDraft(token);
      await dataSource.query(
        `UPDATE "videos" SET "status" = 'processing', "upload_id" = NULL WHERE "public_id" = $1`,
        [publicId],
      );

      for (const route of ROUTES) {
        const res = await call(route, token, publicId).expect(409);

        expect((res.body as ErrorBody).error).toBe('INVALID_UPLOAD_STATE');
      }
      expect((await findVideo(publicId))?.status).toBe(VideoStatus.Processing);
    });

    it('rotas-de-upload-sem-token', async () => {
      const token = await login();
      const publicId = await createDraft(token);

      for (const route of ROUTES) {
        await call(route, undefined, publicId).expect(401);
      }
    });
  });
});
