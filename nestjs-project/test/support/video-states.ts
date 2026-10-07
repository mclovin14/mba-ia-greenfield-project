import { readFile } from 'node:fs/promises';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { FfmpegService } from '../../src/media/ffmpeg.service';
import { MediaModule } from '../../src/media/media.module';
import { STORAGE_BUCKETS } from '../../src/storage/storage.constants';
import { StorageService } from '../../src/storage/storage.service';
import { requestPresigned } from '../../src/test/presigned-request';
import { getVideoFixture } from '../../src/test/video-fixtures';
import { THUMBNAIL_CONTENT_TYPE } from '../../src/video-processing/video-processing.constants';
import { Video } from '../../src/videos/entities/video.entity';
import { videoThumbnailKey } from '../../src/videos/video-object-keys';
import { VideosService } from '../../src/videos/videos.service';
import type { VideosTestApp } from './videos-app';

export interface VideoStates {
  /** Bytes of the `mp4-with-audio` fixture every upload sends. */
  fixture: Buffer;
  /** POST /videos → PUT of the single part → complete: the video is 'processing'. */
  uploadToProcessing: (token: string, filename?: string) => Promise<string>;
  /** processing → ready the way the worker does it, minus the queue. */
  seedReady: (publicId: string) => Promise<void>;
  findVideo: (publicId: string) => Promise<Video>;
}

/**
 * Drives a video through the real upload endpoints and seeds the worker's
 * outcome with the real services: thumbnail and metadata come from ffmpeg on
 * the fixture. The API does not load MediaModule, so it is compiled alone.
 */
export async function createVideoStates(
  testApp: VideosTestApp,
): Promise<VideoStates> {
  const server = testApp.app.getHttpServer();
  const dataSource = testApp.moduleRef.get(DataSource);
  const videosService = testApp.moduleRef.get(VideosService);
  const storageService = testApp.moduleRef.get(StorageService);
  const mediaRef = await Test.createTestingModule({
    imports: [MediaModule],
  }).compile();
  const ffmpegService = mediaRef.get(FfmpegService);
  const fixturePath = await getVideoFixture('mp4-with-audio');
  const fixture = await readFile(fixturePath);

  const findVideo = (publicId: string): Promise<Video> =>
    dataSource.getRepository(Video).findOneByOrFail({ public_id: publicId });

  const uploadToProcessing = async (
    token: string,
    filename = 'aula.mp4',
  ): Promise<string> => {
    const created = await request(server)
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({ filename, mime_type: 'video/mp4', size_bytes: fixture.length })
      .expect(201);
    const publicId = (created.body as { video: { public_id: string } }).video
      .public_id;

    const urls = await request(server)
      .post(`/videos/${publicId}/upload/part-urls`)
      .set('Authorization', `Bearer ${token}`)
      .send({ part_numbers: [1] })
      .expect(200);
    const [part] = (urls.body as { parts: { url: string }[] }).parts;
    const put = await requestPresigned(part.url, {
      method: 'PUT',
      body: fixture,
    });
    expect(put.status).toBe(200);

    await request(server)
      .post(`/videos/${publicId}/upload/complete`)
      .set('Authorization', `Bearer ${token}`)
      .expect(202);
    return publicId;
  };

  const seedReady = async (publicId: string): Promise<void> => {
    const { id } = await findVideo(publicId);
    const probe = await ffmpegService.probe(fixturePath);
    const jpeg = await ffmpegService.extractFrame(fixturePath, 0);
    await storageService.putObject(
      STORAGE_BUCKETS.THUMBNAILS,
      videoThumbnailKey(id),
      jpeg,
      THUMBNAIL_CONTENT_TYPE,
    );
    const marked = await videosService.markReady(id, {
      duration_seconds: probe.durationSeconds,
      width: probe.video!.width,
      height: probe.video!.height,
      video_codec: probe.video!.codec,
      audio_codec: probe.audioCodec,
      container_format: probe.formatName,
    });
    expect(marked).toBe(true);
  };

  return { fixture, uploadToProcessing, seedReady, findVideo };
}
