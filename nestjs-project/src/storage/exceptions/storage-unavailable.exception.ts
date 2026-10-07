import { DomainException } from '../../common/exceptions/domain.exception';

export class StorageUnavailableException extends DomainException {
  constructor() {
    super(
      'STORAGE_UNAVAILABLE',
      503,
      'Object storage is temporarily unavailable',
    );
  }
}
