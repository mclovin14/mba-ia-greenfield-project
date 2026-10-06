import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { VIDEO_PROCESSING_QUEUE } from './video-processing.constants';
import { VideoProcessingQueue } from './video-processing.queue';

/** Producer side only: registers the queue, never a processor. */
@Module({
  imports: [BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })],
  providers: [VideoProcessingQueue],
  exports: [VideoProcessingQueue],
})
export class VideoProcessingQueueModule {}
