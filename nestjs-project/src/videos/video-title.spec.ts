import { deriveDefaultTitle } from './video-title';

describe('deriveDefaultTitle', () => {
  it('should strip only the last extension', () => {
    expect(deriveDefaultTitle('Minhas Férias.final.mp4')).toBe(
      'Minhas Férias.final',
    );
  });

  it.each(['.mp4', '   '])(
    "should fall back to 'Untitled' when %p leaves nothing",
    (filename) => {
      expect(deriveDefaultTitle(filename)).toBe('Untitled');
    },
  );

  it('should cut a long name to 100 characters', () => {
    const title = deriveDefaultTitle(`${'a'.repeat(300)}.mp4`);

    expect(title).toHaveLength(100);
  });

  it('should keep a name without extension', () => {
    expect(deriveDefaultTitle('  raw-footage  ')).toBe('raw-footage');
  });
});
