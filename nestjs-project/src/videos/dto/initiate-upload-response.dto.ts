import { ApiProperty } from '@nestjs/swagger';
import { VideoResponseDto } from './video-response.dto';

export class UploadPlanDto {
  @ApiProperty({ example: 16777216 })
  part_size_bytes: number;

  @ApiProperty({ example: 3, maximum: 640 })
  part_count: number;

  @ApiProperty({ example: 100 })
  max_part_urls_per_request: number;
}

export class InitiateUploadResponseDto {
  @ApiProperty({ type: VideoResponseDto })
  video: VideoResponseDto;

  @ApiProperty({ type: UploadPlanDto })
  upload: UploadPlanDto;
}
