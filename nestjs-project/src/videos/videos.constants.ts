export const PUBLIC_ID_BYTES = 8;
export const PUBLIC_ID_COLUMN = 'public_id';
export const PUBLIC_ID_MAX_ATTEMPTS = 5;
export const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

export const VIDEO_TITLE_MAX_LENGTH = 100;
export const DEFAULT_VIDEO_TITLE = 'Untitled';
export const VIDEO_FILENAME_MAX_LENGTH = 255;

export const VIDEO_ALLOWED_MIME_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
] as const;
export type VideoMimeType = (typeof VIDEO_ALLOWED_MIME_TYPES)[number];

export const VIDEO_MAX_SIZE_BYTES = 10 * 1024 ** 3;
export const VIDEO_UPLOAD_PART_SIZE_BYTES = 16 * 1024 ** 2;
export const VIDEO_PART_URL_TTL_SECONDS = 3600;
export const VIDEO_MAX_PART_URLS_PER_REQUEST = 100;
export const VIDEO_THUMBNAIL_URL_TTL_SECONDS = 900;
export const VIDEO_STREAM_URL_TTL_SECONDS = 21600;
export const VIDEO_DOWNLOAD_URL_TTL_SECONDS = 900;

export const VideoProcessingErrorCode = {
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  SOURCE_OBJECT_MISSING: 'SOURCE_OBJECT_MISSING',
  NO_VIDEO_STREAM: 'NO_VIDEO_STREAM',
  PROCESSING_FAILED: 'PROCESSING_FAILED',
} as const;
export type VideoProcessingErrorCode =
  (typeof VideoProcessingErrorCode)[keyof typeof VideoProcessingErrorCode];

export function videoPartCount(sizeBytes: number): number {
  return Math.ceil(sizeBytes / VIDEO_UPLOAD_PART_SIZE_BYTES);
}
