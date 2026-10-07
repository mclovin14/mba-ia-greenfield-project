import {
  CreateBucketCommand,
  PutBucketLifecycleConfigurationCommand,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import type { ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { S3_CLIENTS } from './storage.constants';
import { StorageBootstrapService } from './storage-bootstrap.service';

const baseConfig: ConfigType<typeof storageConfig> = {
  endpoint: 'http://minio:9000',
  publicEndpoint: 'http://localhost:9000',
  region: 'us-east-1',
  accessKeyId: 'k',
  secretAccessKey: 's',
  videosBucket: 'videos',
  thumbnailsBucket: 'thumbnails',
  forcePathStyle: true,
  lifecycleRulesEnabled: false,
};

const bucketError = (name: string): S3ServiceException =>
  new S3ServiceException({
    name,
    $fault: 'client',
    $metadata: { httpStatusCode: 409 },
    message: name,
  });

describe('StorageBootstrapService', () => {
  const send = jest.fn();

  const build = async (
    lifecycleRulesEnabled: boolean,
  ): Promise<StorageBootstrapService> => {
    const module = await Test.createTestingModule({
      providers: [
        StorageBootstrapService,
        { provide: S3_CLIENTS.INTERNAL, useValue: { send } },
        {
          provide: storageConfig.KEY,
          useValue: { ...baseConfig, lifecycleRulesEnabled },
        },
      ],
    }).compile();
    return module.get(StorageBootstrapService);
  };

  const sentCommands = (): unknown[] =>
    (send.mock.calls as unknown[][]).map((call) => call[0]);

  beforeEach(() => {
    send.mockReset();
    send.mockResolvedValue({});
  });

  it('should create the videos and thumbnails buckets', async () => {
    const service = await build(false);

    await service.onApplicationBootstrap();

    const buckets = sentCommands()
      .filter((c) => c instanceof CreateBucketCommand)
      .map((c) => c.input.Bucket);
    expect(buckets).toEqual(['videos', 'thumbnails']);
  });

  it('should not send a lifecycle rule when the flag is false', async () => {
    const service = await build(false);

    await service.onApplicationBootstrap();

    expect(
      sentCommands().some(
        (c) => c instanceof PutBucketLifecycleConfigurationCommand,
      ),
    ).toBe(false);
  });

  it('should send AbortIncompleteMultipartUpload on the videos bucket when the flag is true', async () => {
    const service = await build(true);

    await service.onApplicationBootstrap();

    const lifecycle = sentCommands().find(
      (c) => c instanceof PutBucketLifecycleConfigurationCommand,
    ) as PutBucketLifecycleConfigurationCommand;
    expect(lifecycle.input.Bucket).toBe('videos');
    expect(
      lifecycle.input.LifecycleConfiguration?.Rules?.[0]
        .AbortIncompleteMultipartUpload,
    ).toEqual({ DaysAfterInitiation: 1 });
  });

  it.each(['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'])(
    'should treat %s as success',
    async (name) => {
      send.mockRejectedValue(bucketError(name));
      const service = await build(false);

      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    },
  );

  it('should propagate any other bucket creation error', async () => {
    send.mockRejectedValue(bucketError('AccessDenied'));
    const service = await build(false);

    await expect(service.onApplicationBootstrap()).rejects.toThrow(
      'AccessDenied',
    );
  });
});
