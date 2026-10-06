import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { Video } from './entities/video.entity';
import { VideoAccessPolicy } from './video-access.policy';
import { VideosService } from './videos.service';

const uniqueViolationOn = (column: string): QueryFailedError =>
  new QueryFailedError(
    'INSERT INTO "videos"',
    [],
    Object.assign(new Error('duplicate key value'), {
      code: '23505',
      detail: `Key (${column})=(abc) already exists.`,
    }),
  );

const DRAFT_INPUT = {
  channelId: 'channel-id',
  title: 'Clip',
  originalFilename: 'clip.mp4',
  mimeType: 'video/mp4',
  sizeBytes: 1024,
};

describe('VideosService', () => {
  let service: VideosService;
  let insert: jest.Mock;

  beforeEach(async () => {
    insert = jest.fn();
    const moduleRef = await Test.createTestingModule({
      providers: [
        VideosService,
        VideoAccessPolicy,
        {
          provide: getRepositoryToken(Video),
          useValue: { create: (data: Partial<Video>) => ({ ...data }), insert },
        },
      ],
    }).compile();

    service = moduleRef.get(VideosService);
  });

  const insertedPublicIds = (): string[] =>
    (insert.mock.calls as [Partial<Video>][]).map(([v]) => v.public_id!);

  describe('createDraft', () => {
    it('should retry with a new public_id after a public_id collision', async () => {
      insert
        .mockRejectedValueOnce(uniqueViolationOn('public_id'))
        .mockResolvedValueOnce(undefined);

      const video = await service.createDraft(DRAFT_INPUT);

      const [first, second] = insertedPublicIds();
      expect(insert).toHaveBeenCalledTimes(2);
      expect(second).not.toBe(first);
      expect(video.public_id).toBe(second);
    });

    it('should rethrow a unique violation on another column without retrying', async () => {
      const error = uniqueViolationOn('channel_id');
      insert.mockRejectedValueOnce(error);

      await expect(service.createDraft(DRAFT_INPUT)).rejects.toBe(error);
      expect(insert).toHaveBeenCalledTimes(1);
    });

    it('should give up after 5 colliding attempts', async () => {
      insert.mockRejectedValue(uniqueViolationOn('public_id'));

      await expect(service.createDraft(DRAFT_INPUT)).rejects.toThrow(
        /after 5 attempts/,
      );
      expect(insert).toHaveBeenCalledTimes(5);
    });
  });
});
