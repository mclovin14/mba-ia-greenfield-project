import { Injectable } from '@nestjs/common';
import { STORAGE_BUCKETS } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import { THUMBNAIL_CONTENT_TYPE } from '../video-processing/video-processing.constants';
import { buildAttachmentDisposition } from './content-disposition';
import type { PresignedUrlResponseDto } from './dto/presigned-url-response.dto';
import {
  toVideoResponse,
  type VideoResponseDto,
} from './dto/video-response.dto';
import { type Video, VideoStatus } from './entities/video.entity';
import { VideoNotReadyException } from './exceptions/video-not-ready.exception';
import { videoOriginalKey, videoThumbnailKey } from './video-object-keys';
import {
  VIDEO_DOWNLOAD_URL_TTL_SECONDS,
  VIDEO_STREAM_URL_TTL_SECONDS,
  VIDEO_THUMBNAIL_URL_TTL_SECONDS,
} from './videos.constants';
import { VideosService } from './videos.service';

/** Delivers a video's media to the client as short-lived presigned URLs. */
@Injectable()
export class VideoPlaybackService {
  constructor(
    private readonly videosService: VideosService,
    private readonly storageService: StorageService,
  ) {}

  async getOwnedVideo(
    userId: string,
    publicId: string,
  ): Promise<VideoResponseDto> {
    const video = await this.videosService.findOwnedByPublicId(
      publicId,
      userId,
    );
    const thumbnailUrl =
      video.status === VideoStatus.Ready
        ? await this.storageService.presignGetObject(
            STORAGE_BUCKETS.THUMBNAILS,
            videoThumbnailKey(video.id),
            {
              client: 'public',
              expiresIn: VIDEO_THUMBNAIL_URL_TTL_SECONDS,
              responseContentType: THUMBNAIL_CONTENT_TYPE,
            },
          )
        : null;
    return toVideoResponse(video, thumbnailUrl);
  }

  /** Long-lived URL a `<video>` element can issue Range requests against. */
  async getStreamUrl(
    userId: string,
    publicId: string,
  ): Promise<PresignedUrlResponseDto> {
    const video = await this.findReadyVideo(userId, publicId);
    return this.presignOriginal(video, VIDEO_STREAM_URL_TTL_SECONDS, {
      responseContentType: video.mime_type,
    });
  }

  /** URL that makes the browser save the file under its original name. */
  async getDownloadUrl(
    userId: string,
    publicId: string,
  ): Promise<PresignedUrlResponseDto> {
    const video = await this.findReadyVideo(userId, publicId);
    return this.presignOriginal(video, VIDEO_DOWNLOAD_URL_TTL_SECONDS, {
      responseContentDisposition: buildAttachmentDisposition(
        video.original_filename,
      ),
    });
  }

  private async findReadyVideo(
    userId: string,
    publicId: string,
  ): Promise<Video> {
    const video = await this.videosService.findOwnedByPublicId(
      publicId,
      userId,
    );
    if (video.status !== VideoStatus.Ready) throw new VideoNotReadyException();
    return video;
  }

  private async presignOriginal(
    video: Video,
    expiresIn: number,
    response: {
      responseContentType?: string;
      responseContentDisposition?: string;
    },
  ): Promise<PresignedUrlResponseDto> {
    const signedAt = Date.now();
    const url = await this.storageService.presignGetObject(
      STORAGE_BUCKETS.VIDEOS,
      videoOriginalKey(video.id),
      { client: 'public', expiresIn, ...response },
    );
    return {
      url,
      expires_at: new Date(signedAt + expiresIn * 1000).toISOString(),
    };
  }
}
