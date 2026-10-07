import { ApiProperty } from '@nestjs/swagger';

export class PartUrlDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({
    description: 'Presigned UploadPart URL; send the raw part bytes with PUT',
  })
  url: string;
}

export class PartUrlsResponseDto {
  @ApiProperty({
    type: [PartUrlDto],
    description: 'In the same order as the requested part_numbers',
  })
  parts: PartUrlDto[];

  @ApiProperty({ example: '2026-10-05T21:00:00.000Z' })
  expires_at: string;
}
