import { Test, type TestingModule } from '@nestjs/testing';
import { copyFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getVideoFixture } from '../test/video-fixtures';
import { FfmpegService } from './ffmpeg.service';
import {
  MediaFrameExtractionError,
  MediaNotReadableError,
} from './media.errors';
import { MediaModule } from './media.module';

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

describe('FfmpegService × ffprobe/ffmpeg', () => {
  let module: TestingModule;
  let service: FfmpegService;
  let workDir: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [MediaModule],
    }).compile();
    service = module.get(FfmpegService);
    workDir = await mkdtemp(join(tmpdir(), 'ffmpeg-it-'));
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
    await module.close();
  });

  /** Probes the JPEG bytes to read their real dimensions. */
  const probeImage = async (jpeg: Buffer) => {
    const path = join(workDir, `frame-${Date.now()}.jpg`);
    await writeFile(path, jpeg);
    return service.probe(path);
  };

  describe('probe', () => {
    it('should read dimensions, codecs and duration of an H.264/AAC MP4', async () => {
      const result = await service.probe(
        await getVideoFixture('mp4-with-audio'),
      );

      expect(result.video).toEqual({ width: 320, height: 240, codec: 'h264' });
      expect(result.audioCodec).toBe('aac');
      expect(result.formatName).toContain('mp4');
      expect(result.durationSeconds).toBeGreaterThanOrEqual(2.9);
      expect(result.durationSeconds).toBeLessThanOrEqual(3.1);
    });

    it('should return a null audio codec for a video-only MP4', async () => {
      const result = await service.probe(
        await getVideoFixture('mp4-video-only'),
      );

      expect(result.audioCodec).toBeNull();
      expect(result.video?.codec).toBe('h264');
    });

    it('should return video = null for an audio-only file', async () => {
      const result = await service.probe(await getVideoFixture('audio-only'));

      expect(result.video).toBeNull();
      expect(result.audioCodec).toBe('aac');
    });

    it('should throw MediaNotReadableError for bytes that are not media', async () => {
      await expect(
        service.probe(await getVideoFixture('not-media')),
      ).rejects.toThrow(MediaNotReadableError);
    });

    it('should treat a shell metacharacter file name as a plain argument', async () => {
      // A file name cannot hold '/', so the injected command writes a
      // relative sentinel, which a shell would create in the process cwd.
      const sentinelName = `pwned-${process.pid}-${Date.now()}`;
      const hostile = join(workDir, `clip; touch ${sentinelName}; rm -rf .mp4`);
      await copyFile(await getVideoFixture('mp4-short'), hostile);

      const result = await service.probe(hostile);

      expect(result.video?.width).toBe(320);
      for (const dir of [process.cwd(), workDir]) {
        await expect(stat(join(dir, sentinelName))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      }
    });
  });

  describe('extractFrame', () => {
    it('should return a JPEG keeping the 320 px width (no upscale)', async () => {
      const jpeg = await service.extractFrame(
        await getVideoFixture('mp4-with-audio'),
        0.3,
      );

      expect(jpeg.subarray(0, 3)).toEqual(JPEG_MAGIC);
      expect((await probeImage(jpeg)).video?.width).toBe(320);
    });

    it('should extract the first frame of a 1 s video', async () => {
      const jpeg = await service.extractFrame(
        await getVideoFixture('mp4-short'),
        0,
      );

      expect(jpeg.subarray(0, 3)).toEqual(JPEG_MAGIC);
    });

    it('should limit the width of a wider video to 640 px, keeping the aspect ratio', async () => {
      const jpeg = await service.extractFrame(
        await getVideoFixture('mp4-wide'),
        0,
      );

      const { video } = await probeImage(jpeg);
      expect(video?.width).toBe(640);
      expect(video?.height).toBe(360);
    });

    it('should throw MediaFrameExtractionError for a file without video', async () => {
      await expect(
        service.extractFrame(await getVideoFixture('audio-only'), 0),
      ).rejects.toThrow(MediaFrameExtractionError);
    });
  });
});
