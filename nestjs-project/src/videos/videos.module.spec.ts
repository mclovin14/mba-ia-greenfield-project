import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { QueueModule } from '../queue/queue.module';
import { createTestDataSource } from '../test/create-test-data-source';
import { waitForVideoProcessingQueue } from '../test/queues';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoUploadService } from './video-upload.service';
import { VideosModule } from './videos.module';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosModule', () => {
  it('should compile with real config, storage, queue and TypeORM wiring', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        QueueModule,
        VideosModule,
      ],
    }).compile();

    expect(module.get(VideoUploadService)).toBeInstanceOf(VideoUploadService);
    await waitForVideoProcessingQueue(module);
    await module.close();
  }, 30000);
});
