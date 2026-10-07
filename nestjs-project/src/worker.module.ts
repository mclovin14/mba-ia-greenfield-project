import { Module } from '@nestjs/common';
import { RootConfigModule } from './config/root-config.module';
import { DatabaseModule } from './database/database.module';
import { QueueModule } from './queue/queue.module';
import { UsersModule } from './users/users.module';
import { VideoProcessingWorkerModule } from './video-processing/video-processing-worker.module';

/** Root module of the video worker process (TD-04): no HTTP, no controllers. */
@Module({
  imports: [
    RootConfigModule,
    DatabaseModule,
    QueueModule,
    // autoLoadEntities only sees entities registered via forFeature: Video's
    // relations (Video → Channel → User) need their owning modules here,
    // as AuthModule provides them in the API.
    UsersModule,
    VideoProcessingWorkerModule,
  ],
})
export class WorkerModule {}
