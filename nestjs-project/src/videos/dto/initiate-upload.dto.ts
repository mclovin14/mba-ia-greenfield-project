import { Transform, type TransformFnParams } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import {
  VIDEO_ALLOWED_MIME_TYPES,
  VIDEO_FILENAME_MAX_LENGTH,
  VIDEO_MAX_SIZE_BYTES,
  VIDEO_TITLE_MAX_LENGTH,
  type VideoMimeType,
} from '../videos.constants';

const trim = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class InitiateUploadDto {
  @IsString()
  @Transform(trim)
  @Length(1, VIDEO_FILENAME_MAX_LENGTH)
  filename: string;

  @IsIn(VIDEO_ALLOWED_MIME_TYPES)
  mime_type: VideoMimeType;

  @IsInt()
  @Min(1)
  @Max(VIDEO_MAX_SIZE_BYTES)
  size_bytes: number;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @Length(1, VIDEO_TITLE_MAX_LENGTH)
  title?: string;
}
