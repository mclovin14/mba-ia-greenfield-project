export interface MediaVideoStream {
  width: number;
  height: number;
  codec: string;
}

export interface MediaProbeResult {
  durationSeconds: number | null;
  formatName: string;
  video: MediaVideoStream | null;
  audioCodec: string | null;
}

/** Subset of `ffprobe -print_format json -show_format -show_streams`. */
export interface ProbeOutput {
  format?: { format_name?: string; duration?: string };
  streams?: {
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
  }[];
}
