import type { IncomingMessage, Server } from 'node:http';
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Queue } from 'bullmq';
import { VIDEO_PROCESSING_QUEUE } from '../../src/video-processing/video-processing.constants';
import type { ProcessVideoJobData } from '../../src/video-processing/video-processing.types';
import { WorkerModule } from '../../src/worker.module';
import { createVideosTestApp, type VideosTestApp } from './videos-app';

export interface VideosFlowApp {
  testApp: VideosTestApp;
  worker: INestApplicationContext;
  queue: Queue<ProcessVideoJobData>;
  /** Sum of the request content-length the API received since the last reset. */
  apiBytes: () => number;
  resetApiBytes: () => void;
  close: () => Promise<void>;
}

/**
 * The API (AppModule with main.ts globals) plus a real worker process context
 * in the same Jest process. createVideosTestApp sets QUEUE_PREFIX=test-{uuid}
 * and the e2e buckets before compiling; the worker is created under the same
 * env, so it consumes exactly this suite's jobs and never the compose worker's.
 */
export async function createVideosFlowApp(): Promise<VideosFlowApp> {
  const testApp = await createVideosTestApp();
  const worker = await NestFactory.createApplicationContext(WorkerModule, {
    logger: false,
  });
  const queue = testApp.moduleRef.get<Queue<ProcessVideoJobData>>(
    getQueueToken(VIDEO_PROCESSING_QUEUE),
  );

  let bytes = 0;
  // getHttpServer() is typed as supertest's App; at runtime it is the
  // node:http Server that receives every request the API handles.
  const server = testApp.app.getHttpServer() as unknown as Server;
  server.on('request', (req: IncomingMessage) => {
    bytes += Number(req.headers['content-length'] ?? 0);
  });

  const close = async (): Promise<void> => {
    await queue.obliterate({ force: true });
    // Worker first: it must stop consuming before the API closes the queue.
    await worker.close();
    await testApp.close();
  };

  return {
    testApp,
    worker,
    queue,
    apiBytes: () => bytes,
    resetApiBytes: () => {
      bytes = 0;
    },
    close,
  };
}
