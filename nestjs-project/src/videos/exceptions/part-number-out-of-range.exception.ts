import { DomainException } from '../../common/exceptions/domain.exception';

export class PartNumberOutOfRangeException extends DomainException {
  constructor(partCount: number) {
    super(
      'PART_NUMBER_OUT_OF_RANGE',
      400,
      `Part numbers must be between 1 and ${partCount}`,
    );
  }
}
