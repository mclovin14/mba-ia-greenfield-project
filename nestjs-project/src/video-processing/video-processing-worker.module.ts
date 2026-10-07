import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module';
import { StorageModule } from '../storage/storage.module';
import { VideosCoreModule } from '../videos/videos-core.module';
import { VIDEO_PROCESSING_QUEUE } from './video-processing.constants';
import { VideoProcessingProcessor } from './video-processing.processor';
import { VideoProcessingService } from './video-processing.service';

/** Consumer side of the queue (TD-04): imported by WorkerModule only. */
@Module({
  imports: [
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
    VideosCoreModule,
    StorageModule,
    MediaModule,
  ],
  providers: [VideoProcessingService, VideoProcessingProcessor],
})
export class VideoProcessingWorkerModule {}
