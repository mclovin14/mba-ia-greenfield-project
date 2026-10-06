import { randomBytes } from 'node:crypto';
import { PUBLIC_ID_BYTES } from './videos.constants';

/** 8 random bytes as base64url: always 11 chars from `[A-Za-z0-9_-]`. */
export function generatePublicId(): string {
  return randomBytes(PUBLIC_ID_BYTES).toString('base64url');
}
