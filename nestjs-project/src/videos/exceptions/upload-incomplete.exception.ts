import { DomainException } from '../../common/exceptions/domain.exception';

export class UploadIncompleteException extends DomainException {
  constructor() {
    super(
      'UPLOAD_INCOMPLETE',
      409,
      'The upload is incomplete: some parts are missing or invalid',
    );
  }
}
