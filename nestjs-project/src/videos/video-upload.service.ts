import { Injectable } from '@nestjs/common';
import { ChannelsService } from '../channels/channels.service';
import { STORAGE_BUCKETS } from '../storage/storage.constants';
import {
  StorageInvalidPartsError,
  StorageObjectNotFoundError,
  StorageUploadNotFoundError,
} from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import { VideoProcessingQueue } from '../video-processing/video-processing.queue';
import type { InitiateUploadDto } from './dto/initiate-upload.dto';
import type { InitiateUploadResponseDto } from './dto/initiate-upload-response.dto';
import type { PartUrlsResponseDto } from './dto/part-urls-response.dto';
import type { UploadedPartsResponseDto } from './dto/uploaded-parts-response.dto';
import {
  toVideoResponse,
  type VideoResponseDto,
} from './dto/video-response.dto';
import { type Video, VideoStatus } from './entities/video.entity';
import { InvalidUploadStateException } from './exceptions/invalid-upload-state.exception';
import { PartNumberOutOfRangeException } from './exceptions/part-number-out-of-range.exception';
import { UploadIncompleteException } from './exceptions/upload-incomplete.exception';
import { VideoFileTooLargeException } from './exceptions/video-file-too-large.exception';
import { VideoNotFoundException } from './exceptions/video-not-found.exception';
import { deriveDefaultTitle } from './video-title';
import {
  VIDEO_MAX_PART_URLS_PER_REQUEST,
  VIDEO_MAX_SIZE_BYTES,
  VIDEO_PART_URL_TTL_SECONDS,
  VIDEO_UPLOAD_PART_SIZE_BYTES,
  VideoProcessingErrorCode,
  videoPartCount,
} from './videos.constants';
import { VideosService } from './videos.service';

type UploadingVideo = Video & { upload_id: string };

@Injectable()
export class VideoUploadService {
  constructor(
    private readonly channelsService: ChannelsService,
    private readonly videosService: VideosService,
    private readonly storageService: StorageService,
    private readonly videoProcessingQueue: VideoProcessingQueue,
  ) {}

  async initiate(
    userId: string,
    dto: InitiateUploadDto,
  ): Promise<InitiateUploadResponseDto> {
    const channel = await this.channelsService.findByUserId(userId);
    const video = await this.videosService.createDraft({
      channelId: channel.id,
      title: dto.title ?? deriveDefaultTitle(dto.filename),
      originalFilename: dto.filename,
      mimeType: dto.mime_type,
      sizeBytes: dto.size_bytes,
    });

    let uploadId: string;
    try {
      uploadId = await this.storageService.createMultipartUpload(
        video.original_key,
        dto.mime_type,
      );
    } catch (err) {
      // Compensation: never leave a draft without an upload_id behind.
      await this.videosService.delete(video.id);
      throw err;
    }
    await this.videosService.setUploadId(video.id, uploadId);

    return {
      video: toVideoResponse(video, null),
      upload: {
        part_size_bytes: VIDEO_UPLOAD_PART_SIZE_BYTES,
        part_count: videoPartCount(dto.size_bytes),
        max_part_urls_per_request: VIDEO_MAX_PART_URLS_PER_REQUEST,
      },
    };
  }

  async presignPartUrls(
    userId: string,
    publicId: string,
    partNumbers: number[],
  ): Promise<PartUrlsResponseDto> {
    const video = await this.findUploading(userId, publicId);
    const partCount = videoPartCount(video.size_bytes);
    if (partNumbers.some((n) => n > partCount)) {
      throw new PartNumberOutOfRangeException(partCount);
    }

    const signedAt = Date.now();
    const key = video.original_key;
    const parts = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        part_number: partNumber,
        url: await this.storageService.presignUploadPart(
          key,
          video.upload_id,
          partNumber,
          VIDEO_PART_URL_TTL_SECONDS,
        ),
      })),
    );

    return {
      parts,
      expires_at: new Date(
        signedAt + VIDEO_PART_URL_TTL_SECONDS * 1000,
      ).toISOString(),
    };
  }

  async listUploadedParts(
    userId: string,
    publicId: string,
  ): Promise<UploadedPartsResponseDto> {
    const video = await this.findUploading(userId, publicId);
    const stored = await this.storageService.listParts(
      video.original_key,
      video.upload_id,
    );

    return {
      parts: stored
        .map((part) => ({
          part_number: part.partNumber,
          size_bytes: part.size,
          etag: part.etag,
        }))
        .sort((a, b) => a.part_number - b.part_number),
    };
  }

  /**
   * Order closes the race with a concurrent complete: the conditional delete
   * comes first, and the final DeleteObject removes bytes a concurrent
   * complete may already have assembled.
   */
  async cancel(userId: string, publicId: string): Promise<void> {
    const video = await this.videosService.findOwnedByPublicId(
      publicId,
      userId,
    );
    const deleted = await this.videosService.deleteIfStatus(
      video.id,
      VideoStatus.Uploading,
    );
    if (!deleted) throw new InvalidUploadStateException();

    const key = video.original_key;
    if (video.upload_id !== null) {
      try {
        await this.storageService.abortMultipartUpload(key, video.upload_id);
      } catch (err) {
        // Already aborted or completed: the DeleteObject below still runs.
        if (!(err instanceof StorageUploadNotFoundError)) throw err;
      }
    }
    await this.storageService.deleteObject(STORAGE_BUCKETS.VIDEOS, key);
  }

  /**
   * Idempotent under client retries and safe against a concurrent complete or
   * cancel: every status change goes through a conditional transition.
   */
  async complete(userId: string, publicId: string): Promise<VideoResponseDto> {
    const video = await this.videosService.findOwnedByPublicId(
      publicId,
      userId,
    );
    if (video.status === VideoStatus.Processing) {
      // A retried complete, or a previous enqueue that failed after the flip.
      return this.enqueueProcessing(video.id);
    }
    if (video.status !== VideoStatus.Uploading || video.upload_id === null) {
      throw new InvalidUploadStateException();
    }

    const key = video.original_key;
    await this.assembleObject(key, video as UploadingVideo);

    const { contentLength } = await this.storageService.headObject(
      STORAGE_BUCKETS.VIDEOS,
      key,
    );
    if (contentLength > VIDEO_MAX_SIZE_BYTES) {
      await this.storageService.deleteObject(STORAGE_BUCKETS.VIDEOS, key);
      await this.videosService.transitionStatus(
        video.id,
        VideoStatus.Uploading,
        {
          status: VideoStatus.Failed,
          processing_error: VideoProcessingErrorCode.FILE_TOO_LARGE,
          upload_id: null,
        },
      );
      throw new VideoFileTooLargeException(VIDEO_MAX_SIZE_BYTES);
    }

    const moved = await this.videosService.transitionStatus(
      video.id,
      VideoStatus.Uploading,
      {
        status: VideoStatus.Processing,
        size_bytes: contentLength,
        upload_id: null,
      },
    );
    if (!moved) {
      const current = await this.videosService.findById(video.id);
      if (current === null) {
        // Cancelled concurrently: drop the bytes this complete assembled.
        await this.storageService.deleteObject(STORAGE_BUCKETS.VIDEOS, key);
        throw new VideoNotFoundException();
      }
      if (current.status !== VideoStatus.Processing) {
        throw new InvalidUploadStateException();
      }
    }

    return this.enqueueProcessing(video.id);
  }

  private async assembleObject(
    key: string,
    video: UploadingVideo,
  ): Promise<void> {
    const stored = await this.storageService.listParts(key, video.upload_id);
    const partCount = videoPartCount(video.size_bytes);
    const numbers = new Set(stored.map((part) => part.partNumber));
    const isComplete =
      numbers.size === partCount &&
      [...numbers].every((n) => n >= 1 && n <= partCount);
    if (!isComplete) throw new UploadIncompleteException();

    const parts = [...stored]
      .sort((a, b) => a.partNumber - b.partNumber)
      .map(({ partNumber, etag }) => ({ partNumber, etag }));
    try {
      await this.storageService.completeMultipartUpload(
        key,
        video.upload_id,
        parts,
      );
    } catch (err) {
      if (err instanceof StorageInvalidPartsError) {
        throw new UploadIncompleteException();
      }
      if (!(err instanceof StorageUploadNotFoundError)) throw err;
      // A previous complete may have finished on the storage side.
      await this.assertObjectExists(key);
    }
  }

  private async assertObjectExists(key: string): Promise<void> {
    try {
      await this.storageService.headObject(STORAGE_BUCKETS.VIDEOS, key);
    } catch (err) {
      if (err instanceof StorageObjectNotFoundError) {
        throw new UploadIncompleteException();
      }
      throw err;
    }
  }

  private async enqueueProcessing(id: string): Promise<VideoResponseDto> {
    await this.videoProcessingQueue.enqueue(id);
    const current = await this.videosService.findById(id);
    if (current === null) throw new VideoNotFoundException();
    return toVideoResponse(current, null);
  }

  private async findUploading(
    userId: string,
    publicId: string,
  ): Promise<UploadingVideo> {
    const video = await this.videosService.findOwnedByPublicId(
      publicId,
      userId,
    );
    if (video.status !== VideoStatus.Uploading || video.upload_id === null) {
      throw new InvalidUploadStateException();
    }
    return video as UploadingVideo;
  }
}
