import { Test } from '@nestjs/testing';
import { FfmpegService } from '../media/ffmpeg.service';
import { MediaNotReadableError } from '../media/media.errors';
import type { MediaProbeResult } from '../media/media.types';
import { StorageObjectNotFoundError } from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import { VideoStatus, type Video } from '../videos/entities/video.entity';
import { VideosService } from '../videos/videos.service';
import { VideoProcessingTerminalError } from './video-processing.errors';
import { VideoProcessingService } from './video-processing.service';

const VIDEO_ID = '0b5f6a8e-3c1d-4e2f-9a7b-1c2d3e4f5a6b';
const SOURCE_URL = 'http://minio:9000/videos/original?X-Amz-Signature=s';
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);

const probeResult = (
  overrides: Partial<MediaProbeResult> = {},
): MediaProbeResult => ({
  durationSeconds: 30,
  formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
  video: { width: 1280, height: 720, codec: 'h264' },
  audioCodec: 'aac',
  ...overrides,
});

describe('VideoProcessingService', () => {
  let service: VideoProcessingService;
  const videosService = {
    findById: jest.fn(),
    markReady: jest.fn(),
  };
  const storageService = {
    headObject: jest.fn(),
    presignGetObject: jest.fn(),
    putObject: jest.fn(),
  };
  const ffmpegService = {
    probe: jest.fn(),
    extractFrame: jest.fn(),
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    videosService.findById.mockResolvedValue({
      id: VIDEO_ID,
      status: VideoStatus.Processing,
    } as Video);
    videosService.markReady.mockResolvedValue(true);
    storageService.headObject.mockResolvedValue({ contentLength: 2048 });
    storageService.presignGetObject.mockResolvedValue(SOURCE_URL);
    storageService.putObject.mockResolvedValue(undefined);
    ffmpegService.probe.mockResolvedValue(probeResult());
    ffmpegService.extractFrame.mockResolvedValue(JPEG);

    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingService,
        { provide: VideosService, useValue: videosService },
        { provide: StorageService, useValue: storageService },
        { provide: FfmpegService, useValue: ffmpegService },
      ],
    }).compile();
    service = module.get(VideoProcessingService);
  });

  const expectTerminal = async (code: string): Promise<void> => {
    const error: unknown = await service
      .process(VIDEO_ID)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VideoProcessingTerminalError);
    expect((error as VideoProcessingTerminalError).code).toBe(code);
    expect(videosService.markReady).not.toHaveBeenCalled();
    expect(storageService.putObject).not.toHaveBeenCalled();
  };

  describe('no-op cases', () => {
    it('should skip without touching storage when the video no longer exists', async () => {
      videosService.findById.mockResolvedValue(null);

      await expect(service.process(VIDEO_ID)).resolves.toBe('skipped');

      expect(storageService.headObject).not.toHaveBeenCalled();
      expect(ffmpegService.probe).not.toHaveBeenCalled();
    });

    it.each([VideoStatus.Ready, VideoStatus.Failed, VideoStatus.Uploading])(
      "should skip without touching storage when the video is '%s'",
      async (status) => {
        videosService.findById.mockResolvedValue({ id: VIDEO_ID, status });

        await expect(service.process(VIDEO_ID)).resolves.toBe('skipped');

        expect(storageService.headObject).not.toHaveBeenCalled();
        expect(videosService.markReady).not.toHaveBeenCalled();
      },
    );

    it('should report skipped when the row left processing before markReady', async () => {
      videosService.markReady.mockResolvedValue(false);

      await expect(service.process(VIDEO_ID)).resolves.toBe('skipped');
    });
  });

  describe('terminal failures', () => {
    it('should fail with SOURCE_OBJECT_MISSING when the original is gone', async () => {
      storageService.headObject.mockRejectedValue(
        new StorageObjectNotFoundError(`${VIDEO_ID}/original`),
      );

      await expectTerminal('SOURCE_OBJECT_MISSING');
      expect(ffmpegService.probe).not.toHaveBeenCalled();
    });

    it('should fail with NO_VIDEO_STREAM when ffprobe cannot read the media', async () => {
      ffmpegService.probe.mockRejectedValue(
        new MediaNotReadableError(SOURCE_URL, 'exit code 1'),
      );

      await expectTerminal('NO_VIDEO_STREAM');
      expect(ffmpegService.extractFrame).not.toHaveBeenCalled();
    });

    it('should fail with NO_VIDEO_STREAM when the media has no video stream', async () => {
      ffmpegService.probe.mockResolvedValue(probeResult({ video: null }));

      await expectTerminal('NO_VIDEO_STREAM');
      expect(ffmpegService.extractFrame).not.toHaveBeenCalled();
    });
  });

  describe('transient failures', () => {
    it('should propagate an unexpected headObject error as-is', async () => {
      const error = new Error('connect ECONNREFUSED');
      storageService.headObject.mockRejectedValue(error);

      await expect(service.process(VIDEO_ID)).rejects.toBe(error);
    });

    it('should propagate an extractFrame failure as-is', async () => {
      const error = new Error('frame extraction failed');
      ffmpegService.extractFrame.mockRejectedValue(error);

      await expect(service.process(VIDEO_ID)).rejects.toBe(error);
      expect(videosService.markReady).not.toHaveBeenCalled();
    });

    it('should propagate a putObject failure as-is without marking ready', async () => {
      const error = new Error('storage unavailable');
      storageService.putObject.mockRejectedValue(error);

      await expect(service.process(VIDEO_ID)).rejects.toBe(error);
      expect(videosService.markReady).not.toHaveBeenCalled();
    });
  });

  describe('success', () => {
    it('should read the original through an internal presigned URL', async () => {
      await service.process(VIDEO_ID);

      expect(storageService.presignGetObject).toHaveBeenCalledWith(
        'videos',
        `${VIDEO_ID}/original`,
        { client: 'internal', expiresIn: 3600 },
      );
      expect(ffmpegService.probe).toHaveBeenCalledWith(SOURCE_URL);
    });

    it('should extract the thumbnail at 10% of the duration', async () => {
      await service.process(VIDEO_ID);

      expect(ffmpegService.extractFrame).toHaveBeenCalledWith(SOURCE_URL, 3);
    });

    it('should store the thumbnail before marking the video ready', async () => {
      await expect(service.process(VIDEO_ID)).resolves.toBe('ready');

      expect(storageService.putObject).toHaveBeenCalledWith(
        'thumbnails',
        `${VIDEO_ID}/thumbnail.jpg`,
        JPEG,
        'image/jpeg',
      );
      expect(storageService.putObject.mock.invocationCallOrder[0]).toBeLessThan(
        videosService.markReady.mock.invocationCallOrder[0],
      );
    });

    it('should mark ready with the probed metadata', async () => {
      ffmpegService.probe.mockResolvedValue(probeResult({ audioCodec: null }));

      await service.process(VIDEO_ID);

      expect(videosService.markReady).toHaveBeenCalledWith(VIDEO_ID, {
        duration_seconds: 30,
        width: 1280,
        height: 720,
        video_codec: 'h264',
        audio_codec: null,
        container_format: 'mov,mp4,m4a,3gp,3g2,mj2',
      });
    });
  });
});
