import {
  CreateBucketCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import {
  INCOMPLETE_UPLOAD_EXPIRY_DAYS,
  S3_CLIENTS,
  STORAGE_ERROR_NAMES,
} from './storage.constants';

@Injectable()
export class StorageBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StorageBootstrapService.name);

  constructor(
    @Inject(S3_CLIENTS.INTERNAL) private readonly client: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.ensureBucket(this.config.videosBucket);
    await this.ensureBucket(this.config.thumbnailsBucket);

    if (this.config.lifecycleRulesEnabled) {
      await this.client.send(
        new PutBucketLifecycleConfigurationCommand({
          Bucket: this.config.videosBucket,
          LifecycleConfiguration: {
            Rules: [
              {
                ID: 'abort-incomplete-multipart-uploads',
                Status: 'Enabled',
                Filter: { Prefix: '' },
                AbortIncompleteMultipartUpload: {
                  DaysAfterInitiation: INCOMPLETE_UPLOAD_EXPIRY_DAYS,
                },
              },
            ],
          },
        }),
      );
    }
  }

  private async ensureBucket(bucket: string): Promise<void> {
    try {
      await this.client.send(new CreateBucketCommand({ Bucket: bucket }));
      this.logger.log(`Bucket ${bucket} created`);
    } catch (error) {
      const name = (error as { name?: string }).name ?? '';
      if (
        !(STORAGE_ERROR_NAMES.BUCKET_EXISTS as readonly string[]).includes(name)
      ) {
        throw error;
      }
    }
  }
}
