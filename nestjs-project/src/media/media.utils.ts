import {
  THUMBNAIL_MIN_DURATION_FOR_OFFSET_SECONDS,
  THUMBNAIL_OFFSET_RATIO,
} from './media.constants';
import type { MediaProbeResult, ProbeOutput } from './media.types';

/**
 * Maps ffprobe JSON to the metadata the domain stores (AMB-2), using the
 * first video and the first audio stream.
 */
export function parseProbeOutput(
  output: ProbeOutput & { format: { format_name: string } },
): MediaProbeResult {
  const streams = output.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  const duration = Number.parseFloat(output.format.duration ?? '');

  return {
    durationSeconds: Number.isFinite(duration) ? duration : null,
    formatName: output.format.format_name,
    video:
      video?.width && video.height && video.codec_name
        ? { width: video.width, height: video.height, codec: video.codec_name }
        : null,
    audioCodec: audio?.codec_name ?? null,
  };
}

/** TD-05: 10% into the video, or the first frame for very short videos. */
export function thumbnailTimestamp(durationSeconds: number | null): number {
  if (
    durationSeconds === null ||
    durationSeconds < THUMBNAIL_MIN_DURATION_FOR_OFFSET_SECONDS
  ) {
    return 0;
  }
  return durationSeconds * THUMBNAIL_OFFSET_RATIO;
}
