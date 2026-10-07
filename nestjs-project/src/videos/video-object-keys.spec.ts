import { videoOriginalKey, videoThumbnailKey } from './video-object-keys';

describe('video-object-keys', () => {
  const id = '3f6c2a9e-8b1d-4c7a-9e2f-1a2b3c4d5e6f';

  it('should build the original object key as {id}/original', () => {
    expect(videoOriginalKey(id)).toBe(`${id}/original`);
  });

  it('should build the thumbnail key as {id}/thumbnail.jpg', () => {
    expect(videoThumbnailKey(id)).toBe(`${id}/thumbnail.jpg`);
  });
});
