import { Injectable } from '@nestjs/common';
import type { Video } from './entities/video.entity';
import { VideoNotFoundException } from './exceptions/video-not-found.exception';

/**
 * Single place that compares video ownership. A non-owner gets the same
 * VIDEO_NOT_FOUND as an unknown video, so existence is never leaked.
 * Expects `video.channel` to be loaded.
 */
@Injectable()
export class VideoAccessPolicy {
  assertOwner(video: Video | null, userId: string): asserts video is Video {
    if (video === null || video.channel.user_id !== userId) {
      throw new VideoNotFoundException();
    }
  }
}
