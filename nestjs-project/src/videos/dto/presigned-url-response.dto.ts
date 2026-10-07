import { ApiProperty } from '@nestjs/swagger';

export class PresignedUrlResponseDto {
  @ApiProperty({
    description:
      'Presigned GET URL; the client fetches the bytes directly from storage',
  })
  url: string;

  @ApiProperty({ example: '2026-10-05T21:00:00.000Z' })
  expires_at: string;
}
