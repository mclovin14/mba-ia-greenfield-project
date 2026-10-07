import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { isPgUniqueViolationOnColumn } from '../common/database/pg-errors';
import { Video, VideoStatus } from './entities/video.entity';
import { generatePublicId } from './public-id';
import { VideoAccessPolicy } from './video-access.policy';
import { videoOriginalKey } from './video-object-keys';
import {
  PUBLIC_ID_COLUMN,
  PUBLIC_ID_MAX_ATTEMPTS,
  type VideoProcessingErrorCode,
} from './videos.constants';

export interface CreateVideoDraftInput {
  channelId: string;
  title: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
}

/** Columns a status transition may set alongside the new status. */
export type VideoStatusPatch = { status: VideoStatus } & Partial<
  Pick<
    Video,
    | 'size_bytes'
    | 'upload_id'
    | 'processing_error'
    | 'duration_seconds'
    | 'width'
    | 'height'
    | 'video_codec'
    | 'audio_codec'
    | 'container_format'
    | 'thumbnail_key'
  >
>;

/** Technical metadata extracted by the worker (AMB-2). */
export type VideoMetadata = Required<
  Pick<
    VideoStatusPatch,
    | 'duration_seconds'
    | 'width'
    | 'height'
    | 'video_codec'
    | 'audio_codec'
    | 'container_format'
  >
>;

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly accessPolicy: VideoAccessPolicy,
  ) {}

  /**
   * Inserts outside a transaction on purpose: in Postgres a unique violation
   * aborts the current transaction, which would make the retry impossible.
   */
  async createDraft(input: CreateVideoDraftInput): Promise<Video> {
    for (let attempt = 1; attempt <= PUBLIC_ID_MAX_ATTEMPTS; attempt++) {
      // The id is generated here so the original's storage key is persisted
      // with the row instead of being filled in by a second write.
      const id = randomUUID();
      const video = this.videoRepository.create({
        id,
        original_key: videoOriginalKey(id),
        public_id: generatePublicId(),
        channel_id: input.channelId,
        title: input.title,
        description: null,
        original_filename: input.originalFilename,
        mime_type: input.mimeType,
        size_bytes: input.sizeBytes,
      });

      try {
        await this.videoRepository.insert(video);
        return video;
      } catch (err) {
        if (!isPgUniqueViolationOnColumn(err, PUBLIC_ID_COLUMN)) throw err;
      }
    }

    throw new Error(
      `public_id collision could not be resolved after ${PUBLIC_ID_MAX_ATTEMPTS} attempts`,
    );
  }

  async setUploadId(id: string, uploadId: string): Promise<void> {
    await this.videoRepository.update({ id }, { upload_id: uploadId });
  }

  async delete(id: string): Promise<void> {
    await this.videoRepository.delete({ id });
  }

  async findById(id: string): Promise<Video | null> {
    return this.videoRepository.findOneBy({ id });
  }

  /**
   * The only way to change `status`: a conditional update that returns false
   * when the row left `from` concurrently (or no longer exists).
   */
  async transitionStatus(
    id: string,
    from: VideoStatus,
    patch: VideoStatusPatch,
  ): Promise<boolean> {
    const result = await this.videoRepository.update(
      { id, status: from },
      patch,
    );
    return (result.affected ?? 0) > 0;
  }

  /** processing → ready; false when the row already left processing. */
  async markReady(
    id: string,
    metadata: VideoMetadata,
    thumbnailKey: string,
  ): Promise<boolean> {
    return this.transitionStatus(id, VideoStatus.Processing, {
      status: VideoStatus.Ready,
      ...metadata,
      thumbnail_key: thumbnailKey,
      processing_error: null,
    });
  }

  /** processing → failed; false when the row already left processing. */
  async markFailed(
    id: string,
    code: VideoProcessingErrorCode,
  ): Promise<boolean> {
    return this.transitionStatus(id, VideoStatus.Processing, {
      status: VideoStatus.Failed,
      processing_error: code,
    });
  }

  /** Conditional delete: returns false when the row left `status` concurrently. */
  async deleteIfStatus(id: string, status: VideoStatus): Promise<boolean> {
    const result = await this.videoRepository.delete({ id, status });
    return (result.affected ?? 0) > 0;
  }

  async findOwnedByPublicId(publicId: string, userId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId },
      relations: { channel: true },
    });
    this.accessPolicy.assertOwner(video, userId);
    return video;
  }
}
