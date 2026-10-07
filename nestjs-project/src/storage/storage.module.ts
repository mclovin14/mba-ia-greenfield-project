import { S3Client } from '@aws-sdk/client-s3';
import { Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { S3_CLIENTS } from './storage.constants';
import { StorageBootstrapService } from './storage-bootstrap.service';
import { StorageService } from './storage.service';

const buildClient = (
  config: ConfigType<typeof storageConfig>,
  endpoint: string,
): S3Client =>
  new S3Client({
    region: config.region,
    endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });

@Module({
  providers: [
    {
      provide: S3_CLIENTS.INTERNAL,
      inject: [storageConfig.KEY],
      useFactory: (config: ConfigType<typeof storageConfig>) =>
        buildClient(config, config.endpoint),
    },
    {
      provide: S3_CLIENTS.PUBLIC,
      inject: [storageConfig.KEY],
      useFactory: (config: ConfigType<typeof storageConfig>) =>
        buildClient(config, config.publicEndpoint),
    },
    StorageService,
    StorageBootstrapService,
  ],
  exports: [StorageService],
})
export class StorageModule implements OnModuleDestroy {
  constructor(
    @Inject(S3_CLIENTS.INTERNAL) private readonly internalClient: S3Client,
    @Inject(S3_CLIENTS.PUBLIC) private readonly publicClient: S3Client,
  ) {}

  onModuleDestroy(): void {
    this.internalClient.destroy();
    this.publicClient.destroy();
  }
}
