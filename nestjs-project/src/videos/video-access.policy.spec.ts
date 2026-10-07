import type { Channel } from '../channels/entities/channel.entity';
import type { Video } from './entities/video.entity';
import { VideoNotFoundException } from './exceptions/video-not-found.exception';
import { VideoAccessPolicy } from './video-access.policy';

const OWNER_ID = 'owner-user-id';

const videoOwnedBy = (userId: string): Video =>
  ({ id: 'video-id', channel: { user_id: userId } as Channel }) as Video;

describe('VideoAccessPolicy', () => {
  const policy = new VideoAccessPolicy();

  it('should let the owner through', () => {
    expect(() =>
      policy.assertOwner(videoOwnedBy(OWNER_ID), OWNER_ID),
    ).not.toThrow();
  });

  it('should reject a non-owner with VideoNotFoundException', () => {
    expect(() =>
      policy.assertOwner(videoOwnedBy(OWNER_ID), 'someone-else'),
    ).toThrow(VideoNotFoundException);
  });

  it('should reject a missing video with the same exception', () => {
    expect(() => policy.assertOwner(null, OWNER_ID)).toThrow(
      VideoNotFoundException,
    );
  });
});
