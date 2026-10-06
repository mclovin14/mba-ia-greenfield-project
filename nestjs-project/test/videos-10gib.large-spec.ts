import { ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import type { INestApplication } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  createTestS3Client,
  emptyBucket,
  requestPresigned,
} from '../src/test/presigned-request';
import { videoProcessingJobId } from '../src/video-processing/video-processing.constants';
import type { InitiateUploadResponseDto } from '../src/videos/dto/initiate-upload-response.dto';
import type { VideoResponseDto } from '../src/videos/dto/video-response.dto';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { registerConfirmAndLogin } from './support/auth';
import { E2E_THUMBNAILS_BUCKET, E2E_VIDEOS_BUCKET } from './support/videos-app';
import {
  createVideosFlowApp,
  type VideosFlowApp,
} from './support/videos-test-app';

const FIXTURE_PATH = join(
  __dirname,
  '..',
  '.large-fixtures',
  'video-10gib.mp4',
);
const SIZE_LIMIT_BYTES = 10_737_418_240;
const EXPECTED_PART_COUNT = 640;
const UPLOAD_CONCURRENCY = 4;
const SETTLE_TIMEOUT_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 1_000;
const MAX_API_BYTES = 1024 * 1024;

interface ErrorBody {
  error: string;
}

/** Runs `fn` over `items` with at most `concurrency` calls in flight. */
async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < items.length) {
        await fn(items[next++]);
      }
    }),
  );
}

describe('Videos: 10 GiB limit with a real file (large, opt-in)', () => {
  let flow: VideosFlowApp;
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let s3: S3Client;
  let counter = 0;

  beforeAll(async () => {
    // Fail instead of skipping: a skipped suite would be green without
    // testing anything.
    const size = await stat(FIXTURE_PATH)
      .then((s) => s.size)
      .catch(() => undefined);
    if (size !== SIZE_LIMIT_BYTES) {
      throw new Error(
        `${FIXTURE_PATH} is missing or is not ${SIZE_LIMIT_BYTES} bytes ` +
          `(found: ${size ?? 'none'}). Run \`npm run fixtures:large\` first.`,
      );
    }
    flow = await createVideosFlowApp();
    app = flow.testApp.app;
    dataSource = flow.testApp.moduleRef.get(DataSource);
    throttlerStorage =
      flow.testApp.moduleRef.get<ThrottlerStorageService>(ThrottlerStorage);
    s3 = createTestS3Client();
  });

  afterAll(async () => {
    s3?.destroy();
    await flow?.close();
  });

  beforeEach(() => {
    throttlerStorage.storage.clear();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await cleanAllTables(dataSource);
    // Frees ~10 GiB of storage before the next scenario.
    await emptyBucket(E2E_VIDEOS_BUCKET);
    await emptyBucket(E2E_THUMBNAILS_BUCKET);
  });

  const api = () => request(app.getHttpServer());

  const login = (): Promise<string> =>
    registerConfirmAndLogin(app, `videos_10gib_${++counter}@example.com`);

  const initiate = async (
    token: string,
  ): Promise<InitiateUploadResponseDto> => {
    const res = await api()
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        filename: 'video-10gib.mp4',
        mime_type: 'video/mp4',
        size_bytes: SIZE_LIMIT_BYTES,
      })
      .expect(201);
    return res.body as InitiateUploadResponseDto;
  };

  /**
   * Streams every part from disk straight to storage, requesting the URLs in
   * batches of max_part_urls_per_request. The file is never held in memory.
   * `extraBytes` are appended to the last part to overflow the limit.
   */
  const uploadParts = async (
    token: string,
    initiated: InitiateUploadResponseDto,
    extraBytes = 0,
  ): Promise<void> => {
    const { part_size_bytes, part_count, max_part_urls_per_request } =
      initiated.upload;
    const publicId = initiated.video.public_id;
    const numbers = Array.from({ length: part_count }, (_, i) => i + 1);

    for (let i = 0; i < numbers.length; i += max_part_urls_per_request) {
      const batch = numbers.slice(i, i + max_part_urls_per_request);
      const res = await api()
        .post(`/videos/${publicId}/upload/part-urls`)
        .set('Authorization', `Bearer ${token}`)
        .send({ part_numbers: batch })
        .expect(200);
      const parts = (
        res.body as { parts: { part_number: number; url: string }[] }
      ).parts;

      await runPool(parts, UPLOAD_CONCURRENCY, async (part) => {
        const start = (part.part_number - 1) * part_size_bytes;
        const end = Math.min(start + part_size_bytes, SIZE_LIMIT_BYTES) - 1;
        const isLast = part.part_number === part_count;
        const file = createReadStream(FIXTURE_PATH, { start, end });
        const body =
          isLast && extraBytes > 0
            ? Readable.from(
                (async function* () {
                  yield* file;
                  yield Buffer.alloc(extraBytes);
                })(),
              )
            : file;
        const length = end - start + 1 + (isLast ? extraBytes : 0);

        const put = await requestPresigned(part.url, {
          method: 'PUT',
          body,
          headers: { 'content-length': String(length) },
        });
        expect(put.status).toBe(200);
      });
    }
  };

  const getVideo = async (
    token: string,
    publicId: string,
  ): Promise<VideoResponseDto> => {
    const res = await api()
      .get(`/videos/${publicId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return res.body as VideoResponseDto;
  };

  const waitUntilSettled = async (
    token: string,
    publicId: string,
  ): Promise<VideoResponseDto> => {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const video = await getVideo(token, publicId);
      if (video.status !== VideoStatus.Processing) return video;
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(
      `video ${publicId} still processing after ${SETTLE_TIMEOUT_MS} ms`,
    );
  };

  const readFileTail = async (bytes: number): Promise<Buffer> => {
    const handle = await open(FIXTURE_PATH, 'r');
    try {
      const buffer = Buffer.alloc(bytes);
      await handle.read(buffer, 0, bytes, SIZE_LIMIT_BYTES - bytes);
      return buffer;
    } finally {
      await handle.close();
    }
  };

  it('limite-exato-10gib-aceito-processado-e-reproduzido', async () => {
    const token = await login();
    flow.resetApiBytes();

    const initiated = await initiate(token);
    expect(initiated.upload.part_count).toBe(EXPECTED_PART_COUNT);
    const publicId = initiated.video.public_id;
    await uploadParts(token, initiated);

    const completed = await api()
      .post(`/videos/${publicId}/upload/complete`)
      .set('Authorization', `Bearer ${token}`)
      .expect(202);
    expect((completed.body as VideoResponseDto).size_bytes).toBe(
      SIZE_LIMIT_BYTES,
    );

    const video = await waitUntilSettled(token, publicId);
    expect(video).toMatchObject({
      status: VideoStatus.Ready,
      size_bytes: SIZE_LIMIT_BYTES,
      width: 1920,
      height: 1080,
      video_codec: 'h264',
      audio_codec: 'aac',
      processing_error: null,
    });
    expect(video.duration_seconds).toBeGreaterThan(0);
    expect(video.container_format).toEqual(expect.any(String));
    const thumbnail = await requestPresigned(video.thumbnail_url!, {
      method: 'GET',
    });
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers['content-type']).toBe('image/jpeg');

    const stream = await api()
      .get(`/videos/${publicId}/stream`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const tail = await requestPresigned((stream.body as { url: string }).url, {
      method: 'GET',
      headers: { Range: 'bytes=-1024' },
    });
    expect(tail.status).toBe(206);
    expect(tail.headers['content-range']).toBe(
      'bytes 10737417216-10737418239/10737418240',
    );
    expect(tail.body.equals(await readFileTail(1024))).toBe(true);

    // AMB-3: 10 GiB went to storage; the API only saw JSON.
    expect(flow.apiBytes()).toBeLessThan(MAX_API_BYTES);
  });

  it('acima-do-limite-rejeitado-no-complete', async () => {
    const token = await login();
    flow.resetApiBytes();

    const initiated = await initiate(token);
    const publicId = initiated.video.public_id;
    await uploadParts(token, initiated, 1);

    const completed = await api()
      .post(`/videos/${publicId}/upload/complete`)
      .set('Authorization', `Bearer ${token}`)
      .expect(422);
    expect((completed.body as ErrorBody).error).toBe('VIDEO_FILE_TOO_LARGE');

    const video = await getVideo(token, publicId);
    expect(video.status).toBe(VideoStatus.Failed);
    expect(video.processing_error).toBe('FILE_TOO_LARGE');
    const objects = await s3.send(
      new ListObjectsV2Command({ Bucket: E2E_VIDEOS_BUCKET }),
    );
    expect(objects.KeyCount).toBe(0);
    const { id } = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: publicId });
    expect(await flow.queue.getJob(videoProcessingJobId(id))).toBeUndefined();

    expect(flow.apiBytes()).toBeLessThan(MAX_API_BYTES);
  });
});
