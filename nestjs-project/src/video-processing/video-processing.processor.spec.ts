import { Test } from '@nestjs/testing';
import { UnrecoverableError, type Job } from 'bullmq';
import { VideosService } from '../videos/videos.service';
import { PROCESS_VIDEO_JOB } from './video-processing.constants';
import { VideoProcessingTerminalError } from './video-processing.errors';
import { VideoProcessingProcessor } from './video-processing.processor';
import { isFinalAttempt } from './video-processing.retry';
import { VideoProcessingService } from './video-processing.service';
import type { ProcessVideoJobData } from './video-processing.types';

const VIDEO_ID = '0b5f6a8e-3c1d-4e2f-9a7b-1c2d3e4f5a6b';

const buildJob = (
  overrides: { name?: string; attemptsMade?: number; attempts?: number } = {},
): Job<ProcessVideoJobData> =>
  ({
    name: overrides.name ?? PROCESS_VIDEO_JOB,
    data: { videoId: VIDEO_ID },
    attemptsMade: overrides.attemptsMade ?? 0,
    opts: { attempts: overrides.attempts ?? 3 },
  }) as Job<ProcessVideoJobData>;

describe('isFinalAttempt', () => {
  it.each([
    [0, 3, false],
    [1, 3, false],
    [2, 3, true],
    [0, 1, true],
  ])('attemptsMade %i of %i attempts → %p', (attemptsMade, attempts, final) => {
    expect(isFinalAttempt(buildJob({ attemptsMade, attempts }))).toBe(final);
  });

  it('should treat a job without attempts as single-attempt', () => {
    expect(isFinalAttempt({ attemptsMade: 0, opts: {} })).toBe(true);
  });
});

describe('VideoProcessingProcessor', () => {
  let processor: VideoProcessingProcessor;
  const processingService = { process: jest.fn() };
  const videosService = { markFailed: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();
    videosService.markFailed.mockResolvedValue(true);
    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingProcessor,
        { provide: VideoProcessingService, useValue: processingService },
        { provide: VideosService, useValue: videosService },
      ],
    }).compile();
    processor = module.get(VideoProcessingProcessor);
  });

  it('should process the video and not mark it failed on success', async () => {
    processingService.process.mockResolvedValue('ready');

    await processor.process(buildJob());

    expect(processingService.process).toHaveBeenCalledWith(VIDEO_ID);
    expect(videosService.markFailed).not.toHaveBeenCalled();
  });

  it('should mark failed with the code and stop retries on a terminal error', async () => {
    processingService.process.mockRejectedValue(
      new VideoProcessingTerminalError('NO_VIDEO_STREAM'),
    );

    const error: unknown = await processor
      .process(buildJob({ attemptsMade: 0 }))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnrecoverableError);
    expect((error as Error).message).toBe('NO_VIDEO_STREAM');
    expect(videosService.markFailed).toHaveBeenCalledWith(
      VIDEO_ID,
      'NO_VIDEO_STREAM',
    );
  });

  it('should rethrow a transient error without marking failed on attempt 1 of 3', async () => {
    const transient = new Error('storage unavailable');
    processingService.process.mockRejectedValue(transient);

    await expect(processor.process(buildJob({ attemptsMade: 0 }))).rejects.toBe(
      transient,
    );

    expect(videosService.markFailed).not.toHaveBeenCalled();
  });

  it('should mark PROCESSING_FAILED and rethrow a transient error on attempt 3 of 3', async () => {
    const transient = new Error('storage unavailable');
    processingService.process.mockRejectedValue(transient);

    await expect(processor.process(buildJob({ attemptsMade: 2 }))).rejects.toBe(
      transient,
    );

    expect(videosService.markFailed).toHaveBeenCalledWith(
      VIDEO_ID,
      'PROCESSING_FAILED',
    );
  });

  it('should reject an unknown job name without touching the database', async () => {
    await expect(
      processor.process(buildJob({ name: 'unexpected-job' })),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    expect(processingService.process).not.toHaveBeenCalled();
    expect(videosService.markFailed).not.toHaveBeenCalled();
  });
});
