export const MEDIA_BINARIES = {
  FFPROBE: 'ffprobe',
  FFMPEG: 'ffmpeg',
} as const;

export const MEDIA_PROBE_TIMEOUT_MS = 60_000;
export const MEDIA_FRAME_TIMEOUT_MS = 120_000;

export const MEDIA_PROBE_MAX_OUTPUT_BYTES = 1024 * 1024;
export const MEDIA_FRAME_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/** Only the tail of stderr is kept, for log diagnostics. */
export const MEDIA_STDERR_MAX_BYTES = 2048;

export const THUMBNAIL_MAX_WIDTH = 640;
/** Videos shorter than this use the first frame as thumbnail (TD-05). */
export const THUMBNAIL_MIN_DURATION_FOR_OFFSET_SECONDS = 2;
export const THUMBNAIL_OFFSET_RATIO = 0.1;
