import { Injectable } from '@nestjs/common';
import { MediaNotReadableError } from '../media/media.errors';
import { FfmpegService } from '../media/ffmpeg.service';
import type { MediaProbeResult } from '../media/media.types';
import { thumbnailTimestamp } from '../media/media.utils';
import { StorageObjectNotFoundError } from '../storage/storage.errors';
import { STORAGE_BUCKETS } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import { VideoStatus } from '../videos/entities/video.entity';
import { videoThumbnailKey } from '../videos/video-object-keys';
import { VideoProcessingErrorCode } from '../videos/videos.constants';
import { VideosService } from '../videos/videos.service';
import {
  THUMBNAIL_CONTENT_TYPE,
  VIDEO_SOURCE_URL_TTL_SECONDS,
} from './video-processing.constants';
import { VideoProcessingTerminalError } from './video-processing.errors';

export type VideoProcessingOutcome = 'ready' | 'skipped';

/**
 * Processing steps of the `process-video` contract. Delivery is
 * at-least-once, so every step is safe to repeat: a video that already left
 * `processing` is skipped, and the final transition is conditional.
 */
@Injectable()
export class VideoProcessingService {
  constructor(
    private readonly videosService: VideosService,
    private readonly storageService: StorageService,
    private readonly ffmpegService: FfmpegService,
  ) {}

  async process(videoId: string): Promise<VideoProcessingOutcome> {
    const video = await this.videosService.findById(videoId);
    if (video?.status !== VideoStatus.Processing) return 'skipped';

    const originalKey = video.original_key;
    await this.assertSourceExists(originalKey);
    const sourceUrl = await this.storageService.presignGetObject(
      STORAGE_BUCKETS.VIDEOS,
      originalKey,
      { client: 'internal', expiresIn: VIDEO_SOURCE_URL_TTL_SECONDS },
    );

    const probe = await this.probeVideo(sourceUrl);
    const thumbnail = await this.ffmpegService.extractFrame(
      sourceUrl,
      thumbnailTimestamp(probe.durationSeconds),
    );
    const thumbnailKey = videoThumbnailKey(videoId);
    await this.storageService.putObject(
      STORAGE_BUCKETS.THUMBNAILS,
      thumbnailKey,
      thumbnail,
      THUMBNAIL_CONTENT_TYPE,
    );

    const marked = await this.videosService.markReady(
      videoId,
      {
        duration_seconds: probe.durationSeconds,
        width: probe.video.width,
        height: probe.video.height,
        video_codec: probe.video.codec,
        audio_codec: probe.audioCodec,
        container_format: probe.formatName,
      },
      thumbnailKey,
    );
    return marked ? 'ready' : 'skipped';
  }

  private async assertSourceExists(key: string): Promise<void> {
    try {
      await this.storageService.headObject(STORAGE_BUCKETS.VIDEOS, key);
    } catch (error) {
      if (error instanceof StorageObjectNotFoundError) {
        throw new VideoProcessingTerminalError(
          VideoProcessingErrorCode.SOURCE_OBJECT_MISSING,
        );
      }
      throw error;
    }
  }

  /** AMB-5: unreadable media and media without a video stream are terminal. */
  private async probeVideo(
    sourceUrl: string,
  ): Promise<
    MediaProbeResult & { video: NonNullable<MediaProbeResult['video']> }
  > {
    let probe: MediaProbeResult;
    try {
      probe = await this.ffmpegService.probe(sourceUrl);
    } catch (error) {
      if (error instanceof MediaNotReadableError) {
        throw new VideoProcessingTerminalError(
          VideoProcessingErrorCode.NO_VIDEO_STREAM,
          error.message,
        );
      }
      throw error;
    }
    const { video } = probe;
    if (!video) {
      throw new VideoProcessingTerminalError(
        VideoProcessingErrorCode.NO_VIDEO_STREAM,
        'no video stream',
      );
    }
    return { ...probe, video };
  }
}
