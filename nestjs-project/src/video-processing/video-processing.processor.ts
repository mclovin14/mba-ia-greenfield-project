import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import { VideoProcessingErrorCode } from '../videos/videos.constants';
import { VideosService } from '../videos/videos.service';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';
import { VideoProcessingTerminalError } from './video-processing.errors';
import { isFinalAttempt } from './video-processing.retry';
import { VideoProcessingService } from './video-processing.service';
import type { ProcessVideoJobData } from './video-processing.types';

/**
 * Failure handling of the `process-video` contract (TD-09): terminal errors
 * fail the video on the first attempt; transient ones are retried by BullMQ
 * and fail the video only on the last attempt.
 */
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    private readonly processingService: VideoProcessingService,
    private readonly videosService: VideosService,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    if (job.name !== PROCESS_VIDEO_JOB) {
      throw new UnrecoverableError(`Unknown job name: ${job.name}`);
    }
    const { videoId } = job.data;
    const attempt = job.attemptsMade + 1;
    const startedAt = Date.now();
    this.logger.log(`Processing video ${videoId} (attempt ${attempt})`);

    try {
      const outcome = await this.processingService.process(videoId);
      this.logger.log(
        `Video ${videoId} ${outcome === 'ready' ? 'ready' : 'skipped (not processing)'} in ${Date.now() - startedAt} ms`,
      );
    } catch (error) {
      if (error instanceof VideoProcessingTerminalError) {
        await this.videosService.markFailed(videoId, error.code);
        this.logger.warn(
          `Video ${videoId} failed with ${error.code} (attemptsMade ${job.attemptsMade})`,
        );
        throw new UnrecoverableError(error.code);
      }

      const final = isFinalAttempt(job);
      if (final) {
        await this.videosService.markFailed(
          videoId,
          VideoProcessingErrorCode.PROCESSING_FAILED,
        );
      }
      this.logger.warn(
        `Video ${videoId} attempt ${attempt} failed${final ? ` with ${VideoProcessingErrorCode.PROCESSING_FAILED}` : ', will retry'} (attemptsMade ${job.attemptsMade}): ${describe(error)}`,
      );
      throw error;
    }
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);
