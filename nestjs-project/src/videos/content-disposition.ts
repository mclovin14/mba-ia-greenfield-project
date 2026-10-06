const UNSAFE_FILENAME_CHAR = /[^A-Za-z0-9._ -]/gu;
// encodeURIComponent leaves these literal, but they are not RFC 8187
// attr-char, and a literal `'` would break the UTF-8'' delimiter.
const NON_ATTR_CHAR = /['()*]/g;

/**
 * `attachment` with an ASCII-only `filename` fallback and the exact original
 * name in an RFC 8187 `filename*`, so no input can inject header syntax.
 */
export function buildAttachmentDisposition(filename: string): string {
  const safe = filename.replace(UNSAFE_FILENAME_CHAR, '_');
  const encoded = encodeURIComponent(filename).replace(
    NON_ATTR_CHAR,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`;
}
