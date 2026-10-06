import { ApiProperty } from '@nestjs/swagger';

export class UploadedPartDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({ example: 16777216 })
  size_bytes: number;

  @ApiProperty({ example: '"9b2cf535f27731c974343645a3985328"' })
  etag: string;
}

export class UploadedPartsResponseDto {
  @ApiProperty({
    type: [UploadedPartDto],
    description: 'Ascending by part_number',
  })
  parts: UploadedPartDto[];
}
