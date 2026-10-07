import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus, type Video } from '../entities/video.entity';

export class VideoResponseDto {
  @ApiProperty({ example: 'dQw4w9WgXcQ' })
  public_id: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ type: String, nullable: true })
  description: string | null;

  @ApiProperty({ enum: VideoStatus, enumName: 'VideoStatus' })
  status: VideoStatus;

  @ApiProperty()
  original_filename: string;

  @ApiProperty()
  mime_type: string;

  @ApiProperty()
  size_bytes: number;

  @ApiProperty({ type: Number, nullable: true })
  duration_seconds: number | null;

  @ApiProperty({ type: Number, nullable: true })
  width: number | null;

  @ApiProperty({ type: Number, nullable: true })
  height: number | null;

  @ApiProperty({ type: String, nullable: true })
  video_codec: string | null;

  @ApiProperty({ type: String, nullable: true })
  audio_codec: string | null;

  @ApiProperty({ type: String, nullable: true })
  container_format: string | null;

  @ApiProperty({ type: String, nullable: true })
  processing_error: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "Presigned GET URL; non-null only when status is 'ready'",
  })
  thumbnail_url: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at: string;

  @ApiProperty({ format: 'date-time' })
  updated_at: string;
}

/** Never serializes the internal `id`, `channel_id` or `upload_id`. */
export function toVideoResponse(
  video: Video,
  thumbnailUrl: string | null,
): VideoResponseDto {
  return {
    public_id: video.public_id,
    title: video.title,
    description: video.description,
    status: video.status,
    original_filename: video.original_filename,
    mime_type: video.mime_type,
    size_bytes: video.size_bytes,
    duration_seconds: video.duration_seconds,
    width: video.width,
    height: video.height,
    video_codec: video.video_codec,
    audio_codec: video.audio_codec,
    container_format: video.container_format,
    processing_error: video.processing_error,
    thumbnail_url: thumbnailUrl,
    created_at: video.created_at.toISOString(),
    updated_at: video.updated_at.toISOString(),
  };
}
