import {
  DEFAULT_VIDEO_TITLE,
  VIDEO_TITLE_MAX_LENGTH,
} from './videos.constants';

export function deriveDefaultTitle(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  const withoutExtension =
    lastDot === -1 ? filename : filename.slice(0, lastDot);
  const title = withoutExtension.trim().slice(0, VIDEO_TITLE_MAX_LENGTH);
  return title.length > 0 ? title : DEFAULT_VIDEO_TITLE;
}
