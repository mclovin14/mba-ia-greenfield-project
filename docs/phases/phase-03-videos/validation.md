---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-05T11:56:07-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-05T11:54:31-03:00"
issues:
  - id: IC-1
    status: resolved
    resolved_by: phase-03-videos/TD-14
    summary: "Testing guide prescribes local-FS storage; phase storage is S3-compatible"
  - id: AMB-1
    status: resolved
    resolved_by: clarification
    summary: "'Rascunho' semantics and draft initial fields vs Fase 04 publication flow"
  - id: AMB-2
    status: resolved
    resolved_by: clarification
    summary: "'Metadados' to extract is unspecified (which fields are persisted)"
  - id: AMB-3
    status: resolved
    resolved_by: clarification
    summary: "'Sem impacto na performance' has no verifiable acceptance criterion"
  - id: AMB-4
    status: resolved
    resolved_by: clarification
    summary: "Abandoned/incomplete uploads: no cleanup policy"
  - id: AMB-5
    status: resolved
    resolved_by: clarification
    summary: "Accepted video formats and handling of non-video uploads unspecified"
  - id: AMB-6
    status: resolved
    resolved_by: clarification
    summary: "Video ownership: FK to channel or to user"
  - id: DG-1
    status: resolved
    resolved_by: clarification
    summary: "Within-phase ordering: public id and draft are created at upload start"
  - id: DG-2
    status: resolved
    resolved_by: clarification
    summary: "migrations.integration-spec is not re-entrant; new migration inherits bug"
  - id: OQ-1
    status: resolved
    resolved_by: phase-03-videos/TD-01
    summary: "TD-01 pending — Background Job Queue Technology"
  - id: OQ-2
    status: resolved
    resolved_by: phase-03-videos/TD-02
    summary: "TD-02 pending — Large File Upload Protocol"
  - id: OQ-3
    status: resolved
    resolved_by: phase-03-videos/TD-03
    summary: "TD-03 pending — Draft Pre-registration and Processing Trigger"
  - id: OQ-4
    status: resolved
    resolved_by: phase-03-videos/TD-04
    summary: "TD-04 pending — Video Worker Runtime and Topology"
  - id: OQ-5
    status: resolved
    resolved_by: phase-03-videos/TD-05
    summary: "TD-05 pending — FFmpeg Integration"
  - id: OQ-6
    status: resolved
    resolved_by: phase-03-videos/TD-06
    summary: "TD-06 pending — Unique Public Video Identifier (URL)"
  - id: OQ-7
    status: resolved
    resolved_by: phase-03-videos/TD-07
    summary: "TD-07 pending — Streaming and Download Delivery"
  - id: OQ-8
    status: resolved
    resolved_by: phase-03-videos/TD-08
    summary: "TD-08 pending — Video Status Lifecycle Model"
  - id: OQ-9
    status: resolved
    resolved_by: phase-03-videos/TD-09
    summary: "TD-09 pending — Processing Failure and Retry Policy"
  - id: OQ-10
    status: resolved
    resolved_by: phase-03-videos/TD-10
    summary: "TD-10 pending — Access Policy for Streaming and Download"
  - id: OQ-11
    status: resolved
    resolved_by: phase-03-videos/TD-11
    summary: "TD-11 pending — Storage Bucket and Object Key Layout"
  - id: OQ-12
    status: resolved
    resolved_by: phase-03-videos/TD-12
    summary: "TD-12 pending — S3 Client Library"
  - id: OQ-13
    status: resolved
    resolved_by: phase-03-videos/TD-13
    summary: "TD-13 pending — Local S3-compatible Storage Container Image"
  - id: OQ-14
    status: resolved
    resolved_by: phase-03-videos/TD-14
    summary: "TD-14 pending — Test Strategy for Object Storage and Queue"
  - id: ICC-1
    status: resolved
    resolved_by: clarification
    summary: "Strict-BFF inherited model vs browser-direct presigned storage access (TD-02, TD-07)"
  - id: AMB-7
    status: resolved
    resolved_by: clarification
    summary: "Presigned URL signing host: internal Compose host vs client-reachable host"
  - id: AMB-8
    status: resolved
    resolved_by: clarification
    summary: "Thumbnail delivery and access policy in Fase 03 unspecified"
  - id: DG-3
    status: resolved
    resolved_by: clarification
    summary: "Storage CORS (PUT + exposed ETag) prerequisite for browser-direct multipart"
advisories: []
---

# phase-03-videos — Validation

_Round 3 — clean. Round 1 raised 23 issues and round 2 raised 4 (ICC-1, AMB-7, AMB-8, DG-3, which came from interactions between the newly decided TDs and inherited context). All 27 are resolved; see `## Resolved Issues`. Re-running every check over the post-resolve context.md surfaced no new findings._

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._

## Resolved Issues

- **IC-1** — Testing guide prescribes local-FS storage; phase storage is S3-compatible. `resolved_by: phase-03-videos/TD-14` (Decision A).
  - For this phase, TD-14 supersedes the guide's storage row: integration and e2e tests run against real MinIO + Redis.
  - The override is recorded in context.md `## Testing Requirements`.
  - Updating the guide itself is a separate docs task.
- **AMB-1** — "Rascunho" semantics and the draft's initial fields. `resolved_by: clarification` (choice a).
  - Fase 03 persists only the processing status (`phase-03-videos/TD-08`) and has no editorial or visibility column. Every video is implicitly a draft (not listed, not public) until Fase 04 adds the publication axis.
  - At initiate, `title` defaults to the original filename without its extension, trimmed to the column limit; the client may optionally override it.
  - `description` is null.
- **AMB-2** — Which "metadados" to persist. `resolved_by: clarification` (choice a).
  - Persisted fields: `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec` (nullable), `container_format`, `size_bytes`, `mime_type`.
  - The raw ffprobe JSON is not stored.
- **AMB-3** — Acceptance criterion for "sem impacto na performance". `resolved_by: clarification` (choice a).
  - Video bytes never traverse the API process.
  - Initiate rejects a declared size above 10 GiB (10 × 1024³ bytes).
  - Complete re-checks the real object size via HeadObject.
  - An e2e test proves the upload endpoints never receive the file body.
- **AMB-4** — Abandoned or incomplete uploads. `resolved_by: clarification` (choice a).
  - An explicit owner cancel endpoint aborts the multipart upload and deletes the draft.
  - The storage bootstrap applies a bucket lifecycle rule `AbortIncompleteMultipartUpload` with `DaysAfterInitiation: 1`.
  - Stale DB drafts in `uploading` are accepted debt for Fase 04's management panel.
  - **Amendment (2026-10-05, from the plan-build storage probe; recommended option applied in a non-interactive session — the user can revert it).** A probe against the pinned Chainguard MinIO image (`RELEASE.2026-09-22T19-25-18Z`) showed:
    - `PutBucketLifecycleConfiguration` with only `AbortIncompleteMultipartUpload` returns **400 InvalidArgument**;
    - when the rule is combined with `Expiration`, the abort element is silently dropped.

    So the lifecycle rule cannot deliver the cleanup on MinIO. The intent (incomplete multipart parts are reclaimed after about 1 day) is kept by changing the mechanism:
    - Compose sets MinIO's native `MINIO_API_STALE_UPLOADS_EXPIRY=24h` explicitly (default cleanup interval);
    - the storage bootstrap applies the `AbortIncompleteMultipartUpload` (`DaysAfterInitiation: 1`) rule **only** when `STORAGE_LIFECYCLE_RULES_ENABLED=true`. The default is `false`, which is correct for MinIO; set it to `true` on AWS S3. A unit test proves the command is sent only when the flag is set.
- **AMB-5** — Accepted formats and non-video inputs. `resolved_by: clarification` (choice a).
  - Initiate allowlist: `video/mp4`, `video/quicktime`, `video/webm`, `video/x-matroska`.
  - The worker's ffprobe result is authoritative. If no video stream is found, the video goes to a terminal `failed` state with a domain error code and no retry.
- **AMB-6** — Video ownership. `resolved_by: clarification` (choice a).
  - `videos.channel_id` is an FK to `channels.id`.
  - The owner is the authenticated user's channel (one per user, `phase-02-auth/TD-10`).
  - Authorization compares `channel.user_id` with the JWT subject.
- **DG-1** — Ordering within the phase. `resolved_by: clarification` (choice a). Build order:
  1. Storage + queue infrastructure: Compose services, Joi env keys, `registerAs` config factories.
  2. The `videos` entity and migration, including `public_id`.
  3. Upload initiate/complete, which creates the draft and enqueues the job.
  4. Worker processing: metadata + thumbnail.
  5. Streaming/download delivery.
- **DG-2** — `migrations.integration-spec` is not re-entrant. `resolved_by: clarification` (choice a).
  - The Fase 03 migration SI also makes `src/database/migrations.integration-spec.ts` re-entrant:
    - drop every `*_enum` type the managed migrations create;
    - run the drops sequentially, in reverse FK order, instead of in `Promise.all`;
    - update the expected migration list and count.
  - No existing migration file is edited (Immutability rule).
- **OQ-1** — TD-01 pending — Background Job Queue Technology. `resolved_by: phase-03-videos/TD-01` (A — BullMQ + Redis).
- **OQ-2** — TD-02 pending — Large File Upload Protocol. `resolved_by: phase-03-videos/TD-02` (A — presigned S3 multipart, direct to storage).
- **OQ-3** — TD-03 pending — Draft Pre-registration and Processing Trigger. `resolved_by: phase-03-videos/TD-03` (A — API-driven initiate/complete).
- **OQ-4** — TD-04 pending — Video Worker Runtime and Topology. `resolved_by: phase-03-videos/TD-04` (A — same codebase, separate entrypoint + Compose service).
- **OQ-5** — TD-05 pending — FFmpeg Integration. `resolved_by: phase-03-videos/TD-05` (A — spawn system ffprobe/ffmpeg on a presigned GET URL).
- **OQ-6** — TD-06 pending — Unique Public Video Identifier. `resolved_by: phase-03-videos/TD-06` (B — random base64url `public_id`, unique + retry).
- **OQ-7** — TD-07 pending — Streaming and Download Delivery. `resolved_by: phase-03-videos/TD-07` (A — presigned GET with Range support).
- **OQ-8** — TD-08 pending — Video Status Lifecycle Model. `resolved_by: phase-03-videos/TD-08` (A — processing status as Postgres enum).
- **OQ-9** — TD-09 pending — Processing Failure and Retry Policy. `resolved_by: phase-03-videos/TD-09` (A — bounded retries with exponential backoff, then `failed`).
- **OQ-10** — TD-10 pending — Access Policy for Streaming and Download. `resolved_by: phase-03-videos/TD-10` (A — owner-only, centralized policy).
- **OQ-11** — TD-11 pending — Storage Bucket and Object Key Layout. `resolved_by: phase-03-videos/TD-11` (B — two buckets keyed by `videoId`).
- **OQ-12** — TD-12 pending — S3 Client Library. `resolved_by: phase-03-videos/TD-12` (A — AWS SDK v3).
- **OQ-13** — TD-13 pending — Local S3-compatible Storage Container Image. `resolved_by: phase-03-videos/TD-13` (A — Chainguard MinIO pinned by digest).
- **OQ-14** — TD-14 pending — Test Strategy for Object Storage and Queue. `resolved_by: phase-03-videos/TD-14` (A — real MinIO + Redis for integration/e2e).
- **ICC-1** — The inherited strict-BFF model and browser-direct presigned storage access. `resolved_by: clarification` (choice a). The two are compatible by scope:
  - The strict-BFF rule (`next-frontend-config-base/TD-03` via `phase-02-auth-frontend/TD-01`/`TD-05`) governs calls to the NestJS API only.
  - The BFF relays the API's presigned URLs. The browser transfers video bytes directly to and from object storage, matching the C4 "Frontend streams from Object Storage" relation.
  - The plan records this as a cross-phase contract: future frontend phases must not proxy upload or stream bytes through the BFF, which would break AMB-3.
- **AMB-7** — The host that presigned URLs are signed for. `resolved_by: clarification` (choice a).
  - Two storage config keys in the `registerAs` factory and the Joi schema:
    - `S3_ENDPOINT` is the internal endpoint, a Compose service name such as `http://minio:9000`.
    - `S3_PUBLIC_ENDPOINT` is client-facing, e.g. `http://localhost:9000` in dev.
  - A dedicated presigning `S3Client` bound to `S3_PUBLIC_ENDPOINT` signs the client-facing URLs: upload parts, stream, download and thumbnail.
  - The internal client signs the worker's ffprobe/ffmpeg input URLs.
  - `S3_PUBLIC_ENDPOINT` is documented as a browser-facing URL, outside the inter-service "service name, never localhost" rule.
- **AMB-8** — Thumbnail delivery in Fase 03. `resolved_by: clarification` (choice a).
  - The thumbnail is delivered as a short-lived presigned GET URL in the owner-only video read response, under the same centralized policy as `phase-03-videos/TD-10`.
  - The thumbnails bucket stays private. Public serving is decided in Fase 04/05.
- **DG-3** — Storage CORS for browser-direct multipart and streaming. `resolved_by: clarification` (choice a). The storage SI configures CORS in-phase through the storage server configuration:
  - `STORAGE_CORS_ALLOWED_ORIGINS` sets the allowed origins and defaults to the frontend dev origin;
  - `PUT`, `GET` and `HEAD` are allowed;
  - `ETag`, `Content-Range` and `Accept-Ranges` are exposed;
  - `Range` is accepted.

  An integration test sends a CORS preflight and an actual cross-origin request, then asserts the allow-origin header and that `ETag` is exposed.

  **Probe confirmation (2026-10-05).** The mechanism is fixed by evidence, not by preference:
  - MinIO answers the bucket CORS API (`PutBucketCors`) with **501 NotImplemented**.
  - The server env `MINIO_API_CORS_ALLOW_ORIGIN` works. An allowed origin receives `Access-Control-Allow-Origin`, with methods and headers (including `Range`) reflected in the preflight. A disallowed origin receives no ACAO.
  - `ETag`, `Accept-Ranges` and `Content-Range` are exposed by default.
  - Compose therefore wires `MINIO_API_CORS_ALLOW_ORIGIN: ${STORAGE_CORS_ALLOWED_ORIGINS}`.
  - The same probe confirmed `Range: bytes=0-4` → `206` with `Content-Range`.
