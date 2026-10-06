import {
  MediaFrameExtractionError,
  MediaNotReadableError,
} from './media.errors';

const PRESIGNED =
  'http://minio:9000/videos/id/original?X-Amz-Signature=secret&X-Amz-Credential=key';

describe('media errors', () => {
  it.each([MediaNotReadableError, MediaFrameExtractionError])(
    '%p should drop the presigned query string from the message',
    (ErrorClass) => {
      const error = new ErrorClass(PRESIGNED, 'exit code 1');

      expect(error.message).toContain('http://minio:9000/videos/id/original');
      expect(error.message).not.toContain('X-Amz');
      expect(error.message).not.toContain('secret');
    },
  );
});
