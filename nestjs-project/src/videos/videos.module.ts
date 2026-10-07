import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { StorageModule } from '../storage/storage.module';
import { VideoProcessingQueueModule } from '../video-processing/video-processing-queue.module';
import { VideoPlaybackService } from './video-playback.service';
import { VideoUploadService } from './video-upload.service';
import { VideosController } from './videos.controller';
import { VideosCoreModule } from './videos-core.module';

/** HTTP surface for videos; the worker imports VideosCoreModule instead. */
@Module({
  imports: [
    VideosCoreModule,
    ChannelsModule,
    StorageModule,
    VideoProcessingQueueModule,
  ],
  controllers: [VideosController],
  providers: [VideoUploadService, VideoPlaybackService],
})
export class VideosModule {}
