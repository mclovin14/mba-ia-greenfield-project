import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import storageConfig from '../config/storage.config';
import { emptyBucket, requestPresigned } from '../test/presigned-request';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const VIDEOS_BUCKET = 'it-cors-videos';
const THUMBNAILS_BUCKET = 'it-cors-thumbnails';
const ALLOWED_ORIGIN =
  process.env.STORAGE_CORS_ALLOWED_ORIGINS ?? 'http://localhost:3001';
const DISALLOWED_ORIGIN = 'http://evil.example.com';

describe('MinIO CORS', () => {
  let module: TestingModule;
  let service: StorageService;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    process.env.S3_VIDEOS_BUCKET = VIDEOS_BUCKET;
    process.env.S3_THUMBNAILS_BUCKET = THUMBNAILS_BUCKET;
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    await module.init();
    service = module.get(StorageService);
  });

  afterAll(async () => {
    await emptyBucket(VIDEOS_BUCKET);
    await emptyBucket(THUMBNAILS_BUCKET);
    await module.close();
    process.env = originalEnv;
  });

  const preflight = (url: string, origin: string, method: 'PUT' | 'GET') =>
    requestPresigned(url, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': method,
        'access-control-request-headers': 'content-type',
      },
    });

  const presignPart = async (): Promise<string> => {
    const key = `videos/${randomUUID()}/original`;
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    return service.presignUploadPart(key, uploadId, 1, 300);
  };

  it.each(['PUT', 'GET'] as const)(
    'should allow a %s preflight from the configured origin',
    async (method) => {
      const url = await presignPart();

      const res = await preflight(url, ALLOWED_ORIGIN, method);

      expect([200, 204]).toContain(res.status);
      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
      expect(
        String(res.headers['access-control-allow-methods']).toUpperCase(),
      ).toContain(method);
    },
  );

  it.each(['PUT', 'GET'] as const)(
    'should not grant a %s preflight to a disallowed origin',
    async (method) => {
      const url = await presignPart();

      const res = await preflight(url, DISALLOWED_ORIGIN, method);

      expect(res.headers['access-control-allow-origin']).not.toBe(
        DISALLOWED_ORIGIN,
      );
      expect(res.headers['access-control-allow-origin']).not.toBe('*');
    },
  );

  it('should expose ETag on the actual cross-origin PUT', async () => {
    const url = await presignPart();

    const res = await requestPresigned(url, {
      method: 'PUT',
      body: Buffer.from('cors-part'),
      headers: { origin: ALLOWED_ORIGIN },
    });

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(
      String(res.headers['access-control-expose-headers']).toLowerCase(),
    ).toContain('etag');
  });
});
