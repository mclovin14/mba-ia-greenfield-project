import { buildAttachmentDisposition } from './content-disposition';

const parse = (header: string): { safe: string; encoded: string } => {
  const match = /^attachment; filename="(.*)"; filename\*=UTF-8''(.*)$/.exec(
    header,
  );
  if (!match) throw new Error(`unexpected header: ${header}`);
  return { safe: match[1], encoded: match[2] };
};

describe('buildAttachmentDisposition', () => {
  it('should keep a plain ASCII filename in both parameters', () => {
    expect(buildAttachmentDisposition('aula-1_final.mp4')).toBe(
      `attachment; filename="aula-1_final.mp4"; filename*=UTF-8''aula-1_final.mp4`,
    );
  });

  it('should replace accents and emoji in the fallback and UTF-8 encode the original', () => {
    const filename = 'introdução 🎬.mp4';

    const { safe, encoded } = parse(buildAttachmentDisposition(filename));

    expect(safe).toBe('introdu__o _.mp4');
    expect(encoded).toBe('introdu%C3%A7%C3%A3o%20%F0%9F%8E%AC.mp4');
    expect(decodeURIComponent(encoded)).toBe(filename);
  });

  it('should never emit header syntax characters literally in either parameter', () => {
    const filename = `a'b(c)d*e"f;g\\h\r\ni.mp4`;

    const { safe, encoded } = parse(buildAttachmentDisposition(filename));

    for (const char of [`'`, '(', ')', '*', '"', ';', '\\', '\r', '\n']) {
      expect(safe).not.toContain(char);
      expect(encoded).not.toContain(char);
    }
    expect(safe).toBe('a_b_c_d_e_f_g_h__i.mp4');
    expect(encoded).toBe('a%27b%28c%29d%2Ae%22f%3Bg%5Ch%0D%0Ai.mp4');
    expect(decodeURIComponent(encoded)).toBe(filename);
  });
});
