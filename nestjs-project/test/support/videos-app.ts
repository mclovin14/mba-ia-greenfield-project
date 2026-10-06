import { randomUUID } from 'node:crypto';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import type { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../../src/common/filters/validation-exception.filter';

export const E2E_VIDEOS_BUCKET = 'e2e-videos';
export const E2E_THUMBNAILS_BUCKET = 'e2e-thumbnails';

const ISOLATED_ENV = {
  S3_VIDEOS_BUCKET: E2E_VIDEOS_BUCKET,
  S3_THUMBNAILS_BUCKET: E2E_THUMBNAILS_BUCKET,
} as const;

export interface VideosTestApp {
  app: INestApplication<App>;
  moduleRef: TestingModule;
  queuePrefix: string;
  close: () => Promise<void>;
}

/**
 * Boots the full AppModule with main.ts globals, dedicated e2e buckets and a
 * unique queue prefix, so video suites never touch dev buckets or queues.
 * The storage bootstrap creates the buckets during app.init().
 */
export async function createVideosTestApp(): Promise<VideosTestApp> {
  const previous = {
    ...Object.fromEntries(
      Object.keys(ISOLATED_ENV).map((k) => [k, process.env[k]]),
    ),
    QUEUE_PREFIX: process.env.QUEUE_PREFIX,
  };
  const queuePrefix = `test-${randomUUID()}`;
  Object.assign(process.env, ISOLATED_ENV, { QUEUE_PREFIX: queuePrefix });

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
  await app.init();

  const close = async (): Promise<void> => {
    await app.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  return { app, moduleRef, queuePrefix, close };
}
