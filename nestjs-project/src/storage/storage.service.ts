import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import {
  LIST_PARTS_PAGE_SIZE,
  S3_CLIENTS,
  STORAGE_BUCKETS,
  STORAGE_ERROR_NAMES,
  type StorageBucket,
} from './storage.constants';
import {
  StorageInvalidPartsError,
  StorageObjectNotFoundError,
  StorageUploadNotFoundError,
} from './storage.errors';
import { StorageUnavailableException } from './exceptions/storage-unavailable.exception';

export interface StoragePart {
  partNumber: number;
  etag: string;
}

export interface StoredPart extends StoragePart {
  size: number;
}

export interface PresignGetObjectOptions {
  expiresIn: number;
  client: 'public' | 'internal';
  responseContentType?: string;
  responseContentDisposition?: string;
}

interface SdkError {
  name?: string;
  message?: string;
  $metadata?: { httpStatusCode?: number };
}

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);

  constructor(
    @Inject(S3_CLIENTS.INTERNAL) private readonly internalClient: S3Client,
    @Inject(S3_CLIENTS.PUBLIC) private readonly publicClient: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    try {
      const result = await this.internalClient.send(
        new CreateMultipartUploadCommand({
          Bucket: this.bucketName(STORAGE_BUCKETS.VIDEOS),
          Key: key,
          ContentType: contentType,
        }),
      );
      return result.UploadId!;
    } catch (error) {
      throw this.translate(error, 'createMultipartUpload', key);
    }
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn: number,
  ): Promise<string> {
    try {
      return await getSignedUrl(
        this.publicClient,
        new UploadPartCommand({
          Bucket: this.bucketName(STORAGE_BUCKETS.VIDEOS),
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
        }),
        { expiresIn },
      );
    } catch (error) {
      throw this.translate(error, 'presignUploadPart', key);
    }
  }

  async listParts(key: string, uploadId: string): Promise<StoredPart[]> {
    const parts: StoredPart[] = [];
    let marker: string | undefined;
    try {
      for (;;) {
        const page = await this.internalClient.send(
          new ListPartsCommand({
            Bucket: this.bucketName(STORAGE_BUCKETS.VIDEOS),
            Key: key,
            UploadId: uploadId,
            MaxParts: LIST_PARTS_PAGE_SIZE,
            PartNumberMarker: marker,
          }),
        );
        for (const part of page.Parts ?? []) {
          parts.push({
            partNumber: part.PartNumber!,
            etag: part.ETag!,
            size: part.Size ?? 0,
          });
        }
        if (!page.IsTruncated) return parts;
        marker = page.NextPartNumberMarker;
      }
    } catch (error) {
      throw this.translate(error, 'listParts', key);
    }
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: StoragePart[],
  ): Promise<void> {
    try {
      await this.internalClient.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucketName(STORAGE_BUCKETS.VIDEOS),
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts.map((part) => ({
              PartNumber: part.partNumber,
              ETag: part.etag,
            })),
          },
        }),
      );
    } catch (error) {
      throw this.translate(error, 'completeMultipartUpload', key, true);
    }
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.internalClient.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucketName(STORAGE_BUCKETS.VIDEOS),
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch (error) {
      throw this.translate(error, 'abortMultipartUpload', key);
    }
  }

  async headObject(
    bucket: StorageBucket,
    key: string,
  ): Promise<{ contentLength: number }> {
    try {
      const result = await this.internalClient.send(
        new HeadObjectCommand({ Bucket: this.bucketName(bucket), Key: key }),
      );
      return { contentLength: result.ContentLength ?? 0 };
    } catch (error) {
      throw this.translate(error, 'headObject', key);
    }
  }

  async deleteObject(bucket: StorageBucket, key: string): Promise<void> {
    try {
      await this.internalClient.send(
        new DeleteObjectCommand({ Bucket: this.bucketName(bucket), Key: key }),
      );
    } catch (error) {
      throw this.translate(error, 'deleteObject', key);
    }
  }

  async putObject(
    bucket: StorageBucket,
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    try {
      await this.internalClient.send(
        new PutObjectCommand({
          Bucket: this.bucketName(bucket),
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    } catch (error) {
      throw this.translate(error, 'putObject', key);
    }
  }

  async presignGetObject(
    bucket: StorageBucket,
    key: string,
    options: PresignGetObjectOptions,
  ): Promise<string> {
    const client =
      options.client === 'public' ? this.publicClient : this.internalClient;
    try {
      return await getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: this.bucketName(bucket),
          Key: key,
          ResponseContentType: options.responseContentType,
          ResponseContentDisposition: options.responseContentDisposition,
        }),
        { expiresIn: options.expiresIn },
      );
    } catch (error) {
      throw this.translate(error, 'presignGetObject', key);
    }
  }

  private bucketName(bucket: StorageBucket): string {
    return bucket === STORAGE_BUCKETS.VIDEOS
      ? this.config.videosBucket
      : this.config.thumbnailsBucket;
  }

  private translate(
    error: unknown,
    operation: string,
    key: string,
    isComplete = false,
  ): Error {
    const sdkError = (error ?? {}) as SdkError;
    const name = sdkError.name ?? '';
    const status = sdkError.$metadata?.httpStatusCode;

    if (this.matches(STORAGE_ERROR_NAMES.UPLOAD_NOT_FOUND, name)) {
      return new StorageUploadNotFoundError(key);
    }
    if (isComplete && this.matches(STORAGE_ERROR_NAMES.INVALID_PARTS, name)) {
      return new StorageInvalidPartsError(key, name);
    }
    if (
      this.matches(STORAGE_ERROR_NAMES.OBJECT_NOT_FOUND, name) ||
      status === 404
    ) {
      return new StorageObjectNotFoundError(key);
    }

    this.logger.error(
      `Storage ${operation} failed for key ${key}: ${name || 'UnknownError'} (status ${status ?? 'n/a'})`,
    );
    return new StorageUnavailableException();
  }

  private matches(names: readonly string[], name: string): boolean {
    return names.includes(name);
  }
}
