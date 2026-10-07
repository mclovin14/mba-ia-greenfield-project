import { parseProbeOutput, thumbnailTimestamp } from './media.utils';

const videoStream = {
  codec_type: 'video',
  codec_name: 'h264',
  width: 320,
  height: 240,
};
const audioStream = { codec_type: 'audio', codec_name: 'aac' };
const format = { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '3.000000' };

describe('parseProbeOutput', () => {
  it('should map the first video and audio streams, the container and the duration', () => {
    const result = parseProbeOutput({
      format,
      streams: [
        audioStream,
        videoStream,
        { ...videoStream, codec_name: 'mjpeg', width: 80, height: 60 },
      ],
    });

    expect(result).toEqual({
      durationSeconds: 3,
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      video: { width: 320, height: 240, codec: 'h264' },
      audioCodec: 'aac',
    });
  });

  it('should return a null audio codec for a video-only file', () => {
    const result = parseProbeOutput({ format, streams: [videoStream] });

    expect(result.audioCodec).toBeNull();
    expect(result.video).not.toBeNull();
  });

  it('should return video = null for an audio-only file', () => {
    const result = parseProbeOutput({ format, streams: [audioStream] });

    expect(result.video).toBeNull();
    expect(result.audioCodec).toBe('aac');
  });

  it('should return a null duration when format.duration is missing', () => {
    const result = parseProbeOutput({
      format: { format_name: format.format_name },
      streams: [videoStream],
    });

    expect(result.durationSeconds).toBeNull();
  });
});

describe('thumbnailTimestamp', () => {
  it.each([
    [30, 3],
    [2, 0.2],
    [1.5, 0],
    [null, 0],
  ])('should map a %p s duration to %p s', (duration, expected) => {
    expect(thumbnailTimestamp(duration)).toBeCloseTo(expected);
  });
});
