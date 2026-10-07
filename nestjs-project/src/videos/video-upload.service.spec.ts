import { Test } from '@nestjs/testing';
import type { Channel } from '../channels/entities/channel.entity';
import { ChannelsService } from '../channels/channels.service';
import { ChannelNotFoundException } from '../channels/exceptions/channel-not-found.exception';
import { StorageUnavailableException } from '../storage/exceptions/storage-unavailable.exception';
import {
  StorageInvalidPartsError,
  StorageObjectNotFoundError,
  StorageUploadNotFoundError,
} from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import { VideoProcessingQueue } from '../video-processing/video-processing.queue';
import type { InitiateUploadDto } from './dto/initiate-upload.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { InvalidUploadStateException } from './exceptions/invalid-upload-state.exception';
import { PartNumberOutOfRangeException } from './exceptions/part-number-out-of-range.exception';
import { UploadIncompleteException } from './exceptions/upload-incomplete.exception';
import { VideoFileTooLargeException } from './exceptions/video-file-too-large.exception';
import { VideoNotFoundException } from './exceptions/video-not-found.exception';
import { VideoUploadService } from './video-upload.service';
import type { CreateVideoDraftInput } from './videos.service';
import { VideosService } from './videos.service';

const USER_ID = 'user-uuid';
const CHANNEL = { id: 'channel-uuid', user_id: USER_ID } as Channel;
const MiB = 1024 ** 2;

// 2 parts of 16 MiB.
const uploadingVideo = (overrides: Partial<Video> = {}): Video =>
  Object.assign(new Video(), {
    id: 'video-uuid',
    public_id: 'abcdefghijk',
    status: VideoStatus.Uploading,
    size_bytes: 20 * MiB,
    upload_id: 'upload-id',
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  });

const processingVideo = (): Video =>
  uploadingVideo({ status: VideoStatus.Processing, upload_id: null });

const buildDto = (overrides: Partial<InitiateUploadDto> = {}) =>
  ({
    filename: 'aula.mp4',
    mime_type: 'video/mp4',
    size_bytes: 50_000_000,
    ...overrides,
  }) as InitiateUploadDto;

describe('VideoUploadService', () => {
  let service: VideoUploadService;
  let channelsService: { findByUserId: jest.Mock };
  let videosService: {
    createDraft: jest.Mock;
    setUploadId: jest.Mock;
    delete: jest.Mock;
    findOwnedByPublicId: jest.Mock;
    deleteIfStatus: jest.Mock;
    transitionStatus: jest.Mock;
    findById: jest.Mock;
  };
  let videoProcessingQueue: { enqueue: jest.Mock };
  let storageService: {
    createMultipartUpload: jest.Mock;
    presignUploadPart: jest.Mock;
    listParts: jest.Mock;
    abortMultipartUpload: jest.Mock;
    deleteObject: jest.Mock;
    completeMultipartUpload: jest.Mock;
    headObject: jest.Mock;
  };

  beforeEach(async () => {
    channelsService = { findByUserId: jest.fn().mockResolvedValue(CHANNEL) };
    videosService = {
      createDraft: jest.fn((input: CreateVideoDraftInput) =>
        Promise.resolve(
          Object.assign(new Video(), {
            id: 'video-uuid',
            public_id: 'abcdefghijk',
            channel_id: input.channelId,
            title: input.title,
            description: null,
            status: VideoStatus.Uploading,
            original_filename: input.originalFilename,
            mime_type: input.mimeType,
            size_bytes: input.sizeBytes,
            created_at: new Date(),
            updated_at: new Date(),
          }),
        ),
      ),
      setUploadId: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      findOwnedByPublicId: jest.fn().mockResolvedValue(uploadingVideo()),
      deleteIfStatus: jest.fn().mockResolvedValue(true),
      transitionStatus: jest.fn().mockResolvedValue(true),
      findById: jest.fn().mockResolvedValue(processingVideo()),
    };
    videoProcessingQueue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    storageService = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-id'),
      presignUploadPart: jest.fn(
        (_key: string, _uploadId: string, partNumber: number) =>
          Promise.resolve(`http://storage/part-${partNumber}`),
      ),
      listParts: jest.fn().mockResolvedValue([]),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      deleteObject: jest.fn().mockResolvedValue(undefined),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      headObject: jest.fn().mockResolvedValue({ contentLength: 20 * MiB }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        VideoUploadService,
        { provide: ChannelsService, useValue: channelsService },
        { provide: VideosService, useValue: videosService },
        { provide: StorageService, useValue: storageService },
        { provide: VideoProcessingQueue, useValue: videoProcessingQueue },
      ],
    }).compile();

    service = moduleRef.get(VideoUploadService);
  });

  const draftInput = (): CreateVideoDraftInput =>
    (videosService.createDraft.mock.calls as [CreateVideoDraftInput][])[0][0];

  it('should delete the draft and rethrow when createMultipartUpload fails', async () => {
    const error = new StorageUnavailableException();
    storageService.createMultipartUpload.mockRejectedValueOnce(error);

    await expect(service.initiate(USER_ID, buildDto())).rejects.toBe(error);
    expect(videosService.delete).toHaveBeenCalledWith('video-uuid');
    expect(videosService.setUploadId).not.toHaveBeenCalled();
  });

  it('should open the multipart upload on {id}/original and persist its id', async () => {
    await service.initiate(USER_ID, buildDto());

    expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
      'video-uuid/original',
      'video/mp4',
    );
    expect(videosService.setUploadId).toHaveBeenCalledWith(
      'video-uuid',
      'upload-id',
    );
  });

  it.each([
    [1, 1],
    [16 * MiB, 1],
    [16 * MiB + 1, 2],
    [10 * 1024 * MiB, 640],
  ])('should plan %p bytes as %p part(s)', async (sizeBytes, partCount) => {
    const { upload } = await service.initiate(
      USER_ID,
      buildDto({ size_bytes: sizeBytes }),
    );

    expect(upload).toEqual({
      part_size_bytes: 16 * MiB,
      part_count: partCount,
      max_part_urls_per_request: 100,
    });
  });

  it('should prefer an explicit title over the filename default', async () => {
    await service.initiate(USER_ID, buildDto({ title: 'Minha aula' }));

    expect(draftInput().title).toBe('Minha aula');
  });

  it('should default the title to the filename without its extension', async () => {
    const { video } = await service.initiate(USER_ID, buildDto());

    expect(draftInput().title).toBe('aula');
    expect(video.title).toBe('aula');
    expect(video.thumbnail_url).toBeNull();
  });

  it('should propagate CHANNEL_NOT_FOUND without creating a draft', async () => {
    channelsService.findByUserId.mockRejectedValueOnce(
      new ChannelNotFoundException(),
    );

    await expect(service.initiate(USER_ID, buildDto())).rejects.toThrow(
      ChannelNotFoundException,
    );
    expect(videosService.createDraft).not.toHaveBeenCalled();
    expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
  });

  describe('upload session', () => {
    const PUBLIC_ID = 'abcdefghijk';

    it.each([
      [
        'presignPartUrls',
        (svc: VideoUploadService) =>
          svc.presignPartUrls(USER_ID, PUBLIC_ID, [1]),
      ],
      [
        'listUploadedParts',
        (svc: VideoUploadService) => svc.listUploadedParts(USER_ID, PUBLIC_ID),
      ],
      [
        'cancel',
        (svc: VideoUploadService) => {
          videosService.deleteIfStatus.mockResolvedValueOnce(false);
          return svc.cancel(USER_ID, PUBLIC_ID);
        },
      ],
    ])(
      '%s should throw INVALID_UPLOAD_STATE outside uploading',
      async (_name, call) => {
        videosService.findOwnedByPublicId.mockResolvedValueOnce(
          processingVideo(),
        );

        await expect(call(service)).rejects.toThrow(
          InvalidUploadStateException,
        );
      },
    );

    it('should reject a part number above part_count', async () => {
      await expect(
        service.presignPartUrls(USER_ID, PUBLIC_ID, [1, 3]),
      ).rejects.toThrow(PartNumberOutOfRangeException);
      expect(storageService.presignUploadPart).not.toHaveBeenCalled();
    });

    it('should return the URLs in the request order with a 3600 s expiry', async () => {
      const before = Date.now();

      const result = await service.presignPartUrls(USER_ID, PUBLIC_ID, [2, 1]);

      expect(result.parts).toEqual([
        { part_number: 2, url: 'http://storage/part-2' },
        { part_number: 1, url: 'http://storage/part-1' },
      ]);
      expect(storageService.presignUploadPart).toHaveBeenCalledWith(
        'video-uuid/original',
        'upload-id',
        2,
        3600,
      );
      const expiresAt = Date.parse(result.expires_at);
      expect(expiresAt).toBeGreaterThanOrEqual(before + 3600_000);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + 3600_000);
    });

    it('should map stored parts ascending by part_number', async () => {
      storageService.listParts.mockResolvedValueOnce([
        { partNumber: 2, etag: '"b"', size: 10 },
        { partNumber: 1, etag: '"a"', size: 16 * MiB },
      ]);

      const result = await service.listUploadedParts(USER_ID, PUBLIC_ID);

      expect(result.parts).toEqual([
        { part_number: 1, size_bytes: 16 * MiB, etag: '"a"' },
        { part_number: 2, size_bytes: 10, etag: '"b"' },
      ]);
    });

    it('should not touch storage when the conditional delete affects no row', async () => {
      videosService.deleteIfStatus.mockResolvedValueOnce(false);

      await expect(service.cancel(USER_ID, PUBLIC_ID)).rejects.toThrow(
        InvalidUploadStateException,
      );
      expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
      expect(storageService.deleteObject).not.toHaveBeenCalled();
    });

    it('should still delete the object when the abort finds no upload', async () => {
      storageService.abortMultipartUpload.mockRejectedValueOnce(
        new StorageUploadNotFoundError('video-uuid/original'),
      );

      await service.cancel(USER_ID, PUBLIC_ID);

      expect(videosService.deleteIfStatus).toHaveBeenCalledWith(
        'video-uuid',
        VideoStatus.Uploading,
      );
      expect(storageService.deleteObject).toHaveBeenCalledWith(
        'videos',
        'video-uuid/original',
      );
    });

    it('should propagate unexpected abort errors', async () => {
      const error = new StorageUnavailableException();
      storageService.abortMultipartUpload.mockRejectedValueOnce(error);

      await expect(service.cancel(USER_ID, PUBLIC_ID)).rejects.toBe(error);
      expect(storageService.deleteObject).not.toHaveBeenCalled();
    });
  });

  describe('complete', () => {
    const PUBLIC_ID = 'abcdefghijk';
    const KEY = 'video-uuid/original';
    const BOTH_PARTS = [
      { partNumber: 2, etag: '"b"', size: 4 * MiB },
      { partNumber: 1, etag: '"a"', size: 16 * MiB },
    ];

    beforeEach(() => {
      storageService.listParts.mockResolvedValue(BOTH_PARTS);
    });

    it('should complete with ascending parts, flip to processing with the real size and enqueue', async () => {
      const result = await service.complete(USER_ID, PUBLIC_ID);

      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        KEY,
        'upload-id',
        [
          { partNumber: 1, etag: '"a"' },
          { partNumber: 2, etag: '"b"' },
        ],
      );
      expect(videosService.transitionStatus).toHaveBeenCalledWith(
        'video-uuid',
        VideoStatus.Uploading,
        {
          status: VideoStatus.Processing,
          size_bytes: 20 * MiB,
          upload_id: null,
        },
      );
      expect(videoProcessingQueue.enqueue).toHaveBeenCalledWith('video-uuid');
      expect(result.status).toBe(VideoStatus.Processing);
    });

    it('should only re-enqueue when the video is already processing', async () => {
      videosService.findOwnedByPublicId.mockResolvedValueOnce(
        processingVideo(),
      );

      await service.complete(USER_ID, PUBLIC_ID);

      expect(videoProcessingQueue.enqueue).toHaveBeenCalledWith('video-uuid');
      expect(storageService.listParts).not.toHaveBeenCalled();
      expect(videosService.transitionStatus).not.toHaveBeenCalled();
    });

    it.each([VideoStatus.Ready, VideoStatus.Failed])(
      'should reject a %s video with INVALID_UPLOAD_STATE',
      async (status) => {
        videosService.findOwnedByPublicId.mockResolvedValueOnce(
          uploadingVideo({ status, upload_id: null }),
        );

        await expect(service.complete(USER_ID, PUBLIC_ID)).rejects.toThrow(
          InvalidUploadStateException,
        );
        expect(videoProcessingQueue.enqueue).not.toHaveBeenCalled();
      },
    );

    it('should reject missing parts with UPLOAD_INCOMPLETE without completing', async () => {
      storageService.listParts.mockResolvedValueOnce([BOTH_PARTS[1]]);

      await expect(service.complete(USER_ID, PUBLIC_ID)).rejects.toThrow(
        UploadIncompleteException,
      );
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('should map StorageInvalidPartsError to UPLOAD_INCOMPLETE', async () => {
      storageService.completeMultipartUpload.mockRejectedValueOnce(
        new StorageInvalidPartsError(KEY, 'EntityTooSmall'),
      );

      await expect(service.complete(USER_ID, PUBLIC_ID)).rejects.toThrow(
        UploadIncompleteException,
      );
      expect(videosService.transitionStatus).not.toHaveBeenCalled();
    });

    it('should continue after NoSuchUpload when the object already exists', async () => {
      storageService.completeMultipartUpload.mockRejectedValueOnce(
        new StorageUploadNotFoundError(KEY),
      );

      await service.complete(USER_ID, PUBLIC_ID);

      expect(videosService.transitionStatus).toHaveBeenCalled();
      expect(videoProcessingQueue.enqueue).toHaveBeenCalled();
    });

    it('should reject NoSuchUpload without an object as UPLOAD_INCOMPLETE', async () => {
      storageService.completeMultipartUpload.mockRejectedValueOnce(
        new StorageUploadNotFoundError(KEY),
      );
      storageService.headObject.mockRejectedValueOnce(
        new StorageObjectNotFoundError(KEY),
      );

      await expect(service.complete(USER_ID, PUBLIC_ID)).rejects.toThrow(
        UploadIncompleteException,
      );
      expect(videosService.transitionStatus).not.toHaveBeenCalled();
    });

    it('should delete an over-cap object, mark the video failed and throw 422', async () => {
      storageService.headObject.mockResolvedValueOnce({
        contentLength: 10 * 1024 ** 3 + 1,
      });

      await expect(service.complete(USER_ID, PUBLIC_ID)).rejects.toThrow(
        VideoFileTooLargeException,
      );
      expect(storageService.deleteObject).toHaveBeenCalledWith('videos', KEY);
      expect(videosService.transitionStatus).toHaveBeenCalledWith(
        'video-uuid',
        VideoStatus.Uploading,
        {
          status: VideoStatus.Failed,
          processing_error: 'FILE_TOO_LARGE',
          upload_id: null,
        },
      );
      expect(videoProcessingQueue.enqueue).not.toHaveBeenCalled();
    });

    it('should accept an object exactly at the cap', async () => {
      storageService.headObject.mockResolvedValueOnce({
        contentLength: 10 * 1024 ** 3,
      });

      await service.complete(USER_ID, PUBLIC_ID);

      expect(storageService.deleteObject).not.toHaveBeenCalled();
      expect(videoProcessingQueue.enqueue).toHaveBeenCalled();
    });

    describe('when the conditional transition affects no row', () => {
      beforeEach(() => {
        videosService.transitionStatus.mockResolvedValueOnce(false);
      });

      it('should enqueue when a concurrent complete already moved it to processing', async () => {
        const result = await service.complete(USER_ID, PUBLIC_ID);

        expect(videoProcessingQueue.enqueue).toHaveBeenCalledWith('video-uuid');
        expect(result.status).toBe(VideoStatus.Processing);
      });

      it('should throw INVALID_UPLOAD_STATE when the row is now failed', async () => {
        videosService.findById.mockResolvedValueOnce(
          uploadingVideo({ status: VideoStatus.Failed }),
        );

        await expect(service.complete(USER_ID, PUBLIC_ID)).rejects.toThrow(
          InvalidUploadStateException,
        );
        expect(videoProcessingQueue.enqueue).not.toHaveBeenCalled();
      });

      it('should delete the assembled object and throw VIDEO_NOT_FOUND when the row is gone', async () => {
        videosService.findById.mockResolvedValueOnce(null);

        await expect(service.complete(USER_ID, PUBLIC_ID)).rejects.toThrow(
          VideoNotFoundException,
        );
        expect(storageService.deleteObject).toHaveBeenCalledWith('videos', KEY);
        expect(videoProcessingQueue.enqueue).not.toHaveBeenCalled();
      });
    });
  });
});
