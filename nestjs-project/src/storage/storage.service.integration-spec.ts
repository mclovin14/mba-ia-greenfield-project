import { HeadBucketCommand, type S3Client } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import storageConfig from '../config/storage.config';
import {
  createTestS3Client,
  emptyBucket,
  requestPresigned,
} from '../test/presigned-request';
import { StorageUploadNotFoundError } from './storage.errors';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

// Dedicated buckets so the suite never touches development data.
const VIDEOS_BUCKET = 'it-storage-videos';
const THUMBNAILS_BUCKET = 'it-storage-thumbnails';
const MIN_PART_SIZE = 5 * 1024 * 1024;

describe('StorageService × MinIO', () => {
  let module: TestingModule;
  let service: StorageService;
  let s3: S3Client;
  const originalEnv = { ...process.env };

  const bootModule = async (): Promise<TestingModule> => {
    const testingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    await testingModule.init();
    return testingModule;
  };

  beforeAll(async () => {
    process.env.S3_VIDEOS_BUCKET = VIDEOS_BUCKET;
    process.env.S3_THUMBNAILS_BUCKET = THUMBNAILS_BUCKET;
    s3 = createTestS3Client();
    module = await bootModule();
    service = module.get(StorageService);
  });

  afterEach(async () => {
    await emptyBucket(VIDEOS_BUCKET);
    await emptyBucket(THUMBNAILS_BUCKET);
  });

  afterAll(async () => {
    await module.close();
    s3.destroy();
    process.env = originalEnv;
  });

  const uploadSmallObject = async (key: string, body: Buffer) => {
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    const url = await service.presignUploadPart(key, uploadId, 1, 300);
    const put = await requestPresigned(url, { method: 'PUT', body });
    await service.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag: put.headers.etag as string },
    ]);
  };

  describe('bucket bootstrap', () => {
    it('should create both buckets and tolerate a second boot', async () => {
      const secondBoot = await bootModule();
      await secondBoot.close();

      for (const bucket of [VIDEOS_BUCKET, THUMBNAILS_BUCKET]) {
        await expect(
          s3.send(new HeadBucketCommand({ Bucket: bucket })),
        ).resolves.toBeDefined();
      }
    });
  });

  describe('multipart upload', () => {
    it('should round-trip create → presigned PUT → listParts → complete → head', async () => {
      const key = `videos/${randomUUID()}/original`;
      const parts = [Buffer.alloc(MIN_PART_SIZE, 1), Buffer.alloc(1234, 2)];

      const uploadId = await service.createMultipartUpload(key, 'video/mp4');
      const etags: string[] = [];
      for (const [index, body] of parts.entries()) {
        const url = await service.presignUploadPart(
          key,
          uploadId,
          index + 1,
          300,
        );
        expect(new URL(url).host).toBe(
          new URL(process.env.S3_PUBLIC_ENDPOINT!).host,
        );

        const res = await requestPresigned(url, { method: 'PUT', body });

        expect(res.status).toBe(200);
        expect(res.headers.etag).toBeDefined();
        etags.push(res.headers.etag as string);
      }

      const listed = await service.listParts(key, uploadId);
      expect(listed).toEqual([
        { partNumber: 1, etag: etags[0], size: parts[0].length },
        { partNumber: 2, etag: etags[1], size: parts[1].length },
      ]);

      await service.completeMultipartUpload(key, uploadId, listed);

      const head = await service.headObject('videos', key);
      expect(head.contentLength).toBe(parts[0].length + parts[1].length);
    });

    it('should translate NoSuchUpload after abort', async () => {
      const key = `videos/${randomUUID()}/original`;
      const uploadId = await service.createMultipartUpload(key, 'video/mp4');

      await service.abortMultipartUpload(key, uploadId);

      await expect(service.listParts(key, uploadId)).rejects.toBeInstanceOf(
        StorageUploadNotFoundError,
      );
    });
  });

  describe('presigned GET', () => {
    const body = Buffer.from('0123456789abcdef');

    it('should serve a byte range with 206 and Content-Range', async () => {
      const key = `videos/${randomUUID()}/original`;
      await uploadSmallObject(key, body);
      const url = await service.presignGetObject('videos', key, {
        expiresIn: 300,
        client: 'public',
      });

      const res = await requestPresigned(url, {
        method: 'GET',
        headers: { range: 'bytes=0-4' },
      });

      expect(res.status).toBe(206);
      expect(res.headers['content-range']).toBe(`bytes 0-4/${body.length}`);
      expect(res.body.toString()).toBe('01234');
    });

    it('should honor ResponseContentDisposition and ResponseContentType', async () => {
      const key = `videos/${randomUUID()}/original`;
      await uploadSmallObject(key, body);
      const url = await service.presignGetObject('videos', key, {
        expiresIn: 300,
        client: 'public',
        responseContentType: 'video/mp4',
        responseContentDisposition: 'attachment; filename="clip.mp4"',
      });

      const res = await requestPresigned(url, { method: 'GET' });

      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="clip.mp4"',
      );
      expect(res.headers['content-type']).toBe('video/mp4');
    });

    it('should sign internal URLs with the S3_ENDPOINT host and serve them', async () => {
      const key = `thumbs/${randomUUID()}.jpg`;
      await service.putObject('thumbnails', key, body, 'image/jpeg');
      const url = await service.presignGetObject('thumbnails', key, {
        expiresIn: 300,
        client: 'internal',
      });

      expect(new URL(url).host).toBe(new URL(process.env.S3_ENDPOINT!).host);
      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer())).toEqual(body);
    });
  });
});
