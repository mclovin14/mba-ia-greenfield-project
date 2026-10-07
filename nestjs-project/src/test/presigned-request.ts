import {
  AbortMultipartUploadCommand,
  DeleteObjectsCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { request, type IncomingHttpHeaders } from 'node:http';
import { Readable } from 'node:stream';

export interface PresignedResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface PresignedRequestOptions {
  method: 'GET' | 'PUT' | 'OPTIONS' | 'HEAD';
  body?: Buffer | Readable;
  headers?: Record<string, string>;
}

/**
 * Sends a request to a presigned URL from inside the container. The URL host
 * (S3_PUBLIC_ENDPOINT, as seen by the browser) is swapped for S3_ENDPOINT on
 * the connection, while the `Host` header keeps the signed host so SigV4
 * still validates.
 */
export function requestPresigned(
  url: string,
  options: PresignedRequestOptions,
): Promise<PresignedResponse> {
  const signed = new URL(url);
  const internal = new URL(process.env.S3_ENDPOINT ?? 'http://minio:9000');
  const headers: Record<string, string> = {
    host: signed.host,
    ...options.headers,
  };
  if (Buffer.isBuffer(options.body)) {
    headers['content-length'] = String(options.body.length);
  }

  return new Promise((resolve, reject) => {
    const req = request(
      {
        protocol: internal.protocol,
        hostname: internal.hostname,
        port: internal.port,
        method: options.method,
        path: `${signed.pathname}${signed.search}`,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);

    if (options.body instanceof Readable) {
      options.body.on('error', reject);
      options.body.pipe(req);
    } else {
      req.end(options.body);
    }
  });
}

export function createTestS3Client(): S3Client {
  return new S3Client({
    region: process.env.S3_REGION ?? 'us-east-1',
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    },
  });
}

/** Removes every object and pending multipart upload from a bucket. */
export async function emptyBucket(bucket: string): Promise<void> {
  const client = createTestS3Client();
  try {
    await removeObjectsAndUploads(client, bucket);
  } finally {
    client.destroy();
  }
}

async function removeObjectsAndUploads(
  client: S3Client,
  bucket: string,
): Promise<void> {
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
    );
    const objects = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
    if (objects.length > 0) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objects },
        }),
      );
    }
    token = page.NextContinuationToken;
  } while (token);

  const uploads = await client.send(
    new ListMultipartUploadsCommand({ Bucket: bucket }),
  );
  for (const upload of uploads.Uploads ?? []) {
    await client.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: upload.Key!,
        UploadId: upload.UploadId!,
      }),
    );
  }
}
