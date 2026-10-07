import { ListMultipartUploadsCommand } from '@aws-sdk/client-s3';
import type { INestApplication } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { createTestS3Client, emptyBucket } from '../src/test/presigned-request';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { registerConfirmAndLogin } from './support/auth';
import {
  createVideosTestApp,
  E2E_THUMBNAILS_BUCKET,
  E2E_VIDEOS_BUCKET,
  type VideosTestApp,
} from './support/videos-app';

const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const TEN_GIB = 10 * 1024 ** 3;

const VALID_BODY = {
  filename: 'aula.mp4',
  mime_type: 'video/mp4',
  size_bytes: 50_000_000,
};

interface InitiateBody {
  video: Record<string, unknown> & {
    public_id: string;
    title: string;
    status: string;
    thumbnail_url: string | null;
  };
  upload: {
    part_size_bytes: number;
    part_count: number;
    max_part_urls_per_request: number;
  };
}

interface ErrorBody {
  error: string;
}

describe('POST /videos (e2e)', () => {
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
    registerConfirmAndLogin(app, `videos_init_${++counter}@example.com`);

  const initiate = (token: string | undefined, body: object) => {
    const req = request(app.getHttpServer()).post('/videos');
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req.send(body);
  };

  const listOpenUploads = async (): Promise<
    { Key?: string; UploadId?: string }[]
  > => {
    const client = createTestS3Client();
    try {
      const page = await client.send(
        new ListMultipartUploadsCommand({ Bucket: E2E_VIDEOS_BUCKET }),
      );
      return page.Uploads ?? [];
    } finally {
      client.destroy();
    }
  };

  const videoCount = (): Promise<number> =>
    dataSource.getRepository(Video).count();

  describe('Iniciar upload e pré-cadastrar rascunho', () => {
    it('initiate-cria-rascunho-e-plano-de-partes', async () => {
      const token = await login();

      const res = await initiate(token, VALID_BODY).expect(201);

      const body = res.body as InitiateBody;
      expect(body.video.status).toBe('uploading');
      expect(body.video.title).toBe('aula');
      expect(body.video.thumbnail_url).toBeNull();
      expect(body.video.public_id).toMatch(PUBLIC_ID_PATTERN);
      expect(body.upload).toEqual({
        part_size_bytes: 16777216,
        part_count: 3,
        max_part_urls_per_request: 100,
      });
      expect(body).not.toHaveProperty('id');
      expect(body.video).not.toHaveProperty('id');
      expect(body.video).not.toHaveProperty('channel_id');
      expect(body.video).not.toHaveProperty('upload_id');
    });

    it('initiate-abre-multipart-no-storage', async () => {
      const token = await login();

      const res = await initiate(token, VALID_BODY).expect(201);

      const stored = await dataSource.getRepository(Video).findOneByOrFail({
        public_id: (res.body as InitiateBody).video.public_id,
      });
      expect(stored.upload_id).not.toBeNull();
      expect(stored.status).toBe(VideoStatus.Uploading);
      expect(await listOpenUploads()).toEqual([
        expect.objectContaining({
          Key: `${stored.id}/original`,
          UploadId: stored.upload_id,
        }),
      ]);
    });

    it('initiate-titulo-explicito', async () => {
      const token = await login();

      const res = await initiate(token, {
        ...VALID_BODY,
        size_bytes: 1,
        title: '  Minha aula  ',
      }).expect(201);

      const body = res.body as InitiateBody;
      expect(body.video.title).toBe('Minha aula');
      expect(body.upload.part_count).toBe(1);
    });
  });

  describe('Validação e autenticação', () => {
    it('initiate-rejeita-mime-fora-da-allowlist', async () => {
      const token = await login();

      const res = await initiate(token, {
        ...VALID_BODY,
        mime_type: 'application/pdf',
      }).expect(400);

      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
      expect(await videoCount()).toBe(0);
      expect(await listOpenUploads()).toEqual([]);
    });

    it('initiate-rejeita-tamanho-acima-do-teto', async () => {
      const token = await login();

      const tooBig = await initiate(token, {
        ...VALID_BODY,
        size_bytes: TEN_GIB + 1,
      }).expect(400);
      const atLimit = await initiate(token, {
        ...VALID_BODY,
        size_bytes: TEN_GIB,
      }).expect(201);

      expect((tooBig.body as ErrorBody).error).toBe('VALIDATION_ERROR');
      expect((atLimit.body as InitiateBody).upload.part_count).toBe(640);
    });

    it('initiate-rejeita-propriedade-desconhecida', async () => {
      const token = await login();

      const res = await initiate(token, {
        ...VALID_BODY,
        channel_id: 'qualquer',
      }).expect(400);

      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });

    it('initiate-sem-token', async () => {
      await initiate(undefined, VALID_BODY).expect(401);

      expect(await videoCount()).toBe(0);
    });

    it('initiate-usuario-sem-canal', async () => {
      const token = await login();
      await dataSource.query('DELETE FROM "channels"');

      const res = await initiate(token, VALID_BODY).expect(404);

      expect((res.body as ErrorBody).error).toBe('CHANNEL_NOT_FOUND');
      expect(await videoCount()).toBe(0);
      expect(await listOpenUploads()).toEqual([]);
    });
  });

  describe('Throttling', () => {
    it('initiate-fora-do-throttler', async () => {
      const token = await login();
      throttlerStorage.storage.clear();

      const statuses: number[] = [];
      for (let i = 0; i < 15; i++) {
        const res = await initiate(token, { ...VALID_BODY, size_bytes: 1 });
        statuses.push(res.status);
      }

      expect(statuses).toEqual(Array(15).fill(201));
    });
  });
});
