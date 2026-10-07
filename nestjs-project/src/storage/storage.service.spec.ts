import {
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageUnavailableException } from './exceptions/storage-unavailable.exception';
import { S3_CLIENTS } from './storage.constants';
import {
  StorageInvalidPartsError,
  StorageObjectNotFoundError,
  StorageUploadNotFoundError,
} from './storage.errors';
import { StorageService } from './storage.service';

const config: ConfigType<typeof storageConfig> = {
  endpoint: 'http://minio:9000',
  publicEndpoint: 'http://localhost:9000',
  region: 'us-east-1',
  accessKeyId: 'test-key',
  secretAccessKey: 'test-secret-value',
  videosBucket: 'videos-bucket',
  thumbnailsBucket: 'thumbs-bucket',
  forcePathStyle: true,
  lifecycleRulesEnabled: false,
};

const buildClient = (endpoint: string): S3Client =>
  new S3Client({
    region: config.region,
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

const sdkError = (name: string, httpStatusCode: number): S3ServiceException =>
  new S3ServiceException({
    name,
    $fault: 'client',
    $metadata: { httpStatusCode },
    message: name,
  });

const sentInput = (
  spy: jest.SpyInstance,
  index: number,
): Record<string, unknown> =>
  (
    (spy.mock.calls as unknown[][])[index][0] as {
      input: Record<string, unknown>;
    }
  ).input;

const sentCommand = (spy: jest.SpyInstance, index: number): unknown =>
  (spy.mock.calls as unknown[][])[index][0];

describe('StorageService', () => {
  let service: StorageService;
  let internalClient: S3Client;
  let publicClient: S3Client;
  let internalSend: jest.SpyInstance;
  let publicSend: jest.SpyInstance;

  beforeEach(async () => {
    internalClient = buildClient(config.endpoint);
    publicClient = buildClient(config.publicEndpoint);
    internalSend = jest.spyOn(internalClient, 'send');
    publicSend = jest.spyOn(publicClient, 'send');

    const module = await Test.createTestingModule({
      providers: [
        StorageService,
        { provide: S3_CLIENTS.INTERNAL, useValue: internalClient },
        { provide: S3_CLIENTS.PUBLIC, useValue: publicClient },
        { provide: storageConfig.KEY, useValue: config },
      ],
    }).compile();

    service = module.get(StorageService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    internalClient.destroy();
    publicClient.destroy();
  });

  describe('error translation', () => {
    it('should translate NoSuchUpload into StorageUploadNotFoundError', async () => {
      internalSend.mockRejectedValue(sdkError('NoSuchUpload', 404));

      await expect(service.listParts('k', 'u')).rejects.toBeInstanceOf(
        StorageUploadNotFoundError,
      );
    });

    it.each([
      ['NoSuchKey', 404],
      ['NotFound', 404],
      ['UnknownError', 404],
    ])(
      'should translate %s (status %s) into StorageObjectNotFoundError',
      async (name, status) => {
        internalSend.mockRejectedValue(sdkError(name, status));

        await expect(service.headObject('videos', 'k')).rejects.toBeInstanceOf(
          StorageObjectNotFoundError,
        );
      },
    );

    it.each(['EntityTooSmall', 'InvalidPart', 'InvalidPartOrder'])(
      'should translate %s on complete into StorageInvalidPartsError',
      async (name) => {
        internalSend.mockRejectedValue(sdkError(name, 400));

        await expect(
          service.completeMultipartUpload('k', 'u', [
            { partNumber: 1, etag: '"e"' },
          ]),
        ).rejects.toBeInstanceOf(StorageInvalidPartsError);
      },
    );

    it('should translate any other error into StorageUnavailableException and log without credentials', async () => {
      const logSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      internalSend.mockRejectedValue(sdkError('InternalError', 500));

      await expect(
        service.createMultipartUpload('k', 'video/mp4'),
      ).rejects.toBeInstanceOf(StorageUnavailableException);

      const logged = logSpy.mock.calls.flat().join(' ');
      expect(logged).toContain('InternalError');
      expect(logged).not.toContain(config.accessKeyId);
      expect(logged).not.toContain(config.secretAccessKey);
    });

    it('should translate a network error into StorageUnavailableException', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      internalSend.mockRejectedValue(
        Object.assign(new Error('connect ECONNREFUSED'), {
          name: 'ECONNREFUSED',
        }),
      );

      await expect(
        service.deleteObject('thumbnails', 'k'),
      ).rejects.toBeInstanceOf(StorageUnavailableException);
    });
  });

  describe('client selection', () => {
    it('should sign upload part URLs with the public endpoint', async () => {
      const url = await service.presignUploadPart('videos/a.mp4', 'u1', 3, 60);

      const parsed = new URL(url);
      expect(parsed.host).toBe('localhost:9000');
      expect(parsed.pathname).toBe('/videos-bucket/videos/a.mp4');
      expect(parsed.searchParams.get('partNumber')).toBe('3');
      expect(parsed.searchParams.get('uploadId')).toBe('u1');
      expect(parsed.searchParams.get('X-Amz-Expires')).toBe('60');
    });

    it.each([
      ['public', 'localhost:9000'],
      ['internal', 'minio:9000'],
    ] as const)(
      'should sign GET object URLs for the %s client with host %s',
      async (client, host) => {
        const url = await service.presignGetObject('thumbnails', 't.jpg', {
          expiresIn: 120,
          client,
        });

        const parsed = new URL(url);
        expect(parsed.host).toBe(host);
        expect(parsed.pathname).toBe('/thumbs-bucket/t.jpg');
      },
    );

    it('should send object and multipart commands through the internal client', async () => {
      internalSend.mockResolvedValue({ UploadId: 'u1', ContentLength: 10 });

      await service.createMultipartUpload('k', 'video/mp4');
      await service.headObject('videos', 'k');

      expect(publicSend).not.toHaveBeenCalled();
      expect(sentCommand(internalSend, 0)).toBeInstanceOf(
        CreateMultipartUploadCommand,
      );
      expect(sentCommand(internalSend, 1)).toBeInstanceOf(HeadObjectCommand);
      expect(sentInput(internalSend, 1)).toEqual({
        Bucket: 'videos-bucket',
        Key: 'k',
      });
    });

    it('should map parts to the CompleteMultipartUpload payload', async () => {
      internalSend.mockResolvedValue({});

      await service.completeMultipartUpload('k', 'u', [
        { partNumber: 1, etag: '"a"' },
        { partNumber: 2, etag: '"b"' },
      ]);

      expect(sentInput(internalSend, 0).MultipartUpload).toEqual({
        Parts: [
          { PartNumber: 1, ETag: '"a"' },
          { PartNumber: 2, ETag: '"b"' },
        ],
      });
    });
  });

  describe('listParts', () => {
    it('should paginate with PartNumberMarker until IsTruncated is false', async () => {
      internalSend
        .mockResolvedValueOnce({
          Parts: [{ PartNumber: 1, ETag: '"a"', Size: 5 }],
          IsTruncated: true,
          NextPartNumberMarker: '1',
        })
        .mockResolvedValueOnce({
          Parts: [{ PartNumber: 2, ETag: '"b"', Size: 3 }],
          IsTruncated: false,
        });

      const parts = await service.listParts('k', 'u');

      expect(parts).toEqual([
        { partNumber: 1, etag: '"a"', size: 5 },
        { partNumber: 2, etag: '"b"', size: 3 },
      ]);
      expect(internalSend).toHaveBeenCalledTimes(2);
      expect(sentInput(internalSend, 0).PartNumberMarker).toBeUndefined();
      expect(sentInput(internalSend, 1).PartNumberMarker).toBe('1');
    });
  });
});
