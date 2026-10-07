---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-10-05
scope_description: "Backend foundation for video upload and processing: object storage usage, background job queue, resumable 10GB upload, draft pre-registration, worker with FFmpeg (metadata + thumbnail), unique short video URLs, streaming and download delivery, and status lifecycle with failure handling."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the upload API (initiate / sign parts / complete / abort), the draft `videos` entity and migration, the queue producer, the video worker (separate container from the same codebase, see TD-04), streaming/download endpoints, and the new Compose infrastructure (object storage + queue broker).
- `next-frontend/` — No open decision in this document: none of the Phase 03 capability bullets is a screen (the upload/playback UI is out of scope for this backend phase; the player arrives in Fase 05). Backend contracts a future frontend slice will consume (upload protocol, URL id format, streaming URLs) are decided here as Backend TDs and exposed through the existing `openapi.json` → BFF pipeline inherited from `openapi-docs-nestjs` and `next-frontend-openapi-typing`.

---

## TD-01: Background Job Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The C4 diagram leaves the Message Queue as "TBD". The API must publish a processing job when an upload completes, and the Video Worker must consume it with retries, concurrency control, and visibility into failed jobs. The choice adds (or does not add) a new infrastructure container and determines the NestJS integration module.

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- Redis-backed queue with an official NestJS module (`BullModule.forRootAsync`, `@Processor`, `WorkerHost`). Adds a `redis` service to Compose.
- **Pros:** Official Nest integration, recommended by the project rule `micro-use-queues.md`. Built-in retries with exponential backoff, stalled-job recovery, concurrency, job ids for idempotency, delayed jobs. The testing reference (`external-systems.md`) already shows a `getQueueToken('video-processing')` pattern.
- **Cons:** New infrastructure dependency (Redis) to run, secure and persist. `@nestjs/bullmq` 12.x is ESM-only and targets Nest 12 — the project (Nest 11, CommonJS) must pin `@nestjs/bullmq@^11`.

### Option B: pg-boss (PostgreSQL-backed)
- Job queue stored in the existing PostgreSQL using `SKIP LOCKED`. No new container; no official Nest module (wrap in a custom provider).
- **Pros:** Zero new infrastructure; jobs live next to the data (can be enqueued in the same transaction as the status change). Retries, backoff and dead-letter supported.
- **Cons:** No official Nest integration — custom lifecycle wiring. Major versions (10, 11, 12) shipped breaking schema changes without automatic migration. Creates its own schema in the app DB, which the TypeORM migration tests must tolerate. Polling load on the primary DB.

### Option C: RabbitMQ (`@nestjs/microservices` RMQ transport)
- AMQP broker; the worker is a Nest microservice consuming a queue.
- **Pros:** Mature broker, strong delivery guarantees, routing flexibility.
- **Cons:** Heaviest operational footprint. Nest's RMQ transport is a message bus, not a job queue — retries/backoff/failed-job tracking must be built manually. Overkill for a single job type.

**Recommendation:** **Option A (BullMQ + Redis)** — it is the project's documented best practice, gives retries/backoff/idempotent job ids out of the box (needed by TD-09), and the Redis container cost is small compared to hand-building job semantics; pin `@nestjs/bullmq@^11` for Nest 11 / CommonJS.

**Decision:** A (BullMQ + Redis)
**Libraries:** @nestjs/bullmq, bullmq

---

## TD-02: Large File Upload Protocol (up to 10GB, resumable)

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The project plan requires 10GB uploads that do not freeze the system and can resume after a connection failure. Whether bytes pass through the API process is the main performance driver: a 10GB stream through Node competes with every other request for CPU, memory and socket time.

**Options:**

### Option A: S3 multipart upload with presigned part URLs (direct to storage)
- API calls `CreateMultipartUpload`, returns `uploadId` + part size + part count; client requests presigned `UploadPart` URLs and PUTs each part straight to the object storage; API calls `CompleteMultipartUpload` with the ETags. Resume = `ListParts` and re-send only missing parts.
- **Pros:** Zero video bytes through the API. Resumable per part, parallelizable. Works identically on MinIO and AWS S3. Fits the C4 relation "api → storage: Uploads" (API controls the upload; storage receives the bytes).
- **Cons:** Client must implement slicing, per-part retry and resume (fine — no frontend yet; e2e tests drive it). S3 limits: 5MiB minimum part size, 10,000 parts max — part size must be computed server-side (e.g. 64MiB → 160 parts for 10GB). The 10GB cap must be enforced by the API (declared size at initiate + `HeadObject` after complete), since a presigned part URL does not limit total size.

### Option B: tus protocol served by the API (`@tus/server` + `@tus/s3-store`)
- The API exposes a tus endpoint; the client uses `tus-js-client`. The tus server streams chunks into S3 multipart under the hood.
- **Pros:** Standard resumable protocol with mature clients (tus-js-client, Uppy). Server controls size limits natively.
- **Cons:** Every byte still flows through the API process (the performance concern this capability is about). Mounting tus inside Nest/Express needs custom wiring (raw body, no ValidationPipe on that route). Extra protocol-specific state.

### Option C: Streamed `multipart/form-data` through the API
- Client posts the file to the API; the API pipes the stream to storage (`@aws-sdk/lib-storage` `Upload`).
- **Pros:** Simplest client; single request.
- **Cons:** Not resumable — a dropped connection restarts 10GB. API holds a long-lived connection per upload and proxies all bytes. Fails the "Pontos de Atenção" requirement explicitly.

**Recommendation:** **Option A (presigned multipart, direct to storage)** — it is the only option that both removes video bytes from the API and gives native per-part resume, matching the C4 design and the plan's "sem impacto na performance" requirement; the size cap is enforced at initiate and re-checked at complete.

**Decision:** A (Presigned S3 multipart upload, direct to storage)

---

## TD-03: Draft Pre-registration and Processing Trigger

**Scope:** Backend

**Capability:** Transversal — covers: Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** The video row must exist as a draft as soon as the upload starts, and processing must start automatically when the upload finishes. With direct-to-storage uploads (TD-02 A) the API does not see the bytes arrive, so something must detect completion and enqueue the job.

**Options:**

### Option A: API-driven — initiate creates the draft, client-called `complete` enqueues
- `POST /videos/uploads` creates the `videos` row (draft) and the multipart upload in one call; `POST .../complete` finalizes the multipart, verifies the object (`HeadObject`: size ≤ 10GB), switches status to `processing` and enqueues a job with `jobId = videoId`.
- **Pros:** Single source of truth in the API; synchronous validation before processing. Idempotent: re-calling `complete` or re-enqueueing the same `jobId` is a no-op. No storage-specific configuration. Easy to test end-to-end.
- **Cons:** If the client never calls `complete`, the draft stays in "uploading" — needs abort endpoint + stale-upload cleanup. Small window between DB update and enqueue (mitigated by idempotent retry of `complete`).

### Option B: Storage event notifications (`s3:ObjectCreated:CompleteMultipartUpload`)
- MinIO publishes a bucket event to a webhook/Redis/AMQP target; a consumer enqueues the processing job.
- **Pros:** Processing starts even if the client disappears after the last part.
- **Cons:** Someone still must call `CompleteMultipartUpload` (the client would need credentials or the API anyway). Storage-specific config (MinIO notify targets vs S3 → SQS/EventBridge) diverges between local and prod. Harder to test; event delivery is asynchronous and at-least-once.

**Recommendation:** **Option A (API-driven complete)** — with presigned multipart the API must call `CompleteMultipartUpload` anyway, so it is the natural place to validate, flip the status and enqueue idempotently; it keeps local (MinIO) and production (S3) behavior identical.

**Decision:** A (API-driven initiate/complete)

---

## TD-04: Video Worker Runtime and Topology

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** The C4 diagram shows the Video Worker as a separate container using FFmpeg that consumes the queue and writes to DB and storage. The choice defines code sharing (entities, config, storage service), Docker images, and how integration tests reach FFmpeg.

**Options:**

### Option A: Same NestJS codebase, separate entrypoint and Compose service
- Add a worker bootstrap (e.g. `src/worker.ts` via `NestFactory.createApplicationContext(WorkerModule)`) that loads only DB, config, storage and the queue processor. A new Compose service `video-worker` runs it from an image that includes `ffmpeg`.
- **Pros:** Matches the C4 container split while reusing entities, `registerAs` config, Joi validation and the storage service. Independent scaling/restarts; a crash in FFmpeg never touches the API. One `package.json`, one lint/tsc/test pipeline.
- **Cons:** Two runtime entrypoints to keep in sync. `ffmpeg` must also be present in the container that runs the worker's integration tests (add it to `Dockerfile.dev` or run those tests in the worker container).

### Option B: Separate project (`video-worker/` subproject)
- Standalone Node service with its own dependencies and Dockerfile.
- **Pros:** Strongest isolation; can use any language/tooling.
- **Cons:** Duplicates entities, config and storage code, or forces a shared package. New subproject with its own DoD pipeline. Out of proportion for one job type.

### Option C: Processor inside the API process
- Register the BullMQ processor in the API's `AppModule`.
- **Pros:** Simplest; no new service.
- **Cons:** Contradicts the C4 diagram. FFmpeg CPU load and long jobs run in the API process, degrading request latency — the opposite of "sem impacto na performance".

**Recommendation:** **Option A (same codebase, separate entrypoint + `video-worker` service)** — it honours the C4 container boundary and isolates FFmpeg load, while avoiding duplicated domain code; `ffmpeg` is installed in the shared dev image so integration tests run against the real binary.

**Decision:** A (Same NestJS codebase, separate worker entrypoint and Compose service)

---

## TD-05: FFmpeg Integration (metadata extraction and thumbnail)

**Scope:** Backend

**Capability:** Transversal — covers: Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The worker must extract duration/metadata (ffprobe) and generate a thumbnail from a frame (ffmpeg). The integration library, the binary source and how the worker reads a 10GB object all affect reliability, disk use and testability.

**Options:**

### Option A: `child_process.spawn` of system `ffprobe`/`ffmpeg`, reading a presigned GET URL
- Binaries installed via `apt` in the image. `ffprobe -v error -print_format json -show_format -show_streams <url>` and `ffmpeg -ss <t> -i <url> -frames:v 1 ...` read directly over HTTP (Range requests), so only the needed bytes are fetched; the JPEG is uploaded to storage.
- **Pros:** No wrapper dependency; full control of arguments and timeouts. No 10GB temp-disk copy. Same approach regardless of storage backend.
- **Cons:** Must write a small typed wrapper (spawn, timeout, stderr capture, JSON parsing). Depends on the distro's ffmpeg version (Debian's is current enough for probe + frame grab).

### Option B: `fluent-ffmpeg` wrapper
- Popular fluent API around the binaries.
- **Pros:** Familiar API, many examples.
- **Cons:** Repository archived (May 2025) and deprecated on npm ("Package no longer supported"); the author recommends spawning ffmpeg directly. Not viable for new code.

### Option C: Spawn ffmpeg on a downloaded local temp file (`ffmpeg-static` binaries)
- Worker downloads the object to a temp volume, then probes it; binaries come from the `ffmpeg-static` npm package.
- **Pros:** Deterministic input; binary version pinned by npm.
- **Cons:** 10GB temp disk per concurrent job and full download time before processing. `ffmpeg-static` fetches the binary in an install script — the project's bind mount requires `npm ci --ignore-scripts`, so the binary would be missing.

**Recommendation:** **Option A (spawn system ffprobe/ffmpeg on a presigned URL)** — `fluent-ffmpeg` is archived and `ffmpeg-static` breaks under `--ignore-scripts`; streaming input avoids 10GB temp copies. Thumbnail frame policy: seek to ~10% of the duration (fallback to the first frame for very short videos).

**Decision:** A (Spawn system ffprobe/ffmpeg on a presigned GET URL)

---

## TD-06: Unique Public Video Identifier (URL)

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Every video needs a short, unique URL id that never conflicts. Fase 05 adds unlisted videos "acessíveis apenas via link direto", so the id must also be non-guessable — an enumerable id would leak unlisted videos.

**Options:**

### Option A: UUID (primary key exposed in the URL)
- Reuse the `uuid` PK (already used by every table) as the URL id.
- **Pros:** Zero extra code; collision-free; non-guessable (v4).
- **Cons:** 36 characters — not "short" as required by "Pontos de Atenção".

### Option B: Random short id (`crypto.randomBytes` → base64url) with unique constraint
- Separate `public_id` column (e.g. 8 random bytes → 11 base64url chars, ~64 bits, YouTube-like), unique index, retry on unique-violation. UUID stays as internal PK.
- **Pros:** Short and non-guessable; collisions astronomically rare and handled by the DB constraint. Node built-in — no dependency (`nanoid` v5 is ESM-only; the project is CommonJS).
- **Cons:** Extra column/index and a retry path on insert. Two identifiers to keep clear (internal vs public).

### Option C: Sqids/Hashids encoding of a sequential number
- Encode an auto-increment integer into a short string.
- **Pros:** Very short, deterministic, no collision retry.
- **Cons:** Reversible and ordered — ids are enumerable, which breaks unlisted videos in Fase 05. Requires a sequence column alongside the UUID PK.

**Recommendation:** **Option B (random base64url `public_id`)** — satisfies "short", "never conflicts" (unique index + retry) and the future unlisted requirement (non-guessable), with no new dependency.

**Decision:** B (Random base64url public_id with unique constraint)

---

## TD-07: Streaming and Download Delivery

**Scope:** Backend

**Capability:** Transversal — covers: Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Playback must start without downloading the whole file (HTTP Range / `206 Partial Content`) and users must be able to download the file. The C4 diagram shows the frontend streaming directly from object storage ("Streams HTTPS"). Storage growth/costs are a listed attention point, so extra renditions have a real cost.

**Options:**

### Option A: API issues short-lived presigned GET URLs to object storage
- `GET /videos/:publicId/stream` (and `/download`) checks access and returns or redirects (`302`) to a presigned URL; storage serves Range/206 natively. Download uses `response-content-disposition=attachment; filename=...`.
- **Pros:** Matches the C4 diagram; zero video bytes through the API; Range/seek handled by storage. Same code works on S3/CDN later.
- **Cons:** Presigned URLs embed the host — inside Docker the API talks to `minio:9000` but browsers need a public host, so signing needs a separate public endpoint config (e.g. `S3_PUBLIC_ENDPOINT`). URL is a bearer credential until expiry.

### Option B: API proxies bytes with Range support
- API parses the `Range` header, calls `GetObject` with the same range and pipes the body with `206`.
- **Pros:** Single public origin; access checked on every request; no endpoint-signing concern.
- **Cons:** All playback bytes flow through the API — the performance problem TD-02 avoids for upload. Must implement Range parsing/headers correctly.

### Option C: Adaptive streaming (HLS/DASH transcoding)
- Worker transcodes into segmented renditions; player uses a manifest.
- **Pros:** Adaptive bitrate, best playback experience.
- **Cons:** Heavy CPU per video, multiplies storage (cost attention point), needs an HLS player (Fase 05). Not required by the capability text (progressive streaming already avoids full download).

**Recommendation:** **Option A (presigned GET + Range/206 from storage)** — it follows the C4 "frontend streams from storage" relation and keeps the API out of the byte path; the public-endpoint signing config is a one-time setting. HLS is deferred.

**Decision:** A (Presigned GET URLs with Range support)

---

## TD-08: Video Status Lifecycle Model

**Scope:** Backend

**Capability:** Transversal — covers: Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Phase 03 needs a lifecycle "rascunho → processando → pronto / erro". Fase 04 later adds "Fluxo de rascunho → publicação" and visibility (public/unlisted). Mixing processing state with publication state in one column now would force a breaking migration in Fase 04. The DB representation also matters: the current migration spec already breaks on a re-run because of an orphan Postgres enum type (`verification_tokens_type_enum`).

**Options:**

### Option A: Processing status only, as Postgres enum (`uploading`, `processing`, `ready`, `failed`)
- One `status` column for the technical pipeline; "rascunho" means "not published" and is represented in Fase 04 by a separate publication/visibility field.
- **Pros:** Clear separation of concerns; Fase 04 adds a column without rewriting values. DB-level type safety.
- **Cons:** A new Postgres enum type is another orphan-type risk for migration tests (the `down` must drop it and test setup must drop types).

### Option B: Processing status only, as `varchar` + `CHECK` constraint
- Same values as A, stored as text with a check constraint; TS enum in code.
- **Pros:** Same separation as A; no separate DB type to create/drop, so no orphan-type issue; adding a value is a constraint change.
- **Cons:** Slightly less self-documenting in the DB; TypeORM `enum` column type cannot be used as-is (use `varchar` + check in the migration).

### Option C: Single combined status (`draft`, `processing`, `ready`, `failed`, later `published`)
- One column covers both pipeline and publication.
- **Pros:** Simplest for Phase 03.
- **Cons:** Conflates two state machines: a published video being reprocessed, or a failed draft, has no representation. Fase 04 would have to split it.

**Recommendation:** **Option A (processing-only status, Postgres enum)** — it keeps the "rascunho → publicação" flow for Fase 04 as an orthogonal field and stays consistent with the existing enum convention (`verification_tokens_type_enum`); Option B is the fallback if the migration-test reentrancy issue is not fixed first.

**Decision:** A (Processing status as Postgres enum)

---

## TD-09: Processing Failure and Retry Policy

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** FFmpeg jobs can fail transiently (storage timeout, worker restart) or permanently (corrupted/non-video file). The video must never stay stuck in `processing`, and the owner needs to see why it failed.

**Options:**

### Option A: Bounded retries with exponential backoff, then `failed` with reason
- Queue retries (e.g. 3 attempts, exponential backoff); on the final failure the worker sets `status = failed` and stores a short `processing_error`. Permanent errors (ffprobe finds no video stream) fail immediately without retry. The job is idempotent (keyed by `videoId`).
- **Pros:** Recovers transient failures automatically; deterministic final state; uses built-in queue features.
- **Cons:** Must classify errors as retryable vs permanent; worker steps must be idempotent (re-upload thumbnail safely).

### Option B: No retries — first failure marks `failed`
- **Pros:** Simplest.
- **Cons:** Transient blips permanently fail uploads of up to 10GB, forcing a full re-upload.

### Option C: Option A plus an owner-triggered reprocess endpoint
- **Pros:** Lets the owner recover without re-uploading.
- **Cons:** Extra API surface not required by Phase 03 capabilities; can be added later on top of A.

**Recommendation:** **Option A (bounded retries + `failed` with reason)** — it covers transient failures with queue-native features and guarantees a terminal state; the reprocess endpoint is a later, additive feature.

**Decision:** A (Bounded retries with exponential backoff, then failed)

---

## TD-10: Access Policy for Streaming and Download in Phase 03

**Scope:** Backend

**Capability:** Transversal — covers: Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Anonymous viewing ("Acesso anônimo à visualização de vídeos") and visibility rules are Fase 04/05 scope, but Phase 03 must deliver working streaming/download. Every video in Phase 03 is still a draft (publication arrives in Fase 04), and the global JWT guard from Fase 02 protects routes unless marked `@Public()`.

**Options:**

### Option A: Owner-only (authenticated) in Phase 03, with a centralized access check
- Streaming/download require JWT and ownership (through the user's channel); only `ready` videos are served. The check lives in one policy method that Fase 04/05 extends to public/unlisted/anonymous.
- **Pros:** Drafts are never exposed; consistent with the global guard; a single extension point for later phases.
- **Cons:** Anonymous playback cannot be demonstrated until Fase 05.

### Option B: Public for any `ready` video via its `public_id`
- Routes marked `@Public()`; possession of the id grants access.
- **Pros:** Demonstrates anonymous streaming early.
- **Cons:** Exposes unpublished drafts, contradicting the Fase 04 "rascunho → publicação" flow; Fase 04 would have to tighten an already-public contract.

**Recommendation:** **Option A (owner-only, centralized policy)** — drafts must not leak before publication exists, and a single policy method lets Fase 04/05 open access without changing route contracts.

**Decision:** A (Owner-only with centralized access policy)

---

## TD-11: Storage Bucket and Object Key Layout

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Originals and thumbnails must be stored with keys that never collide, are easy to clean up per video, and allow different policies (lifecycle, cache, future public thumbnails) without moving objects.

**Options:**

### Option A: Single bucket, per-video prefixes
- e.g. `videos/{videoId}/original` and `videos/{videoId}/thumbnail.jpg` in one bucket.
- **Pros:** One bucket to provision; deleting a video = deleting one prefix; keys derive from the immutable internal id (no user input in keys).
- **Cons:** Bucket-level policies (public read for thumbnails, lifecycle rules) apply to everything unless expressed per prefix.

### Option B: Two buckets (`videos`, `thumbnails`), keyed by `{videoId}`
- **Pros:** Independent policies: thumbnails can become publicly cacheable in later phases while originals stay private; lifecycle/abort-incomplete rules only on the video bucket.
- **Cons:** Two buckets to provision in Compose, tests and production; cleanup touches both.

### Option C: Channel-scoped keys (`{channelId}/{videoId}/...`)
- **Pros:** Per-channel listing/quota accounting.
- **Cons:** Ownership is already in the DB; keys would break if videos ever move between channels; no Phase 03 capability needs it.

**Recommendation:** **Option B (two buckets keyed by video id)** — separates private originals from thumbnails that later phases will likely serve publicly, at the small cost of provisioning one more bucket.

**Decision:** B (Two buckets keyed by videoId)

**Follow-up (2026-10-07):** the layout is unchanged, but the keys are now also persisted on the row (`videos.original_key`, set on creation; `videos.thumbnail_key`, set when processing succeeds — migration `AddVideoStorageKeys1791382169844`), so the persistence model records the storage keys of the file and the thumbnail as the assignment requires. `src/videos/video-object-keys.ts` remains the only place that builds them.

---

## TD-12: S3 Client Library

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The API (multipart initiate/complete, presigning, HeadObject) and the worker (presigned GET, thumbnail PutObject) need an S3-compatible client. Storage is MinIO locally and S3-compatible in production.

**Options:**

### Option A: AWS SDK for JavaScript v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)
- Modular official SDK; `forcePathStyle: true` and a custom `endpoint` for MinIO; `getSignedUrl` for `UploadPartCommand`/`GetObjectCommand`.
- **Pros:** Vendor-neutral S3 API — same code against MinIO, AWS S3, R2, etc. Full multipart + presign support; TypeScript types; widely documented.
- **Cons:** Verbose command API. Recent versions compute default request checksums, which can break presigned uploads on S3-compatible stores unless `requestChecksumCalculation: 'WHEN_REQUIRED'` is set — verify at `plan-resolve`.

### Option B: MinIO JavaScript client (`minio`)
- MinIO's own SDK with `presignedUrl`, multipart helpers.
- **Pros:** Simpler API, tuned for MinIO.
- **Cons:** Ties code to the vendor whose community distribution was put in maintenance mode (2025); weaker fit for AWS S3 in production; presigned multipart-part flow is less direct than in SDK v3.

**Recommendation:** **Option A (AWS SDK v3)** — the S3 API is the stable contract between local MinIO and production storage; checksum and path-style settings are one-time client configuration.

**Decision:** A (AWS SDK for JavaScript v3)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-13: Local S3-compatible Storage Container Image

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The architecture specifies "S3 or MinIO" with MinIO for local development. MinIO stopped publishing community Docker images on 2025-10-23 and the `minio/minio` / `minio/mc` repositories were later removed from Docker Hub, so `image: minio/minio` in Compose is no longer reliable. The Compose service must pin a reproducible image.

**Options:**

### Option A: Chainguard MinIO image (`cgr.dev/chainguard/minio`), pinned by digest
- Free, continuously rebuilt MinIO server image (plus `cgr.dev/chainguard/minio-client`).
- **Pros:** Maintained, zero-CVE builds of real MinIO; drop-in for the documented MinIO setup.
- **Cons:** Free tier exposes only the `latest` tag — must pin by `@sha256:` digest for reproducibility; third-party distributor.

### Option B: Build MinIO from source in a repo Dockerfile
- Multi-stage Go build of a pinned MinIO release tag.
- **Pros:** Full control and pinned version; no third-party registry.
- **Cons:** Slow builds, Go toolchain in the repo, upkeep of security patches falls on the project.

### Option C: Another S3-compatible server (e.g. SeaweedFS, Garage)
- **Pros:** Actively published images with version tags.
- **Cons:** Diverges from the documented "MinIO locally" architecture; different multipart/presign edge cases to validate.

**Recommendation:** **Option A (Chainguard MinIO pinned by digest)** — keeps MinIO as documented while restoring a maintained, reproducible image source; bucket creation is done by the application/test setup through the S3 API, so `mc` is not required.

**Decision:** A (Chainguard MinIO image pinned by digest)

---

## TD-14: Test Strategy for Object Storage and Queue

**Scope:** Backend

**Capability:** Transversal — covers: Serviço de armazenamento de arquivos (vídeos e thumbnails); Serviço de processamento em segundo plano (filas); Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** The testing reference `external-systems.md` suggests a local-filesystem fake behind a `StorageService` abstraction, while the queue section already assumes a real broker in Docker. Presigned multipart, ETags, Range/206 and FFmpeg reading HTTP URLs are exactly the behaviors a filesystem fake cannot reproduce. This choice fixes the Compose services and the integration/e2e setup for the whole phase.

**Options:**

### Option A: Real MinIO + real Redis in Compose for integration/e2e; mocks only in unit tests
- Integration/e2e tests use dedicated test buckets and queue names, cleaned in `beforeEach`/`afterAll` (objects deleted, `queue.obliterate()`), with small generated sample videos (a few seconds, created by ffmpeg in setup).
- **Pros:** Exercises the real S3 protocol (presign, multipart, Range) and real queue semantics; matches the project's "integration/e2e hit real infrastructure" rules.
- **Cons:** Slower suites and more Compose services; tests need `--runInBand` isolation (already the project rule).

### Option B: Filesystem `StorageService` fake + in-memory queue for integration tests
- **Pros:** Faster, no extra containers in tests.
- **Cons:** Presigned URLs, multipart and Range cannot be faithfully faked; bugs would surface only in manual runs. Contradicts the existing integration-test definition ("real modules").

**Recommendation:** **Option A (real MinIO + Redis in tests)** — the critical Phase 03 behaviors are protocol-level and only real infrastructure verifies them; the `StorageService` abstraction is still kept so unit tests can mock it.

**Decision:** A (Real MinIO + Redis for integration/e2e)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Background Job Queue Technology | BullMQ + Redis (`@nestjs/bullmq@^11`) | **A** |
| TD-02 | Backend | Large File Upload Protocol | Presigned S3 multipart, direct to storage | **A** |
| TD-03 | Backend | Draft Pre-registration and Processing Trigger | API-driven initiate/complete + idempotent enqueue | **A** |
| TD-04 | Backend | Video Worker Runtime and Topology | Same codebase, separate entrypoint + `video-worker` service | **A** |
| TD-05 | Backend | FFmpeg Integration | `spawn` system ffprobe/ffmpeg on presigned URL | **A** |
| TD-06 | Backend | Unique Public Video Identifier | Random base64url `public_id` + unique index | **B** |
| TD-07 | Backend | Streaming and Download Delivery | Presigned GET + Range/206 from storage | **A** |
| TD-08 | Backend | Video Status Lifecycle Model | Processing-only status, Postgres enum | **A** |
| TD-09 | Backend | Processing Failure and Retry Policy | Bounded retries + `failed` with reason | **A** |
| TD-10 | Backend | Access Policy for Streaming/Download | Owner-only, centralized policy | **A** |
| TD-11 | Backend | Storage Bucket and Object Key Layout | Two buckets keyed by video id | **B** |
| TD-12 | Backend | S3 Client Library | AWS SDK v3 | **A** |
| TD-13 | Backend | Local S3-compatible Storage Image | Chainguard MinIO pinned by digest | **A** |
| TD-14 | Backend | Test Strategy for Storage and Queue | Real MinIO + Redis in integration/e2e | **A** |
