import { Video, VideoStatus } from '../entities/video.entity';
import { toVideoResponse } from './video-response.dto';

const buildVideo = (): Video =>
  Object.assign(new Video(), {
    id: 'internal-uuid',
    public_id: 'abcdefghijk',
    channel_id: 'channel-uuid',
    title: 'Clip',
    description: null,
    status: VideoStatus.Ready,
    original_filename: 'clip.mp4',
    mime_type: 'video/mp4',
    size_bytes: 1024,
    upload_id: 'multipart-upload-id',
    duration_seconds: 12.5,
    width: 1920,
    height: 1080,
    video_codec: 'h264',
    audio_codec: 'aac',
    container_format: 'mov,mp4,m4a,3gp,3g2,mj2',
    processing_error: null,
    created_at: new Date('2026-10-05T10:00:00Z'),
    updated_at: new Date('2026-10-05T10:05:00Z'),
  });

describe('toVideoResponse', () => {
  it('should never expose id, channel_id or upload_id', () => {
    const response = toVideoResponse(buildVideo(), null);

    expect(response).not.toHaveProperty('id');
    expect(response).not.toHaveProperty('channel_id');
    expect(response).not.toHaveProperty('upload_id');
  });

  it('should use the given thumbnail URL as thumbnail_url', () => {
    const url = 'http://localhost:9000/thumbnails/x?X-Amz-Signature=abc';

    expect(toVideoResponse(buildVideo(), url).thumbnail_url).toBe(url);
  });

  it('should serialize timestamps as ISO-8601 strings', () => {
    const response = toVideoResponse(buildVideo(), null);

    expect(response.created_at).toBe('2026-10-05T10:00:00.000Z');
    expect(response.updated_at).toBe('2026-10-05T10:05:00.000Z');
  });
});
