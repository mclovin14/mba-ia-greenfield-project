export const S3_CLIENTS = {
  INTERNAL: 'S3_INTERNAL_CLIENT',
  PUBLIC: 'S3_PUBLIC_CLIENT',
} as const;

export const STORAGE_BUCKETS = {
  VIDEOS: 'videos',
  THUMBNAILS: 'thumbnails',
} as const;

export type StorageBucket =
  (typeof STORAGE_BUCKETS)[keyof typeof STORAGE_BUCKETS];

export const STORAGE_ERROR_NAMES = {
  UPLOAD_NOT_FOUND: ['NoSuchUpload'],
  OBJECT_NOT_FOUND: ['NoSuchKey', 'NotFound'],
  INVALID_PARTS: ['EntityTooSmall', 'InvalidPart', 'InvalidPartOrder'],
  BUCKET_EXISTS: ['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'],
} as const;

export const INCOMPLETE_UPLOAD_EXPIRY_DAYS = 1;

export const LIST_PARTS_PAGE_SIZE = 1000;
