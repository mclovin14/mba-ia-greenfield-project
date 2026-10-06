import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoNotFoundException } from './exceptions/video-not-found.exception';
import { VideoAccessPolicy } from './video-access.policy';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

describe('VideosService (integration)', () => {
  let dataSource: DataSource;
  let service: VideosService;
  let counter = 0;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    service = new VideosService(
      dataSource.getRepository(Video),
      new VideoAccessPolicy(),
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  const createOwner = async (): Promise<{ user: User; channel: Channel }> => {
    const user = await dataSource.getRepository(User).save({
      email: `videos_svc_${++counter}@example.com`,
      password: 'hashed',
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: 'Owner',
      nickname: `videosvc${counter}`,
      user_id: user.id,
    });
    return { user, channel };
  };

  const draftFor = (channel: Channel): Promise<Video> =>
    service.createDraft({
      channelId: channel.id,
      title: 'Clip',
      originalFilename: 'clip.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 2048,
    });

  describe('createDraft', () => {
    it("should persist an 'uploading' draft with no description and an 11-char public_id", async () => {
      const { channel } = await createOwner();

      const { id } = await draftFor(channel);

      const stored = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id });
      expect(stored.status).toBe(VideoStatus.Uploading);
      expect(stored.description).toBeNull();
      expect(stored.public_id).toMatch(PUBLIC_ID_PATTERN);
      expect(stored.channel_id).toBe(channel.id);
    });
  });

  describe('findOwnedByPublicId', () => {
    it('should return the video to its owner', async () => {
      const { user, channel } = await createOwner();
      const draft = await draftFor(channel);

      const video = await service.findOwnedByPublicId(draft.public_id, user.id);

      expect(video.id).toBe(draft.id);
    });

    it('should throw VideoNotFoundException for another user', async () => {
      const { channel } = await createOwner();
      const { user: stranger } = await createOwner();
      const draft = await draftFor(channel);

      await expect(
        service.findOwnedByPublicId(draft.public_id, stranger.id),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('should throw VideoNotFoundException for an unknown publicId', async () => {
      const { user } = await createOwner();

      await expect(
        service.findOwnedByPublicId('doesNotExst', user.id),
      ).rejects.toThrow(VideoNotFoundException);
    });
  });

  describe('setUploadId / delete', () => {
    it('should store the upload id and then remove the draft', async () => {
      const { channel } = await createOwner();
      const { id } = await draftFor(channel);
      const repository = dataSource.getRepository(Video);

      await service.setUploadId(id, `upload-${randomUUID()}`);
      const updated = await repository.findOneByOrFail({ id });
      await service.delete(id);

      expect(updated.upload_id).toMatch(/^upload-/);
      expect(await repository.findOneBy({ id })).toBeNull();
    });
  });

  describe('deleteIfStatus', () => {
    it('should delete only when the row is still in the given status', async () => {
      const { channel } = await createOwner();
      const { id } = await draftFor(channel);
      const repository = dataSource.getRepository(Video);
      await repository.update({ id }, { status: VideoStatus.Processing });

      const deletedWhileProcessing = await service.deleteIfStatus(
        id,
        VideoStatus.Uploading,
      );
      const deletedWhenMatching = await service.deleteIfStatus(
        id,
        VideoStatus.Processing,
      );

      expect(deletedWhileProcessing).toBe(false);
      expect(deletedWhenMatching).toBe(true);
      expect(await repository.findOneBy({ id })).toBeNull();
    });
  });
});
