import { Test } from '@nestjs/testing';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoNotFoundException } from './exceptions/video-not-found.exception';
import { VideoNotReadyException } from './exceptions/video-not-ready.exception';
import { VideoPlaybackService } from './video-playback.service';
import { VideosService } from './videos.service';

const USER_ID = 'user-uuid';
const PUBLIC_ID = 'abcdefghijk';
const PRESIGNED_URL =
  'http://localhost:9000/thumbnails/video-uuid/thumbnail.jpg?X-Amz-Signature=sig';

const buildVideo = (status: VideoStatus): Video =>
  Object.assign(new Video(), {
    id: 'video-uuid',
    public_id: PUBLIC_ID,
    channel_id: 'channel-uuid',
    title: 'Aula',
    description: null,
    status,
    original_filename: 'aula.mp4',
    mime_type: 'video/mp4',
    size_bytes: 2048,
    upload_id: null,
    original_key: 'video-uuid/original',
    thumbnail_key:
      status === VideoStatus.Ready ? 'video-uuid/thumbnail.jpg' : null,
    duration_seconds: status === VideoStatus.Ready ? 3 : null,
    width: status === VideoStatus.Ready ? 320 : null,
    height: status === VideoStatus.Ready ? 240 : null,
    video_codec: status === VideoStatus.Ready ? 'h264' : null,
    audio_codec: status === VideoStatus.Ready ? 'aac' : null,
    container_format: status === VideoStatus.Ready ? 'mov,mp4' : null,
    processing_error: status === VideoStatus.Failed ? 'NO_VIDEO_STREAM' : null,
    created_at: new Date(),
    updated_at: new Date(),
  });

describe('VideoPlaybackService', () => {
  let service: VideoPlaybackService;
  let videosService: { findOwnedByPublicId: jest.Mock };
  let storageService: { presignGetObject: jest.Mock };

  beforeEach(async () => {
    videosService = { findOwnedByPublicId: jest.fn() };
    storageService = {
      presignGetObject: jest.fn().mockResolvedValue(PRESIGNED_URL),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        VideoPlaybackService,
        { provide: VideosService, useValue: videosService },
        { provide: StorageService, useValue: storageService },
      ],
    }).compile();

    service = moduleRef.get(VideoPlaybackService);
  });

  describe('getOwnedVideo', () => {
    it('should presign the thumbnail with the public client, a 900 s TTL and image/jpeg when ready', async () => {
      videosService.findOwnedByPublicId.mockResolvedValue(
        buildVideo(VideoStatus.Ready),
      );

      const response = await service.getOwnedVideo(USER_ID, PUBLIC_ID);

      expect(videosService.findOwnedByPublicId).toHaveBeenCalledWith(
        PUBLIC_ID,
        USER_ID,
      );
      expect(storageService.presignGetObject).toHaveBeenCalledWith(
        'thumbnails',
        'video-uuid/thumbnail.jpg',
        {
          client: 'public',
          expiresIn: 900,
          responseContentType: 'image/jpeg',
        },
      );
      expect(response.thumbnail_url).toBe(PRESIGNED_URL);
      expect(response.status).toBe(VideoStatus.Ready);
      expect(response).not.toHaveProperty('id');
    });

    it.each([
      VideoStatus.Uploading,
      VideoStatus.Processing,
      VideoStatus.Failed,
    ])(
      'should return thumbnail_url null without touching storage when %s',
      async (status) => {
        videosService.findOwnedByPublicId.mockResolvedValue(buildVideo(status));

        const response = await service.getOwnedVideo(USER_ID, PUBLIC_ID);

        expect(response.thumbnail_url).toBeNull();
        expect(response.status).toBe(status);
        expect(storageService.presignGetObject).not.toHaveBeenCalled();
      },
    );

    it('should propagate VideoNotFoundException for a non-owner or unknown video', async () => {
      videosService.findOwnedByPublicId.mockRejectedValue(
        new VideoNotFoundException(),
      );

      await expect(
        service.getOwnedVideo(USER_ID, PUBLIC_ID),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(storageService.presignGetObject).not.toHaveBeenCalled();
    });
  });

  describe.each([
    {
      method: 'getStreamUrl' as const,
      ttlSeconds: 21600,
      responseOptions: { responseContentType: 'video/mp4' },
    },
    {
      method: 'getDownloadUrl' as const,
      ttlSeconds: 900,
      responseOptions: {
        responseContentDisposition: `attachment; filename="aula.mp4"; filename*=UTF-8''aula.mp4`,
      },
    },
  ])('$method', ({ method, ttlSeconds, responseOptions }) => {
    it(`should presign the original with the public client and a ${ttlSeconds} s TTL when ready`, async () => {
      const now = new Date('2026-10-05T12:00:00.000Z');
      jest.useFakeTimers({ now, doNotFake: ['nextTick', 'setImmediate'] });
      videosService.findOwnedByPublicId.mockResolvedValue(
        buildVideo(VideoStatus.Ready),
      );

      try {
        const response = await service[method](USER_ID, PUBLIC_ID);

        expect(videosService.findOwnedByPublicId).toHaveBeenCalledWith(
          PUBLIC_ID,
          USER_ID,
        );
        expect(storageService.presignGetObject).toHaveBeenCalledWith(
          'videos',
          'video-uuid/original',
          { client: 'public', expiresIn: ttlSeconds, ...responseOptions },
        );
        expect(response).toEqual({
          url: PRESIGNED_URL,
          expires_at: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
        });
      } finally {
        jest.useRealTimers();
      }
    });

    it.each([
      VideoStatus.Uploading,
      VideoStatus.Processing,
      VideoStatus.Failed,
    ])(
      'should throw VideoNotReadyException without touching storage when %s',
      async (status) => {
        videosService.findOwnedByPublicId.mockResolvedValue(buildVideo(status));

        await expect(
          service[method](USER_ID, PUBLIC_ID),
        ).rejects.toBeInstanceOf(VideoNotReadyException);
        expect(storageService.presignGetObject).not.toHaveBeenCalled();
      },
    );
  });
});
