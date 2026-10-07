# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Redis / MinIO:** `docker compose ps redis minio` — both must show `healthy` (each has a Compose healthcheck)
- **Video worker:** `docker compose logs video-worker` — expect `Video worker started (queue: video-processing)`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`. Idle by default (`tail -f /dev/null`); start the server explicitly (see below)
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP capture for confirmation / password-reset emails, SMTP port `1025`, web UI and API port `8025`
- `redis` — Redis 8.4 (BullMQ queue backend), port `6379`, `maxmemory-policy noeviction`
- `minio` — MinIO (S3-compatible object storage), API port `9000`, console port `9001`. CORS origin for browser uploads comes from `STORAGE_CORS_ALLOWED_ORIGINS` (default `http://localhost:3001`). Buckets are created by the app on boot (`StorageBootstrapService`), not by Compose
- `video-worker` — same image as `nestjs-api` (with `ffmpeg`/`ffprobe`); consumes the `video-processing` queue. Unlike `nestjs-api`, it **starts automatically** with `docker compose up` (`command: npm run start:worker`, `restart: unless-stopped`), so processing runs after every upload without manual steps; it keeps restarting until `node_modules` exists. The worker has no watch mode (`nest start --watch` would wipe the API's `dist/` via `deleteOutDir`), so **restart it after every code change**: `docker compose restart video-worker`. Compiled build: `npm run build`, then `npm run start:worker:prod` (`node dist/worker`). It opens no HTTP port and exits with code 0 on `SIGTERM` after closing the queue workers and the DB connection.

**Storage endpoints — documented exception to the service-name rule (AMB-7):** `S3_ENDPOINT=http://minio:9000` is used for all service-to-service traffic. `S3_PUBLIC_ENDPOINT=http://localhost:9000` is the host the **browser** sees, used only to sign presigned URLs returned to clients; that is why it is `localhost`. Never use `S3_PUBLIC_ENDPOINT` for traffic between containers.

**Test precondition:** integration and e2e suites use real storage and queue — `redis` and `minio` must be `healthy` before running tests.

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/ (dist/main.js and dist/worker.js)
npm run start:prod                       # Run compiled API (node dist/main)
npm run start:worker                     # Video worker from source (ts-node) — the video-worker container's command
npm run start:worker:prod                # Compiled video worker (node dist/worker)

npm test                                 # Unit + integration tests (*.spec.ts and *.integration-spec.ts)
npm run test:integration                 # Integration tests only
npm run test:watch                       # Watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (serial: maxWorkers 1 in the config)
npm run fixtures:large                   # Generate the 10 GiB video fixture (.large-fixtures/, git-ignored)
npm run test:large                       # Opt-in 10 GiB upload suite (*.large-spec.ts); needs fixtures:large first

npm run migration:run                    # Apply TypeORM migrations (src/database/migrations)
npm run openapi:export                   # Regenerate openapi.json from the Swagger document

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

If a script fails with `sh: 1: <bin>: Operation not permitted` (binaries under `node_modules/.bin` not executable through the bind mount), call the package entry point with `node` instead, e.g. `node node_modules/jest/bin/jest.js --runInBand`, `node node_modules/@nestjs/cli/bin/nest.js build`, `node node_modules/typescript/bin/tsc --noEmit`. `start:prod`, `start:worker` and `start:worker:prod` already call `node` and are not affected.

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database, Redis and MinIO, so they **must** run serially. Both Jest configs pin `maxWorkers: 1` (the unit + integration config also sets `testTimeout: 30000`), so the plain commands are already serial on any machine:

```bash
docker compose exec nestjs-api npm test
docker compose exec nestjs-api npm run test:e2e
```

Never override it with `--maxWorkers` > 1: parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables and empty shared buckets concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config), `test/jest-e2e.json` and `test/jest-large.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately. The one deliberate addition is `*.large-spec.ts` (`test/jest-large.json`, 1 h timeout): it is excluded from `npm test` and `test:e2e` and runs only through `npm run test:large`.

Video tests use real infrastructure, isolated per suite: `test/support/videos-app.ts` sets a unique `QUEUE_PREFIX=test-{uuid}` and the buckets `e2e-videos` / `e2e-thumbnails` before compiling the app, and `test/support/videos-test-app.ts` boots the API plus a real `WorkerModule` in the same Jest process, so the suite never consumes the `video-worker` container's jobs. Media fixtures come from `src/test/video-fixtures.ts` (generated with ffmpeg).

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module
- Services throw `DomainException` subclasses (`src/**/exceptions/`); `DomainExceptionFilter` maps them to `{ statusCode, error, message }` responses with the exception's status code

### Two processes, one codebase

| Process | Entry point | Root module | Imports |
|---|---|---|---|
| HTTP API | `src/main.ts` | `AppModule` | `RootConfigModule`, `DatabaseModule`, `QueueModule`, `AuthModule`, `VideosModule` |
| Video worker | `src/worker.ts` | `WorkerModule` (no HTTP, no controllers) | `RootConfigModule`, `DatabaseModule`, `QueueModule`, `UsersModule`, `VideoProcessingWorkerModule` |

`RootConfigModule` (`src/config/root-config.module.ts`) loads every `registerAs` config and validates the env with `envValidationSchema` (`src/config/env.validation.ts`). `DatabaseModule` is TypeORM over Postgres with `autoLoadEntities`. `JwtAuthGuard` and `ThrottlerGuard` are global (`APP_GUARD` in `AuthModule`); routes opt out with `@Public()`.

### Video modules

- `videos/videos-core.module.ts` — `VideosCoreModule`: `Video` entity, `VideosService` (persistence and conditional status transitions) and `VideoAccessPolicy`. No HTTP, storage or queue dependency, so the worker imports it.
- `videos/videos.module.ts` — `VideosModule`: `VideosController`, `VideoUploadService` (multipart upload session) and `VideoPlaybackService` (presigned read URLs). API only.
- `storage/` — `StorageModule`: `StorageService` over AWS SDK v3 S3 against MinIO, with two clients: `S3_CLIENTS.INTERNAL` (`S3_ENDPOINT`, container traffic) and `S3_CLIENTS.PUBLIC` (`S3_PUBLIC_ENDPOINT`, signs URLs returned to browsers). `StorageBootstrapService` creates the videos and thumbnails buckets on boot and, when `STORAGE_LIFECYCLE_RULES_ENABLED=true`, adds a rule that aborts incomplete multipart uploads after 1 day. S3 failures surface as `STORAGE_UNAVAILABLE` (503).
- `queue/queue.module.ts` — `QueueModule`: `BullModule.forRootAsync` with `REDIS_HOST` / `REDIS_PORT` and `QUEUE_PREFIX` (default `bull`).
- `video-processing/video-processing-queue.module.ts` — producer only: registers the `video-processing` queue and exports `VideoProcessingQueue` (used by `VideosModule`).
- `video-processing/video-processing-worker.module.ts` — consumer only (worker): `VideoProcessingProcessor` + `VideoProcessingService`, importing `VideosCoreModule`, `StorageModule` and `MediaModule`.
- `media/` — `MediaModule`: `FfmpegService` runs `ffprobe` (metadata) and `ffmpeg` (one JPEG frame, max width 640) with timeouts and output caps.
- `channels/` — `ChannelsService.findByUserId` resolves the uploader's channel (`CHANNEL_NOT_FOUND`, 404).

Storage object keys (`videos/video-object-keys.ts`): original at `{videoId}/original` in the videos bucket, thumbnail at `{videoId}/thumbnail.jpg` in the thumbnails bucket. They are persisted on the row (`original_key`, set on creation; `thumbnail_key`, set on `processing → ready`) and read from there — build new keys only through the helpers. Schema: migrations `src/database/migrations/1791237941900-CreateVideos.ts` and `1791382169844-AddVideoStorageKeys.ts`.

### Video lifecycle

`uploading` → `processing` → `ready` | `failed` (`VideoStatus`, `videos_status_enum`).

1. `POST /videos` creates the row (`uploading`) and an S3 multipart upload; the response carries the upload plan (16 MiB parts, at most 100 part URLs per request).
2. The client requests presigned part URLs and `PUT`s each part **directly to MinIO** — video bytes never go through the API.
3. `POST .../upload/complete` checks that every part is stored, completes the multipart upload, re-reads the real size (`HEAD`), and either fails the video with `FILE_TOO_LARGE` (over 10 GiB: object deleted, 422, nothing enqueued) or moves it to `processing` and enqueues a job. A repeated complete on a `processing` video only re-enqueues.
4. The worker job (`process-video`, `jobId` `video-{videoId}`, so enqueuing is idempotent; 3 attempts, exponential backoff from 1 s) probes the original through an internal presigned URL, uploads the thumbnail and marks the video `ready` with duration, width, height, codecs and container. Jobs for a video no longer `processing` are skipped.
5. Terminal errors (`SOURCE_OBJECT_MISSING`, `NO_VIDEO_STREAM`) mark the video `failed` immediately (`UnrecoverableError`, no retry); any other error retries and marks `PROCESSING_FAILED` on the last attempt.

### Video endpoints

All require a JWT. Only the owner can access a video: a non-owner gets the same `404 VIDEO_NOT_FOUND` as an unknown id. `:publicId` is the 11-character public id; malformed ids are rejected with `400 VALIDATION_ERROR`. Without a token every route returns 401.

| Method & path | Success | Purpose / main errors |
|---|---|---|
| `POST /videos` | 201 | Start upload. Body `filename`, `mime_type` (`video/mp4`, `video/quicktime`, `video/webm`, `video/x-matroska`), `size_bytes` (1 … 10 GiB), optional `title` (default derived from the filename). Returns `{ video, upload: { part_size_bytes, part_count, max_part_urls_per_request } }` |
| `POST /videos/:publicId/upload/part-urls` | 200 | Body `part_numbers` (1–100 items). Returns presigned `PUT` URLs (1 h) and `expires_at`. `400 PART_NUMBER_OUT_OF_RANGE`, `409 INVALID_UPLOAD_STATE` |
| `GET /videos/:publicId/upload/parts` | 200 | Parts already stored (`part_number`, `size_bytes`, `etag`), to resume an upload |
| `DELETE /videos/:publicId/upload` | 204 | Cancel (only while `uploading`): deletes the video row, aborts the multipart upload and deletes any stored object. `409 INVALID_UPLOAD_STATE` |
| `POST /videos/:publicId/upload/complete` | 202 | Finish the upload and enqueue processing. `409 UPLOAD_INCOMPLETE`, `409 INVALID_UPLOAD_STATE`, `422 VIDEO_FILE_TOO_LARGE` |
| `GET /videos/:publicId` | 200 | `VideoResponseDto`: status, metadata, `processing_error`, `thumbnail_url` (presigned, 15 min, only when available) |
| `GET /videos/:publicId/stream` | 200 | `{ url, expires_at }` presigned `GET` of the original (6 h, supports `Range`). `409 VIDEO_NOT_READY` |
| `GET /videos/:publicId/download` | 200 | Same, 15 min, with `Content-Disposition: attachment` using the original filename. `409 VIDEO_NOT_READY` |

The contract is exported to `openapi.json` (`npm run openapi:export`); `api.http` has a runnable walkthrough of the flow.

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
