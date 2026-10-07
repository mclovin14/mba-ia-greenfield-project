import type { VideoProcessingErrorCode } from '../videos/videos.constants';

/** A failure that retrying cannot fix: the job must end on this attempt. */
export class VideoProcessingTerminalError extends Error {
  constructor(
    readonly code: VideoProcessingErrorCode,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = this.constructor.name;
  }
}
