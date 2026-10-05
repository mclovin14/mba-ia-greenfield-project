---
libs:
  "@nestjs/bullmq":
    version: "^11.0.5"
    context7_id: "n/a — context7 MCP unavailable in this environment; sources: https://docs.nestjs.com/techniques/queues, https://github.com/nestjs/bull/releases, npm registry + published .d.ts of 11.0.5"
    fetched_at: "2026-10-05T11:58:57-03:00"
  bullmq:
    version: "^5.81.5"
    context7_id: "n/a — context7 MCP unavailable in this environment; sources: https://docs.bullmq.io (retrying-failing-jobs, jobs/job-ids, workers/graceful-shutdown, queues/auto-removal-of-jobs, changelog, migrate-from-v5-to-v6), npm registry + published .d.ts"
    fetched_at: "2026-10-05T11:58:57-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1146.0"
    context7_id: "n/a — context7 MCP unavailable in this environment; sources: https://github.com/aws/aws-sdk-js-v3 (supplemental-docs/CLIENTS.md, ERROR_HANDLING.md, MD5_FALLBACK.md, issue #6810), https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html, published .d.ts of 3.1146.0"
    fetched_at: "2026-10-05T11:58:57-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1146.0"
    context7_id: "n/a — context7 MCP unavailable in this environment; sources: https://github.com/aws/aws-sdk-js-v3/tree/main/packages/s3-request-presigner, @smithy/signature-v4 dist (MAX_PRESIGNED_TTL)"
    fetched_at: "2026-10-05T11:58:57-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-05T11:54:31-03:00"
---

# phase-03-videos — Library References

These are distilled docs for the libraries decided in this slice. **Context7 was not available** in the environment that produced this file (no `mcp__context7__*` tools were configured). Each library was checked instead against three sources: its official documentation pages, the npm registry metadata (versions, peer dependencies, release dates), and the `.d.ts` typings of the exact published versions. The typings came from an isolated, throw-away install inside the `nestjs-api` container, so the project's `node_modules` was not touched. Re-fetch via Context7 when it becomes available. Installed project baseline: `@nestjs/common`/`@nestjs/core` `^11.0.1`, CommonJS, Node v25.6.0 (container).

## @nestjs/bullmq

**Source:** docs.nestjs.com/techniques/queues, the nestjs/bull GitHub releases, and the npm registry. Maps to `phase-03-videos/TD-01` Decision A and `TD-04` (worker entrypoint).

### Version pin — discrepancy flagged

- The research doc recommends `@nestjs/bullmq@^11`. The registry's `latest` is now **12.0.0** (2026-08-27). Its release notes say it is "aligned with the Nest 12 release line" and published as **pure ESM**: CommonJS consumers need `require(esm)` and TS `moduleResolution` `node16`/`nodenext`/`bundler`, and deep imports no longer resolve.
- **Pin `^11.0.5`.** Its peers are `@nestjs/common`/`@nestjs/core` `^10 || ^11` and `bullmq ^3 || ^4 || ^5 || ^6`; the package depends on `@nestjs/bull-shared ^11.0.5`. This pin confirms the research doc's intent and is not a change.
- **Note:** `docs.nestjs.com` now serves the Nest 12 docs. The v11 docs are at `docs.nestjs.com/v11`. Every API below was cross-checked against the 11.0.5 typings.

### Root connection (async, from ConfigService)

```ts
BullModule.forRootAsync({
  imports: [ConfigModule],
  useFactory: async (configService: ConfigService) => ({
    connection: {
      host: configService.get('QUEUE_HOST'),
      port: configService.get('QUEUE_PORT'),
    },
  }),
  inject: [ConfigService],
});
```

- Root options: `connection`, `prefix` (default `bull`), `defaultJobOptions`, `extraOptions`.
- `extraOptions.manualRegistration?: boolean` exists in `shared-bull-config.interface.d.ts`, together with an injectable `BullRegistrar` (`bull.registrar.d.ts`). This lets the API process register the queue (producer) without starting workers.
- In this project, use a typed `registerAs` config (`ConfigType<typeof queueConfig>`) rather than raw `configService.get`, following the inherited config conventions.

### Queue registration, producer and consumer

```ts
BullModule.registerQueue({ name: 'video-processing' });
```

```ts
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';

constructor(@InjectQueue('video-processing') private readonly queue: Queue) {}
await this.queue.add('process-video', { videoId }, { jobId: `video-${videoId}` });
```

```ts
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import type { Job } from 'bullmq';

@Processor('video-processing')
export class VideoProcessingProcessor extends WorkerHost {
  async process(job: Job): Promise<any> { /* switch (job.name) */ }
}
```

- `WorkerHost` (11.0.5 typings): `abstract process(job: Job, token?: string): Promise<any>` and `get worker(): Worker`.
- BullMQ has no `@Process('name')`; branch on `job.name` inside `process()`.
- The consumer must be listed in the module's `providers`. A processor is instantiated, and therefore starts consuming, wherever its module is loaded. Keep the `@Processor` class in a module that only the worker entrypoint imports (`TD-04`); the API imports only the producer side.
- `@OnWorkerEvent('completed' | 'failed' | 'active' | …)` maps to BullMQ's `WorkerListener`:
  - `completed: (job, result, prev) => void`
  - `failed: (job | undefined, error, prev) => void`
- Exported tokens/helpers in 11.0.5: `getQueueToken(name)` and `getFlowProducerToken(name)`. Use `getQueueToken('video-processing')` with `app.get(...)` in integration tests to inspect enqueued jobs (testing guide, Message Queue: real broker).
- The sandboxed processors option (`processors: [path]`) is **not** used: there is no DI in the forked process. Process isolation comes from the separate `video-worker` Compose service (TD-04).

### Standalone worker process

There is no dedicated docs recipe. The pattern is `NestFactory.createApplicationContext(WorkerModule)`, which loads the module graph without the HTTP adapter, then `app.enableShutdownHooks()`. With shutdown hooks enabled, `@nestjs/bullmq` closes its workers on application shutdown.

## bullmq

**Source:** docs.bullmq.io, the npm registry, and the published typings. Maps to `phase-03-videos/TD-01` and `TD-09`.

### Version pin — discrepancy flagged

- `latest` is **6.3.11**; 6.0.0 was released 2026-07-30.
- v6 changes relevant here:
  - `ioredis` becomes an **optional peer** that must be installed explicitly;
  - `Queue#client` / `Worker#blockingClient` are removed;
  - legacy `repeat` is removed;
  - `Job#discard()` is removed (use `UnrecoverableError`);
  - the `paused` state is removed from `getJobCounts()`;
  - `Worker#resume()` / `Queue.resume()` become async.
- The 5.x line is still maintained (5.81.5, released 2026-09-10) and bundles `ioredis 5.11.1` as a regular dependency.
- **Pin `^5.81.5`.** It stays inside `TD-01`'s declared library set (`@nestjs/bullmq, bullmq`) with no extra `ioredis` dependency, and every API this phase needs is identical in 5.x and 6.x. Upgrading to v6 is a separate future task.
- Engines: `node >=14.17.0`.

### Retries and backoff (TD-09)

```ts
await queue.add('process-video', { videoId }, {
  jobId: `video-${videoId}`,
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 24 * 3600 },
});
```

- Exponential delay is `2 ^ (attempts - 1) * delay` ms. `jitter` takes a value from 0 to 1 and is optional.
- `attempts` and `backoff` can also go in the queue's `defaultJobOptions`.
- Processors must **throw `Error` objects** to fail.
- `import { UnrecoverableError } from 'bullmq'`: throwing it sends the job straight to failed with no further retries, whatever `attempts` says. Use it for domain-terminal failures such as "no video stream" (AMB-5).
- In the `failed` handler, distinguish a final failure from an intermediate one with `job.attemptsMade >= (job.opts.attempts ?? 1)`, or detect `UnrecoverableError` by name.

### Job ids (TD-03 idempotent enqueue)

- Custom `jobId`s are unique per queue. Adding a job with an existing id is **silently ignored** (a `duplicated` event fires). This is what makes "complete called twice" idempotent.
- Once a job is removed (`removeOnComplete`/`removeOnFail` or manually), its id no longer counts as a duplicate.
- Restrictions:
  - ids **must not contain `:`**;
  - **all-digit ids throw** `Custom Id cannot be integers`.
- A UUID `videoId` contains no `:`, but the plan uses the prefixed form `video-{videoId}` to be explicit and safe.

### Graceful shutdown and auto-removal

- `await worker.close()` stops the worker from taking new jobs and waits for the active ones. It has no timeout of its own.
- Jobs left in flight when a worker dies are **stalled** and get picked up again. Processing must therefore be idempotent, re-runnable for the same `videoId`.
- `removeOnComplete`/`removeOnFail` accept `true`, a count, or `{ age (seconds), count }`. Removal is lazy: it runs on the next job completion or failure.

## @aws-sdk/client-s3

**Source:**
- aws-sdk-js-v3 supplemental docs (CLIENTS.md, ERROR_HANDLING.md, MD5_FALLBACK.md) and issue #6810;
- the S3 quotas page (qfacts);
- the `dist-types` of 3.1146.0, for every field named below.

Maps to `phase-03-videos/TD-12` (and is used by TD-02, TD-03, TD-05, TD-07, TD-11, TD-13, TD-14). Engines: `node >=20.0.0`.

### Client configuration (MinIO locally, S3 in production)

```ts
import { S3Client } from '@aws-sdk/client-s3';

new S3Client({
  region: config.region,
  endpoint: config.endpoint,           // MinIO: internal Compose host, e.g. http://minio:9000
  forcePathStyle: config.forcePathStyle, // true for MinIO (confirmed in S3Client config typings)
  credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
```

- **Checksums:**
  - Since v3.729.0 the defaults are `WHEN_SUPPORTED`: an extra CRC32 checksum on every Put/UploadPart and validation on Get. Third-party S3 servers may not support this. Use `WHEN_REQUIRED` against MinIO; both fields are confirmed in the typings.
  - This matters doubly for **presigned UploadPart URLs**, because the browser cannot compute the SDK's checksum header.
- **Two clients:**
  - Internal operations (Create/Complete/Abort/Head/Put/Delete) use the internal endpoint (`minio:9000`, the Compose service name, per root CLAUDE.md).
  - **Presigned URLs** are consumed by the browser, so they must be signed with the **public** endpoint (`S3_PUBLIC_ENDPOINT`, e.g. `http://localhost:9000`). The SigV4 signature covers the host, so a URL cannot be rewritten after signing. Use a second `S3Client` instance (same credentials, public endpoint) dedicated to `getSignedUrl`.
- An endpoint override replaces rule-based endpoint resolution.
- Literal credentials are acceptable in dev/test. In production, use the default provider chain.

### Commands and confirmed input fields

All imported from `@aws-sdk/client-s3`; send with `await client.send(new XCommand({...}))`.

| Command | Fields used (confirmed in typings) | Used by |
|---|---|---|
| `CreateMultipartUploadCommand` | `Bucket`, `Key`, `ContentType` → output `UploadId` | initiate (TD-02/03) |
| `UploadPartCommand` (presigned only) | `Bucket`, `Key`, `UploadId`, `PartNumber`, (`ContentLength`) → response header `ETag` | client upload (TD-02) |
| `ListPartsCommand` | `UploadId`, `MaxParts`, `PartNumberMarker` → `Parts[{PartNumber, ETag, Size}]` | resume / complete (TD-02) |
| `CompleteMultipartUploadCommand` | `UploadId`, `MultipartUpload: { Parts: [{ ETag, PartNumber }] }` | complete (TD-03) |
| `AbortMultipartUploadCommand` | `Bucket`, `Key`, `UploadId` | cancel (AMB-4) |
| `HeadObjectCommand` | → `ContentLength`, `ContentType`, `ETag` | complete size check (AMB-3) |
| `GetObjectCommand` | `Range`, `ResponseContentDisposition`, `ResponseContentType` | presigned stream/download (TD-07), worker probe input (TD-05) |
| `PutObjectCommand` | `Bucket`, `Key`, `Body`, `ContentType` | thumbnail upload (TD-05/11) |
| `DeleteObjectCommand` | `Bucket`, `Key` | cleanup |
| `CreateBucketCommand` / `HeadBucketCommand` | `Bucket` | bucket bootstrap (TD-13) |
| `PutBucketLifecycleConfigurationCommand` | `LifecycleConfiguration.Rules[].AbortIncompleteMultipartUpload.DaysAfterInitiation` | stale multipart cleanup (AMB-4) |

- If you start reading a `GetObject` `Body` stream, consume it or call `.destroy()` to free the socket. For metadata only, use `HeadObject`.

### Multipart limits (S3 quotas — the design contract)

- Part size **5 MiB – 5 GiB**. The last part has no minimum.
- Part numbers **1 – 10,000**.
- Maximum object size **48.8 TiB**.
- `ListParts` returns at most **1000** parts per request.
- For a 10 GiB (10 × 1024³ B) cap, a fixed part size of **16 MiB** gives at most 640 parts, well within the 10,000 limit and comfortably above the 5 MiB minimum. The planned part size is server-defined and returned by initiate.

### Error handling

- Non-2xx responses throw. Modelled errors extend `S3ServiceException` (exported), and `instanceof` works.
- Inspect `e.name` and `e.$metadata.httpStatusCode`.
- Modelled classes confirmed in `models/errors.d.ts`: `NoSuchUpload`, `NoSuchKey`, `NoSuchBucket`, `NotFound`, `BucketAlreadyOwnedByYou`.
- `HeadObject`/`HeadBucket` responses have no body, so match on `httpStatusCode === 404` (robust) as well as `name`.
- Map these to domain exceptions inside `StorageService`. Never leak SDK errors into the HTTP layer (inherited `phase-02-auth/TD-07`).

## @aws-sdk/s3-request-presigner

**Source:** the package README and `@smithy/signature-v4` (dist). Maps to `phase-03-videos/TD-12`, used by TD-02 (part URLs) and TD-07 (GET URLs).

```ts
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand, UploadPartCommand } from '@aws-sdk/client-s3';

const partUrl = await getSignedUrl(publicClient,
  new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }), { expiresIn: 3600 });

const streamUrl = await getSignedUrl(publicClient,
  new GetObjectCommand({ Bucket, Key, ResponseContentType: mimeType }), { expiresIn: 900 });

const downloadUrl = await getSignedUrl(publicClient,
  new GetObjectCommand({ Bucket, Key,
    ResponseContentDisposition: `attachment; filename="${safeName}"` }), { expiresIn: 900 });
```

- `expiresIn` is in seconds; the README states the default as 900. **The maximum is 7 days**: `MAX_PRESIGNED_TTL = 60 * 60 * 24 * 7` in `@smithy/signature-v4`. A larger value throws.
- Other options:
  - `signableHeaders` enforces extra signed headers on the client;
  - `unhoistableHeaders` / `hoistableHeaders` control which `x-amz-*` headers go into the query string.
- Presigning works with any command (README); `UploadPartCommand` follows the same pattern.
- **Range / 206 — not stated by the fetched docs.** HTTP `Range` is a request header that SigV4 query-signed GETs do not sign by default (only `host` is in the signed headers). The browser can therefore send `Range` freely and S3/MinIO answer `206 Partial Content`. This is standard S3 GetObject behaviour (`GetObjectCommandInput.Range` exists in the typings). **The plan must prove it with an integration test** (request a presigned URL with `Range: bytes=0-1023` and assert 206 + `Content-Range`) rather than rely on this note.
- **Browser access needs CORS on the bucket.** A browser `PUT` to a presigned part URL needs the `ETag` response header exposed. This is a MinIO/S3 server configuration, not an SDK feature. Record it in the storage bootstrap Tech Spec.
