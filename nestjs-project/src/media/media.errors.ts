/**
 * Inputs may be presigned URLs, whose query string carries the signature:
 * keep only the part before `?` so error messages are safe to log.
 */
const describeInput = (input: string): string => input.split('?')[0];

export class MediaNotReadableError extends Error {
  constructor(input: string, detail: string) {
    super(`Media not readable: ${describeInput(input)}: ${detail}`);
    this.name = this.constructor.name;
  }
}

export class MediaFrameExtractionError extends Error {
  constructor(input: string, detail: string) {
    super(`Frame extraction failed: ${describeInput(input)}: ${detail}`);
    this.name = this.constructor.name;
  }
}
