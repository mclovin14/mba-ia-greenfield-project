import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { VIDEO_PROCESSING_QUEUE } from './video-processing/video-processing.constants';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  // SIGTERM closes the BullMQ workers (waiting for active jobs) and the DB.
  // useProcessExit exits with code 0 instead of re-raising the signal (143).
  app.enableShutdownHooks(['SIGTERM', 'SIGINT'], { useProcessExit: true });
  new Logger('Worker').log(
    `Video worker started (queue: ${VIDEO_PROCESSING_QUEUE})`,
  );
}

void bootstrap();
