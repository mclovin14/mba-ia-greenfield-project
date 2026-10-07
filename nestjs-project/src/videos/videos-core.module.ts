import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Video } from './entities/video.entity';
import { VideoAccessPolicy } from './video-access.policy';
import { VideosService } from './videos.service';

/**
 * Video persistence and ownership rules, with no HTTP, storage or queue
 * dependency, so the worker can import it without the API surface.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Video])],
  providers: [VideosService, VideoAccessPolicy],
  exports: [TypeOrmModule, VideosService, VideoAccessPolicy],
})
export class VideosCoreModule {}
