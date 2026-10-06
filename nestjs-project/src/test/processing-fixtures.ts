import { readFile } from 'node:fs/promises';
import type { DataSource } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { STORAGE_BUCKETS } from '../storage/storage.constants';
import type { StorageService } from '../storage/storage.service';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { videoOriginalKey } from '../videos/video-object-keys';
import { getVideoFixture, type VideoFixtureKind } from './video-fixtures';

let counter = 0;

/** A video row already in `processing`, as SI-03.7 leaves it after complete. */
export async function seedProcessingVideo(
  dataSource: DataSource,
  sizeBytes = 2048,
): Promise<Video> {
  const suffix = `${process.pid}${++counter}`;
  const user = await dataSource.getRepository(User).save({
    email: `processing_${suffix}@example.com`,
    password: 'hashed',
  });
  const channel = await dataSource.getRepository(Channel).save({
    name: 'Processing',
    nickname: `proc${suffix}`,
    user_id: user.id,
  });
  return dataSource.getRepository(Video).save({
    public_id: `p${suffix}`.padEnd(11, '0').slice(0, 11),
    channel_id: channel.id,
    title: 'Clip',
    description: null,
    original_filename: 'clip.mp4',
    mime_type: 'video/mp4',
    size_bytes: sizeBytes,
    status: VideoStatus.Processing,
    upload_id: null,
  });
}

/** Uploads a generated media fixture as the video's original object. */
export async function uploadOriginal(
  storage: StorageService,
  videoId: string,
  kind: VideoFixtureKind,
): Promise<void> {
  const body = await readFile(await getVideoFixture(kind));
  await storage.putObject(
    STORAGE_BUCKETS.VIDEOS,
    videoOriginalKey(videoId),
    body,
    'video/mp4',
  );
}
