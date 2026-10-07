import { randomUUID } from 'node:crypto';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const TEN_GIB = 10 * 1024 * 1024 * 1024;

const pgCode = (error: unknown): string | undefined =>
  (error as QueryFailedError & { driverError?: { code?: string } }).driverError
    ?.code;

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channel: Channel;
  let counter = 0;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save({
      email: `video_owner_${++counter}@example.com`,
      password: 'hashed',
    });
    channel = await dataSource.getRepository(Channel).save({
      name: 'Owner',
      nickname: `owner${counter}`,
      user_id: user.id,
    });
  });

  const buildVideo = (overrides: Partial<Video> = {}): Partial<Video> => ({
    public_id: randomUUID().replace(/-/g, '').slice(0, 11),
    channel_id: channel.id,
    title: 'Clip',
    original_filename: 'clip.mp4',
    mime_type: 'video/mp4',
    size_bytes: 1024,
    ...overrides,
  });

  const insertCaught = async (data: Partial<Video>): Promise<unknown> => {
    try {
      await videoRepository.insert(data);
    } catch (error) {
      return error;
    }
    throw new Error('insert unexpectedly succeeded');
  };

  it('should reject a duplicate public_id with a unique violation (23505)', async () => {
    await videoRepository.insert(buildVideo({ public_id: 'dupPublicId' }));

    const error = await insertCaught(buildVideo({ public_id: 'dupPublicId' }));

    expect(pgCode(error)).toBe('23505');
  });

  it("should default status to 'uploading' and nullable metadata to null", async () => {
    const { id } = await videoRepository.save(buildVideo());

    const stored = await videoRepository.findOneByOrFail({ id });

    expect(stored.status).toBe(VideoStatus.Uploading);
    expect(stored.description).toBeNull();
    expect(stored.upload_id).toBeNull();
    expect(stored.processing_error).toBeNull();
  });

  it('should reject a status outside the enum domain', async () => {
    const error = await insertCaught(
      buildVideo({ status: 'archived' as VideoStatus }),
    );

    // 22P02 = invalid_text_representation (invalid enum input value)
    expect(pgCode(error)).toBe('22P02');
  });

  it('should reject a channel_id that does not exist (FK violation 23503)', async () => {
    const error = await insertCaught(buildVideo({ channel_id: randomUUID() }));

    expect(pgCode(error)).toBe('23503');
  });

  it('should read size_bytes above 2^31 back as a number', async () => {
    const { id } = await videoRepository.save(
      buildVideo({ size_bytes: TEN_GIB }),
    );

    const stored = await videoRepository.findOneByOrFail({ id });

    expect(stored.size_bytes).toBe(10737418240);
    expect(typeof stored.size_bytes).toBe('number');
  });

  it('should load the owning channel and the inverse channel.videos relation', async () => {
    const { id } = await videoRepository.save(buildVideo());

    const withChannel = await videoRepository.findOneOrFail({
      where: { id },
      relations: ['channel'],
    });
    const withVideos = await dataSource.getRepository(Channel).findOneOrFail({
      where: { id: channel.id },
      relations: ['videos'],
    });

    expect(withChannel.channel.id).toBe(channel.id);
    expect(withVideos.videos.map((v) => v.id)).toEqual([id]);
  });
});
