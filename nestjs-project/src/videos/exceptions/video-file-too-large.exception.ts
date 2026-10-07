import { DomainException } from '../../common/exceptions/domain.exception';

export class VideoFileTooLargeException extends DomainException {
  constructor(maxSizeBytes: number) {
    super(
      'VIDEO_FILE_TOO_LARGE',
      422,
      `The uploaded file exceeds the maximum size of ${maxSizeBytes} bytes`,
    );
  }
}
