import { Matches } from 'class-validator';
import { PUBLIC_ID_PATTERN } from '../videos.constants';

export class VideoPublicIdParamDto {
  @Matches(PUBLIC_ID_PATTERN)
  publicId: string;
}
