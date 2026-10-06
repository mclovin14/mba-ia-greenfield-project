export class StorageUploadNotFoundError extends Error {
  constructor(key: string) {
    super(`Multipart upload not found for key ${key}`);
    this.name = this.constructor.name;
  }
}

export class StorageObjectNotFoundError extends Error {
  constructor(key: string) {
    super(`Object not found for key ${key}`);
    this.name = this.constructor.name;
  }
}

export class StorageInvalidPartsError extends Error {
  constructor(key: string, reason: string) {
    super(`Invalid parts for key ${key}: ${reason}`);
    this.name = this.constructor.name;
  }
}
