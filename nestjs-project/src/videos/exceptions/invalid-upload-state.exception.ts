import { DomainException } from '../../common/exceptions/domain.exception';

export class InvalidUploadStateException extends DomainException {
  constructor() {
    super(
      'INVALID_UPLOAD_STATE',
      409,
      'The video is not in a state that allows this upload operation',
    );
  }
}
