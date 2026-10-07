import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import queueConfig from '../config/queue.config';
import { QueueModule } from '../queue/queue.module';
import { waitForVideoProcessingQueue } from '../test/queues';
import { VideoProcessingQueueModule } from './video-processing-queue.module';
import { VideoProcessingQueue } from './video-processing.queue';

describe('VideoProcessingQueueModule', () => {
  it('should compile with the real QueueModule and expose VideoProcessingQueue', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
        VideoProcessingQueueModule,
      ],
    }).compile();

    expect(module.get(VideoProcessingQueue)).toBeInstanceOf(
      VideoProcessingQueue,
    );
    await waitForVideoProcessingQueue(module);
    await module.close();
  });
});
