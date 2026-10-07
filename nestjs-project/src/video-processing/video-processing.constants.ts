import type { JobsOptions } from 'bullmq';

export const VIDEO_PROCESSING_QUEUE = 'video-processing';

export const PROCESS_VIDEO_JOB = 'process-video';

export const videoProcessingJobId = (videoId: string): string =>
  `video-${videoId}`;

export const VIDEO_PROCESSING_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 86400 },
} as const satisfies JobsOptions;

/** TTL of the internal presigned GET that ffprobe/ffmpeg read the original from. */
export const VIDEO_SOURCE_URL_TTL_SECONDS = 3600;

export const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';
