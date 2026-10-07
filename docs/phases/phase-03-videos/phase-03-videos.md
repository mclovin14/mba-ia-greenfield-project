---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-05T11:56:07-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-05T12:00:27-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-05T11:54:31-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the video ingestion pipeline. It adds an S3-compatible storage service for videos and thumbnails and a background processing queue. Uploads of up to 10GB go directly to storage without passing through the API. Starting an upload automatically pre-registers the video as a draft. After upload, processing runs automatically: a separate worker extracts the duration and metadata and generates a thumbnail from a frame. Each video gets a unique URL with no conflicts, and its owner can play it by streaming (HTTP Range) or download it.

---

## Step Implementations

### SI-03.1 — Infra: Redis, MinIO, serviço video-worker e namespaces de configuração

**Description:** Sobe a infraestrutura nova da fase: Redis (fila), MinIO (storage S3-compatível) e o serviço `video-worker` com ffmpeg. Também tipa e valida a configuração `storage`/`queue`. Vem primeiro porque é a raiz do DG-1: todos os SIs seguintes dependem dela.

**Technical actions:**

1. Editar `compose.yaml` e adicionar os serviços:
   - `redis`:
     - imagem `redis:8.4-alpine`;
     - `command: ["redis-server", "--maxmemory-policy", "noeviction"]`, obrigatório para o BullMQ (library-refs BullMQ);
     - healthcheck `["CMD", "redis-cli", "ping"]`;
     - porta `6379:6379`.
   - `minio`:
     - imagem `cgr.dev/chainguard/minio@sha256:4cf4831a2bbcf13ddca09c1cbcc9faff716dd3c4247e0babc32864b8ee8e0034` (per `phase-03-videos/TD-13`); o entrypoint já é `/usr/bin/minio`, então `command: ["server", "/data", "--console-address", ":9001"]`;
     - `MINIO_ROOT_USER: ${S3_ACCESS_KEY_ID:-streamtube}` e `MINIO_ROOT_PASSWORD: ${S3_SECRET_ACCESS_KEY:-streamtube-secret}`;
     - `MINIO_API_CORS_ALLOW_ORIGIN: ${STORAGE_CORS_ALLOWED_ORIGINS:-http://localhost:3001}` (DG-3, confirmado por probe);
     - `MINIO_API_STALE_UPLOADS_EXPIRY: 24h` (emenda AMB-4);
     - volume nomeado `minio-data:/data`, portas `9000:9000` e `9001:9001`;
     - healthcheck `["CMD", "bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/9000 && printf 'GET /minio/health/live HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n' >&3 && [[ \"$$(head -1 <&3)\" == *' 200 '* ]]"]`, com `interval: 5s` e `retries: 10`.
       - A imagem não tem `curl`, `wget` nem `grep`; tem `bash` e `head` (verificado no probe). Por isso a comparação é feita em bash puro.
       - O `$$` escapa a interpolação do Compose.
   - `nestjs-api` ganha `depends_on` `redis` e `minio` com `condition: service_healthy`.
2. Adicionar o serviço `video-worker` em `compose.yaml` (per `phase-03-videos/TD-04`):
   - mesmo `build` (`Dockerfile.dev`) e mesmo volume `.:/home/node/app` do `nestjs-api`, sem `ports`;
   - `depends_on` `db`, `redis` e `minio` healthy;
   - CMD ocioso herdado da imagem, iniciado explicitamente com `docker compose exec video-worker npm run start:worker` (convenção do `nestjs-api`, que também é iniciado via exec).

   Editar `Dockerfile.dev` para `apt install -y procps curl ffmpeg` (per `phase-03-videos/TD-05`).
3. Criar `src/config/storage.config.ts`, `registerAs('storage')`, com:
   - `endpoint` e `publicEndpoint` (AMB-7);
   - `region`, `accessKeyId`, `secretAccessKey`;
   - `videosBucket`, `thumbnailsBucket` (per `phase-03-videos/TD-11`);
   - `forcePathStyle: true` (per `phase-03-videos/TD-12`);
   - `lifecycleRulesEnabled` (`STORAGE_LIFECYCLE_RULES_ENABLED === 'true'`).

   Criar `src/config/queue.config.ts`, `registerAs('queue')`, com `host`, `port` e `prefix`. Registrar os dois no `load` do `ConfigModule.forRoot` em `app.module.ts`.
4. Estender `src/config/env.validation.ts` com:
   - `S3_ENDPOINT` (uri, required) e `S3_PUBLIC_ENDPOINT` (uri, required);
   - `S3_REGION` (default `us-east-1`);
   - `S3_ACCESS_KEY_ID` e `S3_SECRET_ACCESS_KEY` (required);
   - `S3_VIDEOS_BUCKET` (default `videos`) e `S3_THUMBNAILS_BUCKET` (default `thumbnails`);
   - `STORAGE_LIFECYCLE_RULES_ENABLED` (`'true'|'false'`, default `'false'`);
   - `REDIS_HOST` (default `redis`), `REDIS_PORT` (port, default `6379`), `QUEUE_PREFIX` (default `bull`).

   Atualizar `.env.example`: `S3_ENDPOINT=http://minio:9000`, `S3_PUBLIC_ENDPOINT=http://localhost:9000`, `REDIS_HOST=redis`, `STORAGE_CORS_ALLOWED_ORIGINS=http://localhost:3001`. Este último é lido só pela interpolação do Compose.
5. Atualizar `nestjs-project/CLAUDE.md`:
   - novos serviços e portas (Redis 6379, MinIO API 9000 e console 9001);
   - como iniciar o worker;
   - a exceção documentada do AMB-7: `S3_PUBLIC_ENDPOINT` é a URL vista pelo browser, por isso usa `localhost`; o tráfego entre serviços continua usando o nome do serviço;
   - a pré-condição de testes: `redis` e `minio` healthy.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` | Integration: rejeita boot sem `S3_ENDPOINT`/`S3_ACCESS_KEY_ID`; aplica defaults de bucket, Redis e flag de lifecycle | `src/config/env.validation.integration-spec.ts` |
| `storage.config` / `queue.config` | Unit: mapeia env para config tipada; `STORAGE_LIFECYCLE_RULES_ENABLED` só é `true` com a string `'true'` | `src/config/storage.config.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` deixa `db`, `redis` e `minio` em estado `healthy` e `nestjs-api`/`video-worker` em `running`.
- `docker compose exec video-worker ffprobe -version` e `ffmpeg -version` terminam com exit code 0.
- `docker compose exec redis redis-cli CONFIG GET maxmemory-policy` retorna `noeviction`.
- Bootstrap da aplicação sem `S3_ENDPOINT` falha na validação de ambiente, com mensagem citando a chave.
- `docker compose config minio` mostra, no ambiente resolvido, `MINIO_API_STALE_UPLOADS_EXPIRY=24h` e `MINIO_API_CORS_ALLOW_ORIGIN` igual a `STORAGE_CORS_ALLOWED_ORIGINS`.

---

### SI-03.2 — StorageModule: clientes S3, StorageService e bootstrap de buckets

**Description:** Encapsula todo acesso ao object storage num módulo próprio, o único lugar do código que conhece o AWS SDK. Os clientes interno e público ficam separados (AMB-7), os erros do SDK são traduzidos para erros de domínio e os buckets são criados de forma idempotente. É pré-requisito de upload, worker e streaming.

**Technical actions:**

1. Instalar `@aws-sdk/client-s3@^3.1146.0` e `@aws-sdk/s3-request-presigner@^3.1146.0`, com as duas na mesma versão (library-refs). Criar `src/storage/storage.module.ts` com dois providers por factory sobre `ConfigService` (per `phase-03-videos/TD-12`):
   - `S3_INTERNAL_CLIENT` (`endpoint: storage.endpoint`) e `S3_PUBLIC_CLIENT` (`endpoint: storage.publicEndpoint`);
   - ambos com `forcePathStyle: true`, `requestChecksumCalculation: 'WHEN_REQUIRED'`, `responseChecksumValidation: 'WHEN_REQUIRED'` e `credentials`/`region` do namespace `storage` (library-refs `@aws-sdk/client-s3`);
   - o módulo exporta só `StorageService`, e os clientes recebem `destroy()` em `onModuleDestroy`.
2. Criar `src/storage/storage.service.ts`, com métodos parametrizados por `StorageBucket = 'videos' | 'thumbnails'`:
   - `createMultipartUpload(key, contentType)` → `uploadId`;
   - `presignUploadPart(key, uploadId, partNumber, expiresIn)`, assinado pelo cliente **público**;
   - `listParts(key, uploadId)`, paginado via `PartNumberMarker` até `IsTruncated = false`;
   - `completeMultipartUpload(key, uploadId, parts)` e `abortMultipartUpload(key, uploadId)`;
   - `headObject(bucket, key)` → `{ contentLength }`;
   - `deleteObject(bucket, key)`;
   - `putObject(bucket, key, body, contentType)`;
   - `presignGetObject(bucket, key, { expiresIn, client: 'public' | 'internal', responseContentType?, responseContentDisposition? })`, usando `getSignedUrl` de `@aws-sdk/s3-request-presigner` (TTL ≤ 7 dias, library-refs).
3. Criar a tradução de erros, usada em todos os métodos do serviço (Error Catalog → StorageService error translation):
   - `src/storage/storage.errors.ts` com:
     - `StorageUploadNotFoundError` (`NoSuchUpload`);
     - `StorageObjectNotFoundError` (`NoSuchKey`, `NotFound` ou `$metadata.httpStatusCode === 404`);
     - `StorageInvalidPartsError` (`EntityTooSmall`, `InvalidPart`, `InvalidPartOrder`);
   - `src/storage/exceptions/storage-unavailable.exception.ts` (`STORAGE_UNAVAILABLE`, 503), lançada para qualquer outro erro, que é logado sem credenciais.
4. Criar `src/storage/storage-bootstrap.service.ts` (`OnApplicationBootstrap`):
   - `CreateBucket` para `videosBucket` e `thumbnailsBucket`, tratando `BucketAlreadyOwnedByYou`/`BucketAlreadyExists` como sucesso (per `phase-03-videos/TD-11`);
   - **somente se** `storage.lifecycleRulesEnabled`, `PutBucketLifecycleConfiguration` no bucket de vídeos com a regra `AbortIncompleteMultipartUpload { DaysAfterInitiation: 1 }` (emenda AMB-4).
5. Criar o helper de teste `src/test/presigned-request.ts`: `requestPresigned(url, { method, body?, headers? })`.
   - `body` é `Buffer | Readable`. Quando for stream, o chamador informa `Content-Length` em `headers` e o helper faz `pipe` sem bufferizar, o que permite enviar partes lidas do disco com `fs.createReadStream({ start, end })` (SI-03.13).
   - Usa `node:http` com o host trocado de `S3_PUBLIC_ENDPOINT` para `S3_ENDPOINT` e o header `Host` mantido no host original assinado (SigV4 assina `host`). Assim os testes, que rodam dentro do contêiner, exercitam a URL pública real.
   - Criar também `emptyBucket(bucket)` para limpeza de objetos e uploads pendentes entre testes.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageModule` | Unit: compilação do módulo com `ConfigModule` real | `src/storage/storage.module.spec.ts` |
| `StorageService` (tradução de erros) | Unit: `NoSuchUpload` → `StorageUploadNotFoundError`; 404 → `StorageObjectNotFoundError`; outro erro → `StorageUnavailableException`; cliente público vs interno por método (mock de `send` nos clientes injetados) | `src/storage/storage.service.spec.ts` |
| `StorageBootstrapService` | Unit: `PutBucketLifecycleConfiguration` enviado só com a flag `true`; `BucketAlreadyOwnedByYou` não falha | `src/storage/storage-bootstrap.service.spec.ts` |
| `StorageService` × MinIO | Integration (MinIO real, per `phase-03-videos/TD-14`): multipart ida e volta (create → PUT presignado → listParts → complete → head); GET presignado com `Range`; `ResponseContentDisposition`; abort → `NoSuchUpload` traduzido | `src/storage/storage.service.integration-spec.ts` |
| CORS do MinIO | Integration: preflight `PUT` e `GET` com origem permitida e com origem não permitida; `ETag` exposto (DG-3) | `src/storage/storage-cors.integration-spec.ts` |

**Dependencies:** SI-03.1 — MinIO no Compose e namespace `storage` validado.

**Acceptance criteria:**

- O boot da aplicação com MinIO vazio cria os buckets `videos` e `thumbnails`; um segundo boot não falha.
- Um `PUT` numa URL de `UploadPart` presignada responde `200` com header `ETag`. Após `CompleteMultipartUpload`, `HeadObject` reporta `ContentLength` igual à soma dos bytes enviados.
- Um `GET` numa URL presignada de objeto com `Range: bytes=0-4` responde `206` com `Content-Range: bytes 0-4/{tamanho}`.
- Um `GET` numa URL presignada com `ResponseContentDisposition` responde com `Content-Disposition: attachment; …`.
- URLs presignadas para o cliente público têm o host de `S3_PUBLIC_ENDPOINT`; as do cliente interno, o host de `S3_ENDPOINT`.
- Um preflight cross-origin de `PUT` vindo de `STORAGE_CORS_ALLOWED_ORIGINS` recebe `Access-Control-Allow-Origin`, e a resposta real expõe `ETag` em `Access-Control-Expose-Headers`.
- Com `STORAGE_LIFECYCLE_RULES_ENABLED=false` (default), o boot não envia regra de lifecycle e não falha contra o MinIO.

---

### SI-03.3 — QueueModule e produtor da fila video-processing

**Description:** Configura a conexão BullMQ/Redis e o lado produtor do contrato de mensagens (Events/Messages → `process-video`). Fica num módulo separado do consumidor para que a API só publique e nunca processe (per `phase-03-videos/TD-04`).

**Technical actions:**

1. Instalar `@nestjs/bullmq@^11.0.5` e `bullmq@^5.81.5` (library-refs: a linha 12 do `@nestjs/bullmq` é ESM-only e incompatível com o projeto CommonJS). Criar `src/queue/queue.module.ts` com `BullModule.forRootAsync({ inject: [ConfigService], useFactory })`, retornando `{ connection: { host: queue.host, port: queue.port }, prefix: queue.prefix }` (per `phase-03-videos/TD-01`).
2. Criar o contrato compartilhado entre produtor e consumidor:
   - `src/video-processing/video-processing.constants.ts`:
     - `VIDEO_PROCESSING_QUEUE = 'video-processing'` e `PROCESS_VIDEO_JOB = 'process-video'`;
     - `videoProcessingJobId(videoId)` → `` `video-${videoId}` ``;
     - `VIDEO_PROCESSING_JOB_OPTIONS = { attempts: 3, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: { age: 3600, count: 1000 }, removeOnFail: { age: 86400 } }` (per `phase-03-videos/TD-09`).
   - `src/video-processing/video-processing.types.ts`: `ProcessVideoJobData = { videoId: string }`.
3. Criar `src/video-processing/video-processing-queue.module.ts` com:
   - `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`;
   - o provider `VideoProcessingQueue` (`src/video-processing/video-processing.queue.ts`, `@InjectQueue`), com `enqueue(videoId)` = `queue.add(PROCESS_VIDEO_JOB, { videoId }, { ...VIDEO_PROCESSING_JOB_OPTIONS, jobId: videoProcessingJobId(videoId) })`.

   O módulo exporta só `VideoProcessingQueue` e **não** declara processor.
4. Importar `QueueModule` no `AppModule`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingQueueModule` | Unit: compilação com `QueueModule` + `ConfigModule` reais | `src/video-processing/video-processing-queue.module.spec.ts` |
| `VideoProcessingQueue` × Redis | Integration (Redis real, per `phase-03-videos/TD-14`): nome, payload, `jobId` e opções do job; deduplicação de um segundo `enqueue`. Usa `QUEUE_PREFIX` único por execução (`test-{uuid}`), para que um `video-worker` rodando não consuma os jobs do teste, e `queue.obliterate({ force: true })` no `afterAll` | `src/video-processing/video-processing.queue.integration-spec.ts` |

**Dependencies:** SI-03.1 — Redis no Compose e namespace `queue` validado.

**Acceptance criteria:**

- `enqueue(videoId)` cria na fila `video-processing` um job `process-video` com `data = { videoId }` e `id = video-{videoId}`.
- O job enfileirado tem `opts.attempts = 3` e `opts.backoff = { type: 'exponential', delay: 1000 }`.
- Dois `enqueue` com o mesmo `videoId` resultam em exatamente um job na fila.
- A API sobe sem registrar nenhum worker na fila `video-processing` (contagem de workers da fila = 0 com só a API rodando).

---

### SI-03.4 — Entidade Video, migration e re-entrância do teste de migrations

**Description:** Cria a tabela `videos` exatamente como em `### Data Model → Video`, com o enum de status e a relação com `Channel`. Também torna `migrations.integration-spec.ts` re-entrante (DG-2), porque a terceira migration do projeto quebraria o teste atual.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts`:
   - colunas, tipos e constraints exatamente como na tabela `### Data Model → Video`;
   - `export enum VideoStatus { Uploading = 'uploading', Processing = 'processing', Ready = 'ready', Failed = 'failed' }` com `enumName: 'videos_status_enum'` (per `phase-03-videos/TD-08`);
   - transformer `bigint → number` em `size_bytes`;
   - `@Index({ unique: true })` em `public_id` e `@Index()` em `channel_id`;
   - `@ManyToOne` para `Channel` + `@JoinColumn({ name: 'channel_id' })`.

   Adicionar em `src/channels/entities/channel.entity.ts` só o inverso `@OneToMany(() => Video, (video) => video.channel) videos: Video[]`.
2. Criar `src/videos/video-object-keys.ts`, com as funções puras `videoOriginalKey(id)` → `{id}/original` e `videoThumbnailKey(id)` → `{id}/thumbnail.jpg` (per `phase-03-videos/TD-11`).
3. Gerar a migration com `docker compose exec nestjs-api npm run migration:generate -- src/database/migrations/CreateVideos` (regra: migration gerada pelo CLI, nunca escrita à mão). Revisar que o `up()` cria `videos_status_enum`, a tabela, os dois índices e a FK, e que o `down()` desfaz na ordem inversa. **Nenhuma migration existente é editada** (Immutability rule, DG-2).
4. Tornar `src/database/migrations.integration-spec.ts` re-entrante (DG-2):
   - incluir `Video` nas entities e a nova migration na lista;
   - `MANAGED_TABLES` passa a incluir `videos`;
   - os `DROP TABLE` rodam **sequencialmente**, em ordem reversa de FK (`videos`, `refresh_tokens`, `verification_tokens`, `channels`, `users`, `migrations`), em vez de `Promise.all`;
   - depois, `DROP TYPE IF EXISTS` para todos os `*_enum` criados pelas migrations gerenciadas (`verification_tokens_type_enum`, `videos_status_enum`);
   - a expectativa de contagem passa para `3`;
   - o teste de revert passa a afirmar que `undoLastMigration()` remove `videos` e `videos_status_enum`.
5. Atualizar `cleanAllTables` em `src/test/create-test-data-source.ts`: `DELETE FROM "videos"` **antes** de `channels`, por causa da FK `NO ACTION`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: `public_id` único (insert duplicado viola `23505`); `status` default `'uploading'`; enum rejeita valor fora do domínio; FK rejeita `channel_id` inexistente; `size_bytes` volta como `number` para um valor > 2³¹ | `src/videos/entities/video.entity.integration-spec.ts` |
| Migrations | Integration: aplica as 3 migrations do zero, reverte a última, re-aplica, e roda duas vezes seguidas sem falhar (re-entrância) | `src/database/migrations.integration-spec.ts` |
| `video-object-keys` | Unit: formato das duas chaves | `src/videos/video-object-keys.spec.ts` |

**Dependencies:** SI-03.1 — ordem do DG-1 (infra antes da entidade). Não há dependência técnica de storage ou fila.

**Acceptance criteria:**

- `npm run migration:run` num banco com as 2 migrations existentes cria a tabela `videos` e o tipo `videos_status_enum`; `npm run migration:revert` remove os dois e deixa as tabelas da Fase 02 intactas.
- Inserir dois vídeos com o mesmo `public_id` falha com violação de unicidade (`23505`).
- Inserir um vídeo sem `status` persiste `status = 'uploading'`.
- Inserir um vídeo com `channel_id` inexistente falha com violação de FK.
- Um vídeo com `size_bytes = 10737418240` é lido de volta como o `number` `10737418240`.
- Rodar `npm run test:integration` duas vezes seguidas no mesmo banco passa nas duas execuções.

---

### SI-03.5.1 — Domínio de vídeos: canal do usuário, public_id, título default e política de acesso (auto-split from SI-03.5 by /plan-build)

_Auto-split rationale: original SI would have 7 test files; split per "artifact type" (domain services + policy / upload endpoint wiring)._

**Description:** Reúne as peças de domínio que todo endpoint de vídeo usa: resolver o canal do usuário (AMB-6), criar o rascunho com `public_id` único (TD-06), derivar o título default (AMB-1) e checar o dono num ponto central (TD-10). Cada peça fica no módulo dono: canal em `ChannelsModule`, vídeo em `VideosModule`.

**Technical actions:**

1. Em `src/channels/channels.service.ts`, adicionar `findByUserId(userId)`, que lança `ChannelNotFoundException` (`src/channels/exceptions/channel-not-found.exception.ts`, `CHANNEL_NOT_FOUND`, 404) quando não há canal. A consulta de canal fica no `ChannelsModule`, dono da entidade (SRP), e o `VideosModule` só a consome.
2. Criar `src/common/database/pg-errors.ts` com `isPgUniqueViolationOnColumn(err, column)`: mesma lógica privada que já existe em `ChannelsService` (`QueryFailedError`, `code === '23505'`, `detail.includes(column)`). Mover `ChannelsService` para este helper é **tarefa separada** (fora de escopo: refatoração não misturada a mudança funcional).

   Criar `src/videos/public-id.ts` com `generatePublicId()` = `randomBytes(8).toString('base64url')`, sempre 11 caracteres (per `phase-03-videos/TD-06`).
3. Criar `src/videos/video-title.ts` com `deriveDefaultTitle(filename)` (AMB-1):
   - remove a última extensão e faz trim;
   - corta em 100 caracteres;
   - retorna `'Untitled'` se o resultado ficar vazio.
4. Criar `src/videos/videos.service.ts` (persistência de `Video`):
   - `createDraft({ channelId, title, originalFilename, mimeType, sizeBytes })`: `insert` com `generatePublicId()`; ao violar unicidade em `public_id`, gera outro id e tenta de novo, até 5 vezes. Qualquer outro erro é relançado. O insert é feito fora de transação, porque em Postgres uma violação aborta a transação corrente;
   - `setUploadId(id, uploadId)` e `delete(id)`;
   - `findOwnedByPublicId(publicId, userId)`: carrega o vídeo com `channel` e chama `VideoAccessPolicy.assertOwner`.

   Registrar o serviço em `src/videos/videos-core.module.ts`:
   - `TypeOrmModule.forFeature([Video])` + `VideosService` + `VideoAccessPolicy`, exportando os dois;
   - sem controller e sem dependência de storage ou fila, para que o worker o importe sem carregar a superfície HTTP (SRP, `phase-03-videos/TD-04`).
5. Criar `src/videos/video-access.policy.ts`:
   - `assertOwner(video | null, userId)` lança `VideoNotFoundException` (`src/videos/exceptions/video-not-found.exception.ts`, `VIDEO_NOT_FOUND`, 404) tanto para vídeo inexistente quanto para `video.channel.user_id !== userId` (per `phase-03-videos/TD-10`, AMB-6);
   - é o único lugar que compara donos.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `ChannelsService.findByUserId` | Integration: retorna o canal do usuário; usuário sem canal → `ChannelNotFoundException` | `src/channels/channels.service.integration-spec.ts` |
| `VideosService` (retry de `public_id`) | Unit: colisão em `public_id` gera novo id e tenta de novo; violação em outra coluna é relançada; desiste após 5 tentativas (mock do repositório) | `src/videos/videos.service.spec.ts` |
| `VideosService` × Postgres | Integration: `createDraft` persiste `status = 'uploading'`, `description = null` e `public_id` com `^[A-Za-z0-9_-]{11}$`; `findOwnedByPublicId` devolve o vídeo ao dono e lança `VideoNotFoundException` para outro usuário e para `publicId` inexistente | `src/videos/videos.service.integration-spec.ts` |
| `VideoAccessPolicy` | Unit: dono passa; não dono e `null` lançam a mesma exceção | `src/videos/video-access.policy.spec.ts` |
| `deriveDefaultTitle` | Unit: `"Minhas Férias.final.mp4"` → `"Minhas Férias.final"`; `".mp4"` e `"   "` → `"Untitled"`; nome com 300 caracteres → 100 caracteres | `src/videos/video-title.spec.ts` |

**Dependencies:** SI-03.4 — entidade `Video` e tabela `videos`.

**Acceptance criteria:**

- `createDraft` persiste um vídeo com `status = 'uploading'`, `description = null` e um `public_id` de 11 caracteres no alfabeto `[A-Za-z0-9_-]`.
- Quando o `public_id` gerado já existe, `createDraft` persiste o vídeo com outro `public_id`, sem erro para o chamador.
- `findOwnedByPublicId` com o `publicId` de um vídeo de outro canal lança o mesmo `VIDEO_NOT_FOUND` de um `publicId` inexistente.
- `findByUserId` de um usuário sem canal lança `CHANNEL_NOT_FOUND`.
- Um rascunho criado sem `title` recebe o nome do arquivo sem a última extensão, ou `'Untitled'` quando ele fica vazio.

---

### SI-03.5.2 — Endpoint POST /videos: iniciar upload e pré-cadastrar rascunho (auto-split from SI-03.5 by /plan-build)

_Auto-split rationale: original SI would have 7 test files; split per "artifact type" (domain services + policy / upload endpoint wiring)._

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-initiate-upload.plan.md`
**Authorization:** Authenticated — o vídeo é criado no canal do chamador (`### Authorization Matrix`)

**Description:** Expõe o initiate do TD-03: pré-cadastra o rascunho e abre o multipart upload no storage numa única chamada. Devolve ao cliente tudo o que ele precisa para enviar as partes direto ao storage, sem que os bytes passem pela API (AMB-3).

**Technical actions:**

1. Criar `src/videos/videos.constants.ts` com:
   - `VIDEO_ALLOWED_MIME_TYPES` (AMB-5) e `VIDEO_MAX_SIZE_BYTES = 10 * 1024 ** 3` (AMB-3);
   - `VIDEO_UPLOAD_PART_SIZE_BYTES = 16 * 1024 ** 2`, `VIDEO_PART_URL_TTL_SECONDS = 3600` e `VIDEO_MAX_PART_URLS_PER_REQUEST = 100`;
   - `VideoProcessingErrorCode` (`### Error Catalog` → Worker failure codes).

   Criar também `videoPartCount(sizeBytes)` = `Math.ceil(sizeBytes / VIDEO_UPLOAD_PART_SIZE_BYTES)`.
2. Criar `src/videos/video-upload.service.ts` com `initiate(userId, dto)`, seguindo a ordem de `### API Contracts → POST /videos → Behavior`:
   - `ChannelsService.findByUserId`;
   - `VideosService.createDraft`, com `title = dto.title ?? deriveDefaultTitle(dto.filename)`;
   - `StorageService.createMultipartUpload(videoOriginalKey(id), dto.mime_type)`;
   - `VideosService.setUploadId`.

   Se o storage falhar, o serviço faz `VideosService.delete(id)` e relança (compensação: nenhum rascunho sem `upload_id`). Retorna `{ video, upload: { part_size_bytes, part_count, max_part_urls_per_request } }` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`).
3. Criar os DTOs:
   - `src/videos/dto/initiate-upload.dto.ts`, com as regras de `#### Validation Rules — Videos`;
   - `src/videos/dto/video-response.dto.ts`, com o mapper puro `toVideoResponse(video, thumbnailUrl)` (campos de `VideoResponse`, nunca `id`/`channel_id`/`upload_id`);
   - `src/videos/dto/initiate-upload-response.dto.ts`;
   - `src/videos/dto/video-public-id-param.dto.ts`, usado pelos SIs seguintes.
4. Criar `src/videos/videos.controller.ts`, seguindo `.claude/rules/nestjs-controllers`:
   - `@Controller('videos')`, `@ApiTags('videos')`, `@SkipThrottle()` e `@ApiBearerAuth('access-token')` (`### API Contracts → Common conventions`);
   - `@Post()` + `@HttpCode(201)`, com `@CurrentUser() user: JwtPayload` e delegação para `VideoUploadService.initiate(user.sub, dto)`;
   - `@ApiOperation` e `@ApiResponse` para 201, 400, 401 e 404, com `getSchemaPath(ApiErrorEnvelope)` nos erros.
5. Criar `src/videos/videos.module.ts`, a superfície HTTP:
   - imports: `VideosCoreModule`, `ChannelsModule`, `StorageModule`, `VideoProcessingQueueModule`;
   - providers: `VideoUploadService`;
   - controller: `VideosController`.

   Registrar `VideosModule` em `AppModule`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoUploadService.initiate` | Unit: falha do `createMultipartUpload` remove o rascunho e relança; `part_count` para 1 byte, 16 MiB exatos, 16 MiB + 1 e 10 GiB (= 640); `title` explícito vence o default; `CHANNEL_NOT_FOUND` propaga sem criar rascunho (mocks de `VideosService`, `ChannelsService`, `StorageService` — per `phase-03-videos/TD-14`) | `src/videos/video-upload.service.spec.ts` |
| `toVideoResponse` | Unit: saída sem `id`, `channel_id` e `upload_id`; `thumbnail_url` igual ao argumento | `src/videos/dto/video-response.dto.spec.ts` |
| `VideosModule` | Unit: compilação do módulo com dependências reais de config | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.5.1 — `VideosService`, `ChannelsService.findByUserId`, política; SI-03.2 — `StorageService.createMultipartUpload`; SI-03.3 — `VideoProcessingQueueModule`, importado pelo `VideosModule`.

**Acceptance criteria:**

- `POST /videos` com `{ filename: "aula.mp4", mime_type: "video/mp4", size_bytes: 50000000 }` e token válido retorna `201` com `video.status = "uploading"`, `video.title = "aula"`, `video.thumbnail_url = null`, `upload.part_size_bytes = 16777216`, `upload.part_count = 3` e `upload.max_part_urls_per_request = 100`.
- Depois do `201`, existe no storage um multipart upload aberto para `{id}/original` com o `upload_id` persistido no rascunho.
- `POST /videos` com `mime_type: "application/pdf"` ou `size_bytes: 10737418241` retorna `400` com `error: "VALIDATION_ERROR"`.
- `POST /videos` sem token retorna `401`.
- `POST /videos` de um usuário sem canal retorna `404` com `error: "CHANNEL_NOT_FOUND"`.
- `POST /videos` executado 15 vezes em um minuto pelo mesmo IP nunca retorna `429` (rotas de vídeo fora do throttler).
- A resposta de `POST /videos` não contém as chaves `id`, `channel_id` nem `upload_id`.

---

### SI-03.6 — Endpoints de upload em andamento: URLs de partes, partes enviadas e cancelamento

**Route:** POST /videos/:publicId/upload/part-urls
**Route:** GET /videos/:publicId/upload/parts
**Route:** DELETE /videos/:publicId/upload
**Test Specs:** see `nestjs-project/specs/videos-upload-session.plan.md`
**Authorization:** Owner only — não dono recebe `404 VIDEO_NOT_FOUND` (`### Authorization Matrix`)

**Description:** Completa o ciclo de upload resumível do TD-02: o cliente pede URLs presignadas em lotes, descobre quais partes já subiram para retomar o envio e pode cancelar. O cancelamento usa a ordem anti-corrida definida em `### API Contracts → DELETE /videos/:publicId/upload`.

**Technical actions:**

1. Criar as exceções em `src/videos/exceptions/`: `InvalidUploadStateException` (`INVALID_UPLOAD_STATE`, 409) e `PartNumberOutOfRangeException` (`PART_NUMBER_OUT_OF_RANGE`, 400), conforme `### Error Catalog`.

   Adicionar em `VideosService` `deleteIfStatus(id, status)` → `boolean`, um `DELETE ... WHERE id AND status` que retorna se afetou linha.
2. Em `VideoUploadService`, implementar `presignPartUrls(userId, publicId, partNumbers)`:
   - `findOwnedByPublicId`;
   - `status ≠ 'uploading'` → `InvalidUploadStateException`;
   - algum número > `videoPartCount(size_bytes)` → `PartNumberOutOfRangeException`;
   - para cada parte, `StorageService.presignUploadPart(key, upload_id, n, VIDEO_PART_URL_TTL_SECONDS)`, assinado pelo cliente público (AMB-7);
   - retorna `{ parts, expires_at }`, preservando a ordem do request.
3. Em `VideoUploadService`, implementar `listUploadedParts(userId, publicId)`: mesmas checagens de dono e status, depois `StorageService.listParts` (paginado), mapeado para `{ part_number, size_bytes, etag }` em ordem crescente.
4. Em `VideoUploadService`, implementar `cancel(userId, publicId)` na ordem do contrato:
   - `findOwnedByPublicId`;
   - `deleteIfStatus(id, 'uploading')`; se retornar `false`, lança `InvalidUploadStateException`;
   - `abortMultipartUpload`, ignorando `StorageUploadNotFoundError`;
   - `deleteObject('videos', videoOriginalKey(id))` (AMB-4).
5. Adicionar ao `VideosController`, com DTOs em `src/videos/dto/` (`part-urls-request.dto.ts`, `part-urls-response.dto.ts`, `uploaded-parts-response.dto.ts`) e o `VideoPublicIdParamDto` em todos:
   - `@Post(':publicId/upload/part-urls')` + `@HttpCode(200)`;
   - `@Get(':publicId/upload/parts')`;
   - `@Delete(':publicId/upload')` + `@HttpCode(204)`;
   - `@ApiResponse` para cada status listado em `### API Contracts`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoUploadService` (part URLs, partes, cancel) | Unit: status ≠ `uploading` → `INVALID_UPLOAD_STATE` nos três métodos; parte `part_count + 1` → `PART_NUMBER_OUT_OF_RANGE`; ordem das URLs igual à do request; cancel com `deleteIfStatus = false` não chama o storage; `NoSuchUpload` no abort não impede o `deleteObject` | `src/videos/video-upload.service.spec.ts` |
| `VideoUploadService` × MinIO + Postgres | Integration: URLs presignadas aceitam `PUT` real (helper `requestPresigned`); `listUploadedParts` reflete as partes enviadas com o `ETag` retornado pelo `PUT`; cancel remove a linha e o upload deixa de existir no storage | `src/videos/video-upload.service.integration-spec.ts` |

**Dependencies:** SI-03.5.2 — controller, módulo, `VideoUploadService` e rascunho com `upload_id`.

**Acceptance criteria:**

- `POST /videos/:publicId/upload/part-urls` com `{ part_numbers: [2, 1] }` retorna `200` com `parts` na ordem `[2, 1]`, cada item com `url` no host de `S3_PUBLIC_ENDPOINT`, e `expires_at` cerca de 3600 s no futuro.
- Um `PUT` com os bytes da parte na `url` retornada responde `200` com `ETag`. Em seguida, `GET /videos/:publicId/upload/parts` lista essa parte com o mesmo `etag` e o `size_bytes` enviado.
- `POST /videos/:publicId/upload/part-urls` com um número maior que `part_count` retorna `400` com `error: "PART_NUMBER_OUT_OF_RANGE"`; com `part_numbers: [1, 1]` ou 101 itens retorna `400` com `error: "VALIDATION_ERROR"`.
- `DELETE /videos/:publicId/upload` retorna `204`. Depois disso, a linha não existe mais em `videos`, o multipart upload não aparece mais no storage e um novo `DELETE` no mesmo `publicId` retorna `404` com `error: "VIDEO_NOT_FOUND"`.
- As três rotas, chamadas por outro usuário autenticado, retornam `404` com `error: "VIDEO_NOT_FOUND"`; com `publicId` malformado (`"abc"`), retornam `400` com `error: "VALIDATION_ERROR"`.
- As três rotas, para um vídeo em `processing`, retornam `409` com `error: "INVALID_UPLOAD_STATE"`.

---

### SI-03.7 — Endpoint POST /videos/:publicId/upload/complete: concluir upload e enfileirar processamento

**Route:** POST /videos/:publicId/upload/complete
**Test Specs:** see `nestjs-project/specs/videos-upload-complete.plan.md`
**Authorization:** Owner only — não dono recebe `404 VIDEO_NOT_FOUND` (`### Authorization Matrix`)

**Description:** Fecha o multipart no storage e reconfere o tamanho real (AMB-3). Depois move o vídeo para `processing` e publica `process-video` (TD-03). É idempotente sob retry do cliente e seguro contra complete/cancel concorrentes, conforme `### API Contracts → POST /videos/:publicId/upload/complete → Behavior`.

**Technical actions:**

1. Criar as exceções `UploadIncompleteException` (`UPLOAD_INCOMPLETE`, 409) e `VideoFileTooLargeException` (`VIDEO_FILE_TOO_LARGE`, 422) em `src/videos/exceptions/`.

   Adicionar em `VideosService` `transitionStatus(id, from, patch)` → `boolean`: um `UPDATE ... WHERE id = :id AND status = :from`, que retorna se afetou linha. É a única forma de mudar `status` (`### Data Model → Status transitions`).
2. Em `VideoUploadService.complete(userId, publicId)`, fazer os passos 1–4 do contrato:
   - `findOwnedByPublicId`;
   - `processing` → só re-enfileira e retorna;
   - `ready`/`failed` → `InvalidUploadStateException`;
   - `listParts`; se o conjunto de números ≠ `{1..videoPartCount(size_bytes)}` → `UploadIncompleteException`;
   - `completeMultipartUpload` com as partes em ordem crescente;
   - `StorageInvalidPartsError` → `UploadIncompleteException`;
   - `StorageUploadNotFoundError` → segue só se `headObject` encontrar o objeto; senão, `UploadIncompleteException`.
3. Fazer os passos 5–6:
   - `headObject('videos', videoOriginalKey(id))`;
   - se `contentLength > VIDEO_MAX_SIZE_BYTES`: `deleteObject`, `transitionStatus(id, 'uploading', { status: 'failed', processing_error: 'FILE_TOO_LARGE', upload_id: null })` e `VideoFileTooLargeException`;
   - senão, `transitionStatus(id, 'uploading', { status: 'processing', size_bytes: contentLength, upload_id: null })`;
   - se retornar `false`, reler a linha: `processing` → passo 7; `failed` → `InvalidUploadStateException`; ausente → `deleteObject` + `VideoNotFoundException`.
4. Fazer o passo 7: `VideoProcessingQueue.enqueue(video.id)`, com o `jobId` deduplicado (`### Events/Messages`). Se o enqueue falhar depois da transição, o erro propaga (503/500) e o retry do cliente cai no ramo `processing`, que re-enfileira. Esse é o caminho de recuperação definido no contrato.
5. Adicionar `@Post(':publicId/upload/complete')` + `@HttpCode(202)` ao `VideosController`, retornando `toVideoResponse(video, null)`, com `@ApiResponse` para 202, 400, 401, 404, 409 e 422.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoUploadService.complete` | Unit (mocks de `StorageService`, `VideosService` e `VideoProcessingQueue`), cobrindo os ramos: partes faltando, `StorageInvalidPartsError`, `NoSuchUpload` com e sem objeto, tamanho acima do teto, `transitionStatus = false` com releitura `processing`/`failed`/ausente, vídeo já em `processing` (só re-enfileira) e `ready` (409) | `src/videos/video-upload.service.spec.ts` |
| `VideoUploadService.complete` × MinIO + Redis + Postgres | Integration: upload real de 2 partes → complete → objeto montado, linha em `processing` com `size_bytes` real e `upload_id = null`, um job `video-{id}` na fila (prefixo de teste); segundo complete não cria segundo job | `src/videos/video-upload.service.integration-spec.ts` |

**Dependencies:** SI-03.6 — partes enviadas via URLs presignadas; SI-03.3 — `VideoProcessingQueue.enqueue`.

**Acceptance criteria:**

- Com todas as partes enviadas, `POST /videos/:publicId/upload/complete` retorna `202` com `status: "processing"` e `size_bytes` igual ao tamanho real do objeto.
- Após o `202`, a fila `video-processing` contém exatamente um job `process-video` com `id = video-{videoId}`.
- Repetir o complete com o vídeo em `processing` retorna `202` e a fila continua com um único job para o vídeo.
- Complete com uma parte faltando retorna `409` com `error: "UPLOAD_INCOMPLETE"`, e o vídeo continua `uploading` e retomável.
- Complete de um vídeo `ready` ou `failed` retorna `409` com `error: "INVALID_UPLOAD_STATE"`.
- Complete de um objeto montado acima de 10737418240 bytes retorna `422` com `error: "VIDEO_FILE_TOO_LARGE"`, o vídeo fica `failed` com `processing_error: "FILE_TOO_LARGE"` e o objeto deixa de existir no storage.
- Complete chamado por outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`, sem efeito no storage nem na fila.

---

### SI-03.8 — MediaModule: FfmpegService (ffprobe/ffmpeg via spawn) e fixtures de vídeo

**Description:** Isola a integração com os binários do sistema (per `phase-03-videos/TD-05`) atrás de um serviço com entradas e saídas tipadas. O worker orquestra sem conhecer argumentos de linha de comando. As fixtures são geradas pelo próprio ffmpeg, então o repositório não guarda binários.

**Technical actions:**

1. Criar `src/media/media.utils.ts` com funções puras:
   - `parseProbeOutput(json)` → `MediaProbeResult { durationSeconds: number | null; formatName: string; video: { width; height; codec } | null; audioCodec: string | null }`, usando o primeiro stream `codec_type = 'video'` e o primeiro `audio` (campos AMB-2);
   - `thumbnailTimestamp(durationSeconds)` → `durationSeconds >= 2 ? durationSeconds * 0.1 : 0` (TD-05; `null` → `0`).
2. Criar `src/media/ffmpeg.service.ts` com `probe(input)`:
   - `spawn('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', input])`, com `shell: false` (o input é um argumento, nunca interpolado em shell);
   - timeout de 60 s com `SIGKILL`;
   - exit ≠ 0 ou JSON inválido → `MediaNotReadableError`;
   - sucesso → `parseProbeOutput`.
3. Em `FfmpegService`, adicionar `extractFrame(input, atSeconds)`:
   - `spawn('ffmpeg', ['-v', 'error', '-ss', String(atSeconds), '-i', input, '-frames:v', '1', '-vf', "scale='min(640,iw)':-2", '-q:v', '3', '-f', 'image2', 'pipe:1'])`;
   - acumula `stdout` em `Buffer`, com teto de 10 MiB;
   - timeout de 120 s;
   - exit ≠ 0, saída vazia ou estouro do teto → `MediaFrameExtractionError`.

   Os erros ficam em `src/media/media.errors.ts`. `stderr` é anexado à mensagem (truncado em 2 KB) para diagnóstico em log.
4. Criar `src/media/media.module.ts`, que exporta `FfmpegService`.
5. Criar `src/test/video-fixtures.ts`: `getVideoFixture(kind)` gera uma vez por execução, em `os.tmpdir()`, via `ffmpeg -f lavfi`:
   - `mp4-with-audio`: `testsrc` 320x240, 3 s, + `sine`, H.264/AAC;
   - `mp4-video-only`: sem áudio;
   - `mp4-short`: 1 s, para o caminho do primeiro frame;
   - `audio-only`: `.m4a`, sem stream de vídeo;
   - `not-media`: bytes aleatórios.

   Os testes rodam no contêiner `nestjs-api`, que tem ffmpeg pelo `Dockerfile.dev` do SI-03.1.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `parseProbeOutput` / `thumbnailTimestamp` | Unit: JSON com vídeo + áudio, só vídeo, só áudio (`video = null`) e sem `format.duration` (`null`); timestamp para 30 s (= 3), 1.5 s (= 0) e `null` (= 0) | `src/media/media.utils.spec.ts` |
| `FfmpegService` × binários reais | Integration: `probe` das fixtures retorna dimensões 320x240, codecs `h264`/`aac` e duração ≈ 3 s; `audio-only` → `video = null`; `not-media` → `MediaNotReadableError`; `extractFrame` produz um JPEG (magic bytes `FF D8 FF`) com largura 320, sem upscale |  `src/media/ffmpeg.service.integration-spec.ts` |

**Dependencies:** SI-03.1 — ffmpeg/ffprobe instalados na imagem.

**Acceptance criteria:**

- `probe` de um MP4 H.264/AAC 320x240 de 3 s retorna `video = { width: 320, height: 240, codec: 'h264' }`, `audioCodec = 'aac'` e `durationSeconds` entre 2.9 e 3.1.
- `probe` de um arquivo só de áudio retorna `video = null`.
- `probe` de bytes que não são mídia lança `MediaNotReadableError`.
- `extractFrame` de um vídeo 320x240 retorna um JPEG não vazio com 320 px de largura; a largura é limitada a 640 px e vídeos menores não são ampliados.
- Um nome de arquivo com `; rm -rf /` passado como input não executa comando algum (o `spawn` é chamado sem shell).

---

### SI-03.9.1 — Infra: runtime do worker (entrypoint, WorkerModule e módulos raiz compartilhados) (auto-split from SI-03.9 by /plan-build)

_Auto-split rationale: original SI would have 8 Technical actions; split per "infrastructure vs behavior"._

**Description:** Cria o segundo processo da aplicação, sem HTTP, a partir do mesmo código (per `phase-03-videos/TD-04`). Para isso, a configuração raiz e a conexão de banco saem do `AppModule` e passam a ser compartilhadas com o `WorkerModule`, sem duplicar a fiação. Essa extração é parte necessária do escopo, não uma refatoração cosmética.

**Technical actions:**

1. Extrair de `src/app.module.ts`:
   - `src/config/root-config.module.ts`: `ConfigModule.forRoot` com `isGlobal`, todos os namespaces (incluindo `storage`/`queue` do SI-03.1), `validationSchema` e `validationOptions` atuais;
   - `src/database/database.module.ts`: o `TypeOrmModule.forRootAsync` atual, sem mudança de opções (`autoLoadEntities: true`, `synchronize: false`).

   `AppModule` passa a importar `RootConfigModule`, `DatabaseModule` e `QueueModule`, e o comportamento da API não muda.
2. Criar `src/worker.module.ts`, que importa `RootConfigModule`, `DatabaseModule` e `QueueModule`. O `VideoProcessingWorkerModule` entra no SI-03.9.2. Sem controllers.
3. Criar `src/worker.ts`:
   - `NestFactory.createApplicationContext(WorkerModule)` + `app.enableShutdownHooks()`, para que `SIGTERM` feche o worker BullMQ e a conexão de banco sem perder jobs em andamento (library-refs BullMQ: graceful close);
   - loga `Video worker started` com o nome da fila.

   O processo não abre porta HTTP.
4. Adicionar a `package.json`:
   - `"start:worker": "ts-node -r tsconfig-paths/register src/worker.ts"`. `nest start --watch` não é usado no worker porque o `deleteOutDir` do `nest-cli.json` apagaria o `dist` da API em paralelo;
   - `"start:worker:prod": "node dist/worker"`.

   Documentar em `nestjs-project/CLAUDE.md`: `docker compose exec video-worker npm run start:worker`, e reiniciar o worker após mudanças de código.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Unit: compilação com `RootConfigModule`, `DatabaseModule` e `QueueModule` reais; o contexto não registra controllers | `src/worker.module.spec.ts` |
| `RootConfigModule` / `DatabaseModule` | Unit: compilação isolada de cada módulo raiz (regressão da extração) | `src/database/database.module.spec.ts` |

**Dependencies:** SI-03.3 — `QueueModule`; SI-03.4 — entidade `Video` carregada por `autoLoadEntities`.

**Acceptance criteria:**

- `docker compose exec video-worker npm run start:worker` loga `Video worker started` e mantém o processo vivo, sem escutar porta TCP.
- Um `SIGTERM` ao processo do worker o encerra com exit code 0 em menos de 10 s.
- `npm run build` gera `dist/worker.js`, e `node dist/worker` inicia da mesma forma.
- A suíte e2e existente da Fase 02 (`test/auth.e2e-spec.ts`) passa sem alteração após a extração dos módulos raiz.

---

### SI-03.9.2 — Pipeline de processamento: consumidor process-video, metadados, thumbnail e falhas (auto-split from SI-03.9 by /plan-build)

_Auto-split rationale: original SI would have 8 Technical actions; split per "infrastructure vs behavior"._

**Description:** Implementa o consumidor do contrato `process-video` (`### Events/Messages`): extrai os metadados (AMB-2), gera e grava o thumbnail (TD-05) e move o vídeo para `ready` ou `failed`, com a política de retry do TD-09. Todo o processamento é idempotente, porque a entrega é at-least-once.

**Technical actions:**

1. Adicionar a `VideosService`:
   - `findById(id)`;
   - `markReady(id, metadata)` = `transitionStatus(id, 'processing', { status: 'ready', duration_seconds, width, height, video_codec, audio_codec, container_format, processing_error: null })`;
   - `markFailed(id, code)` = `transitionStatus(id, 'processing', { status: 'failed', processing_error: code })`.

   Os dois retornam `boolean`, e `false` é no-op idempotente (`### Events/Messages → Delivery semantics`).
2. Criar `src/video-processing/video-processing.errors.ts` com `VideoProcessingTerminalError(code: VideoProcessingErrorCode)`.

   Criar `src/video-processing/video-processing.service.ts`, com `process(videoId)` executando os passos 1–8 da tabela `### Events/Messages → Processing steps`:
   - `headObject` ausente → terminal `SOURCE_OBJECT_MISSING`;
   - `presignGetObject('videos', key, { client: 'internal', expiresIn: 3600 })` → `FfmpegService.probe`;
   - `MediaNotReadableError` ou `video = null` → terminal `NO_VIDEO_STREAM` (AMB-5);
   - `extractFrame(url, thumbnailTimestamp(duration))`;
   - `putObject('thumbnails', videoThumbnailKey(id), jpeg, 'image/jpeg')`;
   - `markReady`.
3. Criar `src/video-processing/video-processing.retry.ts` com a função pura `isFinalAttempt(job)` = `job.attemptsMade + 1 >= (job.opts.attempts ?? 1)`.

   Criar `src/video-processing/video-processing.processor.ts`: `@Processor(VIDEO_PROCESSING_QUEUE)`, estende `WorkerHost`, e em `process(job: Job<ProcessVideoJobData>)` aplica o `### Events/Messages → Failure handling`:
   - erro terminal → `markFailed(code)` + `throw new UnrecoverableError(code)`;
   - transitório na última tentativa → `markFailed('PROCESSING_FAILED')` + relança;
   - transitório antes da última → só relança.

   Um job com `name ≠ PROCESS_VIDEO_JOB` lança `UnrecoverableError` sem tocar o banco.
4. Criar `src/video-processing/video-processing-worker.module.ts`, com:
   - imports: `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`, `VideosCoreModule`, `StorageModule`, `MediaModule`;
   - providers: `VideoProcessingService`, `VideoProcessingProcessor`.

   Importá-lo **somente** em `WorkerModule`, nunca em `AppModule` (per `phase-03-videos/TD-04`).
5. Registrar o caminho de log por job: início, sucesso (duração do processamento) e falha (código + `attemptsMade`), sempre com `videoId`, nunca com URL presignada (a URL carrega a assinatura).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingService` | Unit (mocks de `StorageService`, `FfmpegService` e `VideosService`): vídeo ausente ou fora de `processing` → no-op sem chamar storage; objeto ausente → `SOURCE_OBJECT_MISSING`; `MediaNotReadableError` e `video = null` → `NO_VIDEO_STREAM`; falha de `extractFrame`/`putObject` propaga como transitória; `putObject` acontece antes de `markReady` | `src/video-processing/video-processing.service.spec.ts` |
| `VideoProcessingProcessor` / `isFinalAttempt` | Unit: terminal → `markFailed` + `UnrecoverableError`; transitório na tentativa 1 de 3 → relança sem `markFailed`; na 3 de 3 → `markFailed('PROCESSING_FAILED')` + relança; nome de job desconhecido → `UnrecoverableError` | `src/video-processing/video-processing.processor.spec.ts` |
| `VideoProcessingService` × MinIO + Postgres + ffmpeg | Integration: fixture `mp4-with-audio` enviada ao MinIO → `ready` com metadados e `thumbnails/{id}/thumbnail.jpg` existente; `mp4-video-only` → `audio_codec = null`; `mp4-short` → thumbnail do primeiro frame; `audio-only` e `not-media` → erro terminal `NO_VIDEO_STREAM`; segunda execução sobre vídeo `ready` é no-op | `src/video-processing/video-processing.service.integration-spec.ts` |
| Processor × Redis (retry real) | Integration: worker BullMQ real com prefixo de teste; job de vídeo cuja fonte falha de forma transitória termina `failed` após 3 tentativas com `processing_error = 'PROCESSING_FAILED'`; job terminal termina após 1 tentativa | `src/video-processing/video-processing.processor.integration-spec.ts` |
| `VideoProcessingWorkerModule` | Unit: compilação do módulo; `AppModule` não contém `VideoProcessingProcessor` | `src/video-processing/video-processing-worker.module.spec.ts` |

**Dependencies:** SI-03.9.1 — `WorkerModule`; SI-03.8 — `FfmpegService` e fixtures; SI-03.7 — vídeos chegam em `processing` com job enfileirado.

**Acceptance criteria:**

- Com o worker rodando, um MP4 válido enviado e completado chega a `status = 'ready'`, com `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec` e `container_format` preenchidos e `processing_error = null`.
- Para todo vídeo `ready`, o objeto `{id}/thumbnail.jpg` existe no bucket de thumbnails com `Content-Type: image/jpeg`.
- Um upload de arquivo só de áudio ou que não é mídia termina `failed` com `processing_error = 'NO_VIDEO_STREAM'` após uma única tentativa.
- Um vídeo cujo objeto original foi removido antes do processamento termina `failed` com `processing_error = 'SOURCE_OBJECT_MISSING'` após uma única tentativa.
- Uma falha transitória persistente termina em `failed` com `processing_error = 'PROCESSING_FAILED'` depois de exatamente 3 tentativas.
- Reprocessar o mesmo job de um vídeo `ready` não altera a linha nem o thumbnail.
- Com só a API rodando (sem `video-worker`), um vídeo completado permanece `processing` e seu job permanece `waiting` na fila.

---

### SI-03.10 — Endpoint GET /videos/:publicId: leitura do dono com status, metadados e thumbnail

**Route:** GET /videos/:publicId
**Test Specs:** see `nestjs-project/specs/videos-get.plan.md`
**Authorization:** Owner only — não dono recebe `404 VIDEO_NOT_FOUND` (`### Authorization Matrix`)

**Description:** Dá ao dono a visão do vídeo durante e depois do processamento: status para polling, metadados persistidos (AMB-2) e o thumbnail como URL presignada de curta duração (AMB-8). É o ponto onde o resultado do worker se torna observável pela API.

**Technical actions:**

1. Criar `src/videos/video-playback.service.ts`. É responsável por toda entrega de mídia ao cliente; o SI-03.11 estende o mesmo serviço. Implementar `getOwnedVideo(userId, publicId)`:
   - `findOwnedByPublicId`;
   - se `status = 'ready'`: `thumbnail_url = presignGetObject('thumbnails', videoThumbnailKey(id), { client: 'public', expiresIn: VIDEO_THUMBNAIL_URL_TTL_SECONDS, responseContentType: 'image/jpeg' })`;
   - senão, `null`;
   - retorna `toVideoResponse(video, thumbnailUrl)`.

   Adicionar `VIDEO_THUMBNAIL_URL_TTL_SECONDS = 900` a `videos.constants.ts` (per `phase-03-videos/TD-10`, AMB-8).
2. Adicionar ao `VideosController` o `@Get(':publicId')`, com `VideoPublicIdParamDto` e `@ApiResponse` para 200, 400, 401 e 404. Registrar `VideoPlaybackService` nos providers do `VideosModule`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoPlaybackService.getOwnedVideo` | Unit (mocks de `VideosService` e `StorageService`): `ready` → `thumbnail_url` presignada com cliente público, TTL 900 e `image/jpeg`; `uploading`/`processing`/`failed` → `thumbnail_url = null`, sem chamar o storage | `src/videos/video-playback.service.spec.ts` |

**Dependencies:** SI-03.9.2 — vídeos `ready` com thumbnail gravado (DG-1: entrega depois do worker); SI-03.5.2 — controller e `toVideoResponse`.

**Acceptance criteria:**

- `GET /videos/:publicId` de um vídeo `ready` retorna `200` com os metadados preenchidos e `thumbnail_url` no host de `S3_PUBLIC_ENDPOINT`. Um `GET` nessa URL retorna `200` com `Content-Type: image/jpeg`.
- `GET /videos/:publicId` de um vídeo `processing` retorna `200` com `status: "processing"` e `thumbnail_url: null`.
- `GET /videos/:publicId` de um vídeo `failed` retorna `200` com `status: "failed"`, `processing_error` preenchido e `thumbnail_url: null`.
- `GET /videos/:publicId` por outro usuário, ou com `publicId` inexistente, retorna `404` com `error: "VIDEO_NOT_FOUND"`, com corpo idêntico nos dois casos.
- `GET /videos/:publicId` sem token retorna `401`.

---

### SI-03.11 — Endpoints GET /videos/:publicId/stream e /download: URLs presignadas de reprodução e download

**Route:** GET /videos/:publicId/stream
**Route:** GET /videos/:publicId/download
**Test Specs:** see `nestjs-project/specs/videos-playback.plan.md`
**Authorization:** Owner only — não dono recebe `404 VIDEO_NOT_FOUND`. Vídeo não `ready` recebe `409 VIDEO_NOT_READY` (`### Authorization Matrix`).

**Description:** Fecha a capacidade de reprodução da fase. O dono recebe URLs presignadas e o navegador busca os bytes direto do storage: streaming com HTTP Range e download com `Content-Disposition: attachment` (TD-07). A API nunca trafega o conteúdo do vídeo.

**Technical actions:**

1. Criar `VideoNotReadyException` (`VIDEO_NOT_READY`, 409) em `src/videos/exceptions/`.
2. Criar `src/videos/content-disposition.ts` com a função pura `buildAttachmentDisposition(filename)`, que retorna `attachment; filename="{safe}"; filename*=UTF-8''{encoded}` conforme `#### GET /videos/:publicId/download`:
   - `{safe}` troca por `_` todo caractere fora de `[A-Za-z0-9._ -]`;
   - `{encoded}` é `encodeURIComponent` com `'()*` também percent-encoded.
3. Estender `VideoPlaybackService`:
   - `getStreamUrl(userId, publicId)` e `getDownloadUrl(userId, publicId)` chamam `findOwnedByPublicId` e lançam `VideoNotReadyException` se `status ≠ 'ready'`;
   - presignam `GetObject` de `videoOriginalKey(id)` com o cliente **público**:
     - stream: `responseContentType: mime_type`, TTL `VIDEO_STREAM_URL_TTL_SECONDS = 21600`;
     - download: `responseContentDisposition: buildAttachmentDisposition(original_filename)`, TTL `VIDEO_DOWNLOAD_URL_TTL_SECONDS = 900`;
   - `expires_at = now + TTL`.

   As constantes ficam em `videos.constants.ts` (per `phase-03-videos/TD-07`).
4. Adicionar `PresignedUrlResponseDto` (`url`, `expires_at`). Adicionar ao `VideosController` os `@Get(':publicId/stream')` e `@Get(':publicId/download')`, com `@ApiResponse` para 200, 400, 401, 404 e 409.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `buildAttachmentDisposition` | Unit: nome ASCII simples; acentos/emoji (`{safe}` com `_`, `{encoded}` em UTF-8); `'`, `(`, `)`, `*`, `"`, `;`, `\` e quebra de linha nunca aparecem literais em nenhum dos dois parâmetros | `src/videos/content-disposition.spec.ts` |
| `VideoPlaybackService.getStreamUrl` / `getDownloadUrl` | Unit (mocks de `VideosService` e `StorageService`): `ready` → presign com cliente público, TTL e parâmetro de resposta corretos, `expires_at` coerente com o TTL; `uploading`/`processing`/`failed` → `VideoNotReadyException`, sem chamar o storage | `src/videos/video-playback.service.spec.ts` |

**Dependencies:** SI-03.10 — `VideoPlaybackService` e o padrão de presign de leitura.

**Acceptance criteria:**

- `GET /videos/:publicId/stream` de um vídeo `ready` retorna `200` com `url` no host de `S3_PUBLIC_ENDPOINT` e `expires_at` cerca de 6 h no futuro. Um `GET` nessa URL com `Range: bytes=0-1023` retorna `206`, com `Content-Range: bytes 0-1023/{size_bytes}` e `Content-Type` igual ao `mime_type` do vídeo.
- `GET /videos/:publicId/download` de um vídeo `ready` retorna `200` com `expires_at` cerca de 15 min no futuro. Um `GET` nessa URL retorna `200`, com `Content-Disposition` começando por `attachment;` e o corpo byte a byte igual ao arquivo enviado.
- Para um vídeo com `original_filename` não ASCII (ex.: `aula 1 — introdução.mp4`), o `Content-Disposition` do download contém `filename*=UTF-8''` e o nome decodifica de volta ao original.
- `GET /videos/:publicId/stream` ou `/download` de um vídeo `processing` ou `failed` retorna `409` com `error: "VIDEO_NOT_READY"`.
- `GET /videos/:publicId/stream` ou `/download` por outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`. Sem token, retorna `401`.

---

### SI-03.12 — Fluxo ponta a ponta: upload direto → processamento → reprodução, e contrato OpenAPI

**Description:** Prova a fase inteira num único fluxo real, com API, MinIO, Redis, Postgres e worker de verdade, inclusive que os bytes do vídeo nunca passam pela API (AMB-3). Os SIs anteriores provam cada peça isolada. Aqui o objetivo é provar a costura entre elas: a fila conecta API e worker, o worker grava o que o endpoint de leitura expõe, e as URLs presignadas funcionam a partir do host público. Também atualiza os artefatos de contrato da API.

**Technical actions:**

1. Criar `test/videos.e2e-spec.ts`. O `beforeAll` define `QUEUE_PREFIX = test-{uuid}` antes de compilar qualquer módulo, para que o `video-worker` do compose não consuma os jobs do teste. Em seguida sobe dois contextos no mesmo processo:
   - `AppModule`, com os pipes e filtros globais de `main.ts` reproduzidos;
   - um `NestFactory.createApplicationContext(WorkerModule)` real.

   O worker consome de verdade, sem chamar o processor à mão: o teste exercita o wiring fila → consumidor.
2. Medir os bytes recebidos pela API com um listener `'request'` no `app.getHttpServer()`, somando o `content-length` de cada requisição. O upload das partes usa `requestPresigned` (SI-03.2) direto contra o storage. A espera pelo `ready` é um polling de `GET /videos/:publicId` com timeout explícito de 30 s, sem `sleep` fixo.
3. Limpeza:
   - `afterEach`: `cleanAllTables` e `emptyBucket` dos dois buckets;
   - `afterAll`: `queue.obliterate({ force: true })` do prefixo de teste, depois fechar os dois contextos (worker antes da API).
4. Regenerar `openapi.json` com `npm run openapi:export`, que passa a incluir as 8 rotas de `### API Contracts`. Adicionar a `api.http` as requisições do fluxo (initiate, part-urls, parts, complete, GET, stream, download, cancel), com variáveis para `publicId` e o token.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Fluxo upload → processamento → reprodução | E2E (todos os serviços reais): fixture `mp4-with-audio` (SI-03.8) enviada em 1 parte → `202` → `ready` com `duration_seconds ≈ 3`, `width = 320`, `height = 240`, `video_codec = "h264"`, `audio_codec = "aac"` e `thumbnail_url` acessível → stream com `Range` → `206` → download com `Content-Disposition` e corpo idêntico; bytes recebidos pela API < 10% de `size_bytes` | `test/videos.e2e-spec.ts` |
| Fluxo de falha de processamento | E2E: fixture `not-media` declarada como `video/mp4` → `failed` com `processing_error = "NO_VIDEO_STREAM"`, sem thumbnail no bucket; stream → `409 VIDEO_NOT_READY` | `test/videos.e2e-spec.ts` |
| Fluxo sem áudio | E2E: fixture `mp4-video-only` → `ready` com `audio_codec = null` | `test/videos.e2e-spec.ts` |
| Fluxo de cancelamento | E2E: initiate → `PUT` de uma parte → `DELETE /videos/:publicId/upload` → `204`; `GET /videos/:publicId` → `404`; nenhum objeto nem upload pendente no bucket de vídeos | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.11 — último endpoint do fluxo; transitivamente, todos os SIs anteriores.

**Acceptance criteria:**

- Um job `process-video` publicado com um `QUEUE_PREFIX` diferente do usado pelo `video-worker` do compose permanece intocado por esse worker.
- No fluxo feliz, a soma dos `content-length` recebidos pela API é menor que 10% do `size_bytes` do vídeo.
- Ao fim do fluxo feliz, `GET /videos/:publicId` retorna `ready` com todos os campos de metadado preenchidos (AMB-2), e o objeto `{id}/thumbnail.jpg` existe no bucket de thumbnails.
- Com a fixture `not-media`, o vídeo termina `failed` com `processing_error = "NO_VIDEO_STREAM"` dentro do timeout, sem ficar preso em `processing`.
- `openapi.json` contém as 8 rotas de vídeos, com os schemas `VideoResponseDto` e `PresignedUrlResponseDto`. Rodar `npm run openapi:export` de novo não gera diff.
- `api.http` tem uma requisição para cada uma das 8 rotas de vídeos.

---

### SI-03.13 — Verificação do limite de 10 GiB com um vídeo real

**Description:** Prova o limite de AMB-3 com um arquivo real de 10 GiB, em vez de só com mocks: exatamente 10737418240 bytes é aceito, processado e reproduzido, e 1 byte a mais é rejeitado no complete. Também confirma, em escala real, o que os testes pequenos não alcançam:
- a conversão de `bigint` em `size_bytes`;
- 640 partes num único multipart;
- ffprobe e ffmpeg dentro dos timeouts de 60 s e 120 s (SI-03.8) lendo via HTTP Range um objeto de 10 GiB;
- a API recebendo só JSON enquanto 10 GiB trafegam direto para o storage.

É uma suíte separada e opt-in, pelo custo de cerca de 10 GiB de upload e até cerca de 30 GB de disco transitório no storage. Não roda no `npm test` nem no `test:e2e`, mas é item obrigatório dos Deliverables.

**Technical actions:**

1. Criar `scripts/generate-large-video-fixture.sh`, que gera `.large-fixtures/video-10gib.mp4` (caminho relativo a `nestjs-project/`, visível no contêiner pelo bind mount):
   - `ffmpeg` com vídeo `rawvideo` `yuv420p` 1920x1080 a 30 fps lido de `/dev/urandom`, codificado em `libx264 -preset ultrafast -qp 1`. Ruído praticamente não comprime, o que garante o volume. `-qp 1` com `ultrafast` gera perfil Constrained Baseline 4:2:0, que navegador decodifica. `-qp 0` forçaria High 4:4:4 Predictive. Resultado medido: cerca de 67 s de vídeo, gerados em cerca de 25 s. O áudio é `sine` 48 kHz em `aac`. A saída é limitada por `-fs` a 10 GiB − 64 MiB;
   - completa o arquivo até **exatamente** 10737418240 bytes com um átomo `free` de nível superior (header de 8 bytes `size`+`'free'` e zeros), o que mantém o MP4 válido;
   - valida com `ffprobe` (stream `h264` 1920x1080 e stream `aac`) e com o tamanho exato;
   - é idempotente: não regenera se o arquivo existir com o tamanho certo.

   Adicionar `/.large-fixtures` ao `.gitignore` e o script `fixtures:large` ao `package.json`.
2. Extrair o bootstrap do SI-03.12 para `test/support/videos-test-app.ts`: `AppModule` com a config de `main.ts`, `WorkerModule`, `QUEUE_PREFIX` de teste, contador de bytes da API e teardown. `test/videos.e2e-spec.ts` passa a usá-lo, sem mudar comportamento.
3. Criar `test/jest-large.json` (`testRegex: "\\.large-spec\\.ts$"`, `testTimeout: 3600000`) e o script `test:large`. O sufixo `.large-spec.ts` não casa com os regexes de `npm test` (`spec|integration-spec` em `src/`) nem com o de `test:e2e` (`.e2e-spec.ts`).
4. Criar `test/videos-10gib.large-spec.ts`:
   - se a fixture não existir ou não tiver 10737418240 bytes, **falha** com mensagem apontando para `npm run fixtures:large`. Um `skip` deixaria a suíte verde sem testar nada;
   - as partes são lidas do disco por `fs.createReadStream({ start, end })` e enviadas com concorrência 4, sem nunca carregar o arquivo em memória. As URLs são pedidas em lotes de `max_part_urls_per_request` (100);
   - cada cenário roda `emptyBucket` ao terminar, para liberar cerca de 10 GiB antes do próximo.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Limite exato (10737418240 bytes) | E2E com todos os serviços reais: initiate com `size_bytes` 10737418240 → `part_count = 640` → 640 `PUT`s → complete `202` com `size_bytes = 10737418240` → `ready` com 1920x1080, `h264`, `aac` e thumbnail → stream com `Range` nos últimos 1024 bytes → `206` com `Content-Range: bytes 10737417216-10737418239/10737418240` | `test/videos-10gib.large-spec.ts` |
| Acima do limite (10737418241 bytes) | E2E: initiate declarando 10737418240 → a parte 640 enviada com 1 byte extra → complete `422 VIDEO_FILE_TOO_LARGE` → `failed` com `processing_error = "FILE_TOO_LARGE"`, objeto ausente no storage, nenhum job na fila | `test/videos-10gib.large-spec.ts` |
| Bytes recebidos pela API nos dois cenários | E2E: soma dos `content-length` recebidos pela API < 1 MiB, contra 10 GiB enviados ao storage | `test/videos-10gib.large-spec.ts` |

**Dependencies:** SI-03.12 — bootstrap do fluxo ponta a ponta, extraído aqui para reuso.

**Acceptance criteria:**

- `npm run fixtures:large` produz `.large-fixtures/video-10gib.mp4` com exatamente 10737418240 bytes, que o `ffprobe` lê como MP4 com um stream `h264` 1920x1080 e um `aac`. Rodar de novo não regenera o arquivo.
- `git status` não lista `.large-fixtures/` depois de gerar a fixture.
- Um upload real de 10737418240 bytes em 640 partes termina `ready`, com `size_bytes = 10737418240` no `GET /videos/:publicId`, metadados preenchidos e `thumbnail_url` acessível.
- Para o vídeo de 10 GiB `ready`, um `GET` na URL de stream com `Range: bytes=-1024` retorna `206` com `Content-Range: bytes 10737417216-10737418239/10737418240`.
- Um upload cujo objeto montado tem 10737418241 bytes é rejeitado no complete com `422` e `error: "VIDEO_FILE_TOO_LARGE"`. O vídeo fica `failed` com `processing_error: "FILE_TOO_LARGE"` e o objeto deixa de existir no storage.
- Durante o upload de 10 GiB, a API recebe menos de 1 MiB de corpo de requisição no total.

---

## Technical Specifications

### Data Model

#### Video

Table `videos` (new — SI-03.4). Ownership rule: AMB-6. Status lifecycle: `phase-03-videos/TD-08`. Public identifier: `phase-03-videos/TD-06`. Persisted metadata set: AMB-2.

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated (`@PrimaryGeneratedColumn('uuid')`) — internal id; used for object keys (TD-11) and the queue payload. Never used in URLs. |
| public_id | varchar(11) | unique, not null — `randomBytes(8).toString('base64url')` (always 11 chars, alphabet `[A-Za-z0-9_-]`). Generated in the service with a unique-violation retry (max 5 retries) (TD-06). |
| channel_id | uuid | not null, FK → `channels.id` (`ON DELETE NO ACTION`, same as the existing FKs) (AMB-6) |
| title | varchar(100) | not null — the `title` from initiate if given, otherwise `original_filename` without its last extension, trimmed and cut to 100 chars. Becomes `'Untitled'` if the result is empty (AMB-1). |
| description | text | nullable, always `null` in Fase 03 (AMB-1) |
| status | enum `videos_status_enum` (`uploading`, `processing`, `ready`, `failed`) | not null, default `'uploading'` (TD-08) |
| original_filename | varchar(255) | not null — the client-declared filename, used for the default title and the download `Content-Disposition` |
| mime_type | varchar(100) | not null — the declared type, one of the AMB-5 allowlist values |
| size_bytes | bigint | not null — the declared size at initiate, overwritten by the real `HeadObject.ContentLength` at complete (AMB-3). Uses a `{ to: v => v, from: v => v === null ? null : Number(v) }` transformer so the entity exposes `number` (values ≤ 10 GiB are safe integers). |
| upload_id | varchar(1024) | nullable — the S3 multipart `UploadId`. Set at initiate. Set to `null` once complete succeeds, and never read again after that. |
| original_key | varchar(255) | not null — storage key of the original in `storage.videosBucket`, `videoOriginalKey(id)` = `{id}/original`. Set on creation (the service generates the uuid before the insert) and never changed (TD-11; added by `AddVideoStorageKeys`). |
| thumbnail_key | varchar(255) | nullable — storage key of the thumbnail in `storage.thumbnailsBucket`, `videoThumbnailKey(id)` = `{id}/thumbnail.jpg`. Set by the `processing → ready` transition, `null` in every other status (TD-11; added by `AddVideoStorageKeys`). |
| duration_seconds | double precision | nullable — ffprobe `format.duration` (AMB-2) |
| width | integer | nullable — first video stream `width` (AMB-2) |
| height | integer | nullable — first video stream `height` (AMB-2) |
| video_codec | varchar(50) | nullable — first video stream `codec_name` (AMB-2) |
| audio_codec | varchar(50) | nullable — first audio stream `codec_name`; stays `null` when the file has no audio stream (AMB-2) |
| container_format | varchar(100) | nullable — ffprobe `format.format_name` (e.g. `mov,mp4,m4a,3gp,3g2,mj2`) (AMB-2) |
| processing_error | varchar(64) | nullable — a worker failure code from the Events/Messages → Failure codes table. Set only when `status = 'failed'`, cleared (`null`) when `status = 'ready'` (TD-09). |
| created_at | timestamp | `@CreateDateColumn()`, default `now()` |
| updated_at | timestamp | `@UpdateDateColumn()`, default `now()` |

**Relations:** `Video` many-to-one `Channel` (`@ManyToOne(() => Channel, (channel) => channel.videos)` + `@JoinColumn({ name: 'channel_id' })`). `Channel` gets the inverse `@OneToMany(() => Video, (video) => video.channel) videos: Video[]` with no schema change (entity rule: always define both sides).
**Indexes:** unique on `public_id`; non-unique on `channel_id` (owner lookups now, channel listing in Fase 04).
**Storage keys (TD-11):**
- the original object is in bucket `storage.videosBucket`, key `original_key` (`{id}/original`);
- the thumbnail is in bucket `storage.thumbnailsBucket`, key `thumbnail_key` (`{id}/thumbnail.jpg`).

Both keys are built only by the pure helpers in `src/videos/video-object-keys.ts` (`videoOriginalKey(id)`, `videoThumbnailKey(id)`) and persisted on the row; readers (upload, worker, playback) use the persisted columns. Invariant: `status = 'ready'` ⇔ `thumbnail_key` is not null, and the thumbnail object exists (the worker writes it before it flips the status).
**Status transitions (only these are legal):**
- `uploading → processing` (complete, SI-03.7);
- `uploading → failed` (complete detects an object over the cap, SI-03.7);
- `processing → ready` (worker success, SI-03.9.2);
- `processing → failed` (worker terminal failure or retries exhausted, SI-03.9.2).

A cancelled draft (`uploading`) is **deleted**, not transitioned (AMB-4).

**Migration:** `CreateVideos{timestamp}` is generated with `npm run migration:generate` (rule: CLI-generated). It creates `videos_status_enum`, the `videos` table, both indexes and the FK. `down()` drops them in reverse order. No existing migration is edited (DG-2, Immutability rule). The storage-key columns came later in `AddVideoStorageKeys1791382169844` (CLI-generated; the spurious enum re-creation the CLI emitted was dropped, and a hand-written backfill fills the keys of existing rows before `original_key` becomes `NOT NULL`). `down()` drops both columns.

#### Channel (modified — relation only)

No column changes. It gains only the inverse `videos: Video[]` relation described above (SI-03.4).

### API Contracts

**Common conventions:**
- Every endpoint below is authenticated: none carries `@Public()`, the global `JwtAuthGuard` applies, and each uses `@ApiBearerAuth('access-token')`. Every endpoint is owner-only (TD-10, Authorization Matrix).
- `VideosController` is `@Controller('videos')` + `@ApiTags('videos')` + class-level `@SkipThrottle()`. The `ThrottlerGuard` is registered as `APP_GUARD` and is therefore global (the same pattern as `AppController`); `phase-02-auth/TD-08` scopes rate limiting to auth only.
- Wire format is snake_case (inherited: `access_token`, `refresh_token`). Errors use the inherited envelope `{ statusCode, error, message }` (`phase-02-auth/TD-07`), documented via `getSchemaPath(ApiErrorEnvelope)`.
- `:publicId` is validated by a param DTO `VideoPublicIdParamDto` (`@Matches(/^[A-Za-z0-9_-]{11}$/)`). A malformed value → 400 `VALIDATION_ERROR`.
- No endpoint accepts or returns video bytes (AMB-3). Bodies are JSON only, under Express's default 100 kB JSON limit, which stays unchanged.
- The cross-phase contract (ICC-1) has two parts:
  - the frontend BFF relays these JSON responses;
  - the browser `PUT`s parts and `GET`s media **directly** against the presigned storage URLs, and must never proxy bytes through the BFF.

**Shared response schema `VideoResponse`** (`src/videos/dto/video-response.dto.ts`, built by a pure mapper `toVideoResponse(video, thumbnailUrl)`):
- public_id: string — 11 chars (TD-06)
- title: string
- description: string | null
- status: `'uploading' | 'processing' | 'ready' | 'failed'` (TD-08)
- original_filename: string
- mime_type: string
- size_bytes: number
- duration_seconds: number | null
- width: number | null
- height: number | null
- video_codec: string | null
- audio_codec: string | null
- container_format: string | null
- processing_error: string | null
- thumbnail_url: string | null — a presigned GET with a 900 s TTL, signed by the **public** client. Non-null only when `status = 'ready'` (AMB-8). Endpoints other than `GET /videos/:publicId` return `null`.
- created_at: string (ISO-8601)
- updated_at: string (ISO-8601)

The internal `id`, `channel_id` and `upload_id` are **never** serialized.

---

#### POST /videos (SI-03.5.2)

Initiate the upload and pre-register a draft (TD-02, TD-03, AMB-1, AMB-3, AMB-5).

**Request headers:**
- Authorization: Bearer {access_token}
- Content-Type: application/json

**Request body:**
- filename: string, required — 1..255 chars after trim
- mime_type: string, required — one of `video/mp4`, `video/quicktime`, `video/webm`, `video/x-matroska` (AMB-5)
- size_bytes: integer, required — 1..10737418240 (10 × 1024³, AMB-3)
- title: string, optional — 1..100 chars after trim. When omitted, the AMB-1 default applies (see Data Model `title`).

**Behavior (in order):**
1. Resolve the caller's channel (`ChannelsService.findByUserId(sub)`).
2. Insert a `videos` row with `status: 'uploading'`, a generated `public_id`, `description: null` and the declared `mime_type`/`size_bytes`.
3. Run `CreateMultipartUpload` on `{id}/original` with `ContentType = mime_type`.
4. Persist `upload_id`.

If step 3 fails, the row inserted in step 2 is deleted before the error propagates, so no orphan draft is left without an `upload_id`.

**Response 201:**
- video: `VideoResponse` (`status: 'uploading'`, `thumbnail_url: null`)
- upload: object
  - part_size_bytes: number — always `16777216` (16 MiB, `VIDEO_UPLOAD_PART_SIZE_BYTES`, library-refs multipart limits)
  - part_count: number — `ceil(size_bytes / part_size_bytes)`, max 640
  - max_part_urls_per_request: number — always `100`

**Error responses:**
- 400 VALIDATION_ERROR: body fails validation (missing field, `mime_type` outside the allowlist, `size_bytes` < 1 or > 10737418240, unknown property)
- 401 (unauthenticated): missing or invalid bearer token
- 404 CHANNEL_NOT_FOUND: the authenticated user has no channel

---

#### POST /videos/:publicId/upload/part-urls (SI-03.6)

Issue presigned `UploadPart` URLs for a batch of parts. Batching lets the client fetch fresh URLs as it goes and resume per part (TD-02). The endpoint is `POST` + `@HttpCode(200)`: it is an action that computes signatures and creates no resource.

**Request headers:**
- Authorization: Bearer {access_token}
- Content-Type: application/json

**Request body:**
- part_numbers: integer[], required — 1..100 items, unique (`@ArrayUnique`), each ≥ 1

**Response 200:**
- parts: array of `{ part_number: number, url: string }` in the request order. Each `url` is a presigned `UploadPartCommand({ Bucket: videosBucket, Key: '{id}/original', UploadId, PartNumber })` signed by the **public** client (AMB-7) with `expiresIn: 3600`.
- expires_at: string (ISO-8601) — signing time + 3600 s

The client sends `PUT {url}` with the raw part bytes and records the `ETag` response header (exposed by the storage CORS configuration, DG-3).

**Error responses:**
- 400 VALIDATION_ERROR: malformed `publicId` or body
- 400 PART_NUMBER_OUT_OF_RANGE: any part number > the video's `part_count` (computed from `size_bytes`)
- 401 (unauthenticated)
- 404 VIDEO_NOT_FOUND: unknown `publicId`, or the video belongs to another channel (TD-10)
- 409 INVALID_UPLOAD_STATE: `status ≠ 'uploading'`

---

#### GET /videos/:publicId/upload/parts (SI-03.6)

List the parts already stored, so an interrupted upload can resume (TD-02).

**Request headers:**
- Authorization: Bearer {access_token}

**Response 200:**
- parts: array of `{ part_number: number, size_bytes: number, etag: string }`, ascending by `part_number`. Built from `ListParts`, paginated through `PartNumberMarker` until `IsTruncated` is false.

**Error responses:**
- 400 VALIDATION_ERROR: malformed `publicId`
- 401 (unauthenticated)
- 404 VIDEO_NOT_FOUND
- 409 INVALID_UPLOAD_STATE: `status ≠ 'uploading'`

---

#### POST /videos/:publicId/upload/complete (SI-03.7)

Finish the multipart upload, re-check the real size, flip the status to `processing` and enqueue processing idempotently (TD-03, AMB-3).

**Request headers:**
- Authorization: Bearer {access_token}

**Request body:** none. The server builds the part list from `ListParts`; the client never sends ETags.

**Behavior (in order):**
1. Owner check (TD-10).
2. If `status = 'processing'`, re-enqueue only (step 7), which is a no-op if the job exists, then return 202. This makes a retried complete idempotent and recovers from an enqueue failure after the status flip.
3. If `status` is `ready` or `failed` → 409 `INVALID_UPLOAD_STATE`.
4. With `status = 'uploading'`:
   - `ListParts` (paginated). The set of part numbers must equal `{1..part_count}`, otherwise → 409 `UPLOAD_INCOMPLETE`.
   - `CompleteMultipartUpload` with `Parts: [{ PartNumber, ETag }]` ascending.
   - If S3 answers `NoSuchUpload`, a previous complete already finished on the storage side: continue to step 5 only if `HeadObject` finds the object, otherwise → 409 `UPLOAD_INCOMPLETE`.
5. `HeadObject('{id}/original')`. If `ContentLength > 10737418240`:
   - delete the object;
   - set `status: 'failed'`, `processing_error: 'FILE_TOO_LARGE'`, `upload_id: null`;
   - → 422 `VIDEO_FILE_TOO_LARGE`.
6. Conditional update `WHERE id = :id AND status = 'uploading'`: `status: 'processing'`, `size_bytes = ContentLength`, `upload_id: null`. If 0 rows are affected, re-read the row:
- now `processing` → a concurrent complete won; go to step 7 (idempotent 202);
- now `failed` → 409 `INVALID_UPLOAD_STATE`;
- gone → it was cancelled concurrently; delete the assembled object, then → 404 `VIDEO_NOT_FOUND`.

The over-cap `failed` transition in step 5 uses the same conditional guard.
7. `VideoProcessingQueue.enqueue(video.id)` (Events/Messages).

**Response 202:** `VideoResponse` (`status: 'processing'`)

**Error responses:**
- 400 VALIDATION_ERROR: malformed `publicId`
- 401 (unauthenticated)
- 404 VIDEO_NOT_FOUND
- 409 INVALID_UPLOAD_STATE: `status` is `ready` or `failed`
- 409 UPLOAD_INCOMPLETE: missing parts, a non-final part smaller than 5 MiB or a stale part (S3 `EntityTooSmall`/`InvalidPart`/`InvalidPartOrder`), or no stored object after `NoSuchUpload`
- 422 VIDEO_FILE_TOO_LARGE: the stored object exceeds 10 GiB

---

#### DELETE /videos/:publicId/upload (SI-03.6)

Cancel an in-progress upload (AMB-4). The order closes the race with a concurrent complete:
1. Owner check.
2. Conditional delete: `DELETE FROM videos WHERE id = :id AND status = 'uploading'`. If 0 rows are affected, the video left `uploading` concurrently → 409 `INVALID_UPLOAD_STATE`.
3. `AbortMultipartUpload`. A `NoSuchUpload` is treated as already aborted or completed.
4. `DeleteObject('{id}/original')`. This is idempotent in S3 and removes the object if a concurrent complete had already assembled it, so no orphan bytes remain.

**Request headers:**
- Authorization: Bearer {access_token}

**Response 204:** No content.

**Error responses:**
- 400 VALIDATION_ERROR: malformed `publicId`
- 401 (unauthenticated)
- 404 VIDEO_NOT_FOUND
- 409 INVALID_UPLOAD_STATE: `status ≠ 'uploading'`. Deleting processed videos belongs to Fase 04.

---

#### GET /videos/:publicId (SI-03.10)

Owner read of the video: status, persisted metadata and the thumbnail URL (AMB-2, AMB-8). Clients poll it to follow `processing → ready | failed`.

**Request headers:**
- Authorization: Bearer {access_token}

**Response 200:** `VideoResponse`. `thumbnail_url` is a presigned GET of `{id}/thumbnail.jpg` in the thumbnails bucket, `ResponseContentType: 'image/jpeg'`, 900 s TTL, public client, when `status = 'ready'`. Otherwise it is `null`.

**Error responses:**
- 400 VALIDATION_ERROR: malformed `publicId`
- 401 (unauthenticated)
- 404 VIDEO_NOT_FOUND

---

#### GET /videos/:publicId/stream (SI-03.11)

Return a presigned URL for HTTP-Range streaming directly from storage (TD-07).

**Request headers:**
- Authorization: Bearer {access_token}

**Response 200:**
- url: string — presigned `GetObjectCommand({ Bucket: videosBucket, Key: '{id}/original', ResponseContentType: mime_type })`, public client, `expiresIn: 21600` (6 h). A `<video>` element issues ranged requests for the whole playback session, and a request made after expiry gets a 403, so the TTL must cover a long viewing session (max allowed: 7 days, library-refs). The storage answers `Range: bytes=…` with `206 Partial Content` + `Content-Range` (verified in SI-03.2).
- expires_at: string (ISO-8601)

**Error responses:**
- 400 VALIDATION_ERROR: malformed `publicId`
- 401 (unauthenticated)
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY: `status ≠ 'ready'`

---

#### GET /videos/:publicId/download (SI-03.11)

Return a presigned URL that makes the browser download the file (TD-07).

**Request headers:**
- Authorization: Bearer {access_token}

**Response 200:**
- url: string — presigned `GetObjectCommand({ Bucket: videosBucket, Key: '{id}/original', ResponseContentDisposition: 'attachment; filename="{safe}"; filename*=UTF-8\'\'{encoded}' })`, public client, `expiresIn: 900`. A download is a single request, so the signature only has to be valid when the request starts.
  - `{safe}` is `original_filename` with every character outside `[A-Za-z0-9._ -]` replaced by `_`.
  - `{encoded}` is `encodeURIComponent(original_filename)` with `'`, `(`, `)` and `*` also percent-encoded. `encodeURIComponent` leaves them literal, but they are not RFC 8187 `attr-char`, and a literal `'` breaks the `UTF-8''` delimiter.
- expires_at: string (ISO-8601)

**Error responses:**
- 400 VALIDATION_ERROR: malformed `publicId`
- 401 (unauthenticated)
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY: `status ≠ 'ready'`

---

#### Validation Rules — Videos

- `filename`: `@IsString()`, `@Transform(trim)`, `@Length(1, 255)`
- `mime_type`: `@IsIn(VIDEO_ALLOWED_MIME_TYPES)` — `['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska']` as a const in `videos.constants.ts`
- `size_bytes`: `@IsInt()`, `@Min(1)`, `@Max(VIDEO_MAX_SIZE_BYTES)` where `VIDEO_MAX_SIZE_BYTES = 10 * 1024 ** 3`
- `title`: `@IsOptional()`, `@IsString()`, `@Transform(trim)`, `@Length(1, 100)`
- `part_numbers`: `@IsArray()`, `@ArrayMinSize(1)`, `@ArrayMaxSize(100)`, `@ArrayUnique()`, `@IsInt({ each: true })`, `@Min(1, { each: true })`. The upper bound (`part_count`) is checked in the service, because it depends on the stored video.
- `publicId` (path): `@Matches(/^[A-Za-z0-9_-]{11}$/)`
- The global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`) is unchanged. One e2e validation-wiring test per endpoint that has a body or param.

### Authorization Matrix

All rules are centralized in `VideoAccessPolicy` (`src/videos/video-access.policy.ts`, TD-10). The service loads the video joined with its channel and calls `policy.assertOwner(video, sub)`. The check is `video.channel.user_id === sub`; a mismatch throws `VideoNotFoundException`, so a non-owner can't tell whether the video exists (AMB-6). Controllers never compare ids.

| Endpoint | Anonymous | Authenticated (non-owner) | Owner |
|---|---|---|---|
| POST /videos | ✗ 401 | n/a (the video is created on the caller's own channel) | ✓ |
| POST /videos/:publicId/upload/part-urls | ✗ 401 | ✗ 404 VIDEO_NOT_FOUND | ✓ |
| GET /videos/:publicId/upload/parts | ✗ 401 | ✗ 404 VIDEO_NOT_FOUND | ✓ |
| POST /videos/:publicId/upload/complete | ✗ 401 | ✗ 404 VIDEO_NOT_FOUND | ✓ |
| DELETE /videos/:publicId/upload | ✗ 401 | ✗ 404 VIDEO_NOT_FOUND | ✓ |
| GET /videos/:publicId | ✗ 401 | ✗ 404 VIDEO_NOT_FOUND | ✓ |
| GET /videos/:publicId/stream | ✗ 401 | ✗ 404 VIDEO_NOT_FOUND | ✓ |
| GET /videos/:publicId/download | ✗ 401 | ✗ 404 VIDEO_NOT_FOUND | ✓ |

Public (anonymous) playback of `ready` videos comes with publishing/visibility in Fase 04. `VideoAccessPolicy` is the single extension point: Fase 04 adds a `canView` rule there without touching the endpoints. The 401 response comes from the inherited `JwtAuthGuard` and its envelope (`phase-02-auth`).

### Error Catalog

New domain exceptions live in `src/videos/exceptions/` and `src/storage/exceptions/`. Each extends the inherited `DomainException(errorCode, httpStatus, message)` and is mapped by the existing `DomainExceptionFilter`; the filter needs no changes.

| Error code | HTTP | Exception class | Thrown by | When |
|---|---|---|---|---|
| VALIDATION_ERROR | 400 | (inherited, `ValidationExceptionFilter`) | ValidationPipe | DTO/param validation fails |
| PART_NUMBER_OUT_OF_RANGE | 400 | `PartNumberOutOfRangeException` | VideoUploadService | a requested part number > `part_count` |
| — | 401 | (inherited, `JwtAuthGuard`) | guard | missing or invalid access token |
| CHANNEL_NOT_FOUND | 404 | `ChannelNotFoundException` (`src/channels/exceptions/`) | ChannelsService.findByUserId | the user has no channel |
| VIDEO_NOT_FOUND | 404 | `VideoNotFoundException` | VideosService / VideoAccessPolicy | unknown `publicId`, or the caller is not the owner |
| INVALID_UPLOAD_STATE | 409 | `InvalidUploadStateException` | VideoUploadService | an upload operation on a video whose status doesn't allow it |
| UPLOAD_INCOMPLETE | 409 | `UploadIncompleteException` | VideoUploadService | complete with missing parts, a non-final part < 5 MiB or a stale part (`StorageInvalidPartsError`), or `NoSuchUpload` and no object |
| VIDEO_NOT_READY | 409 | `VideoNotReadyException` | VideoPlaybackService | stream/download while `status ≠ 'ready'` |
| VIDEO_FILE_TOO_LARGE | 422 | `VideoFileTooLargeException` | VideoUploadService | the stored object exceeds 10 GiB at complete |
| STORAGE_UNAVAILABLE | 503 | `StorageUnavailableException` (`src/storage/exceptions/`) | StorageService | an unexpected SDK error (network, 5xx). The SDK error is logged with no credentials; the client gets a generic message. |

**StorageService error translation** (library-refs, AWS SDK v3 errors). This is the only place that inspects SDK errors; callers only see these outcomes:
- `NoSuchUpload` → `StorageUploadNotFoundError` (internal, never reaches HTTP; VideoUploadService handles it per the complete/cancel rules)
- `NoSuchKey`, `NotFound`, or `$metadata.httpStatusCode === 404` on Head/Get → `StorageObjectNotFoundError` (internal)
- `EntityTooSmall`, `InvalidPart` or `InvalidPartOrder` on `CompleteMultipartUpload` → `StorageInvalidPartsError` (internal). VideoUploadService maps it to 409 `UPLOAD_INCOMPLETE`: the client sent a non-final part smaller than 5 MiB or a part that no longer matches.
- `BucketAlreadyOwnedByYou` / `BucketAlreadyExists` during bootstrap → treated as success
- anything else → `StorageUnavailableException` (503)

**Worker failure codes**, persisted in `videos.processing_error` (`VideoProcessingErrorCode` const in `videos.constants.ts`). They never surface as HTTP errors; the owner sees them through `GET /videos/:publicId`:

| Code | Terminal? | Set by | When |
|---|---|---|---|
| FILE_TOO_LARGE | yes | VideoUploadService (complete) | the stored object exceeds 10 GiB |
| SOURCE_OBJECT_MISSING | yes (`UnrecoverableError`) | VideoProcessingService | `{id}/original` doesn't exist when the job runs |
| NO_VIDEO_STREAM | yes (`UnrecoverableError`) | VideoProcessingService | ffprobe finds no video stream, or the file is not a media container (AMB-5) |
| PROCESSING_FAILED | after retries | VideoProcessingProcessor | the final attempt failed with a transient error (ffmpeg crash, storage hiccup) — TD-09 |

### Events/Messages

Transport: BullMQ on Redis (TD-01). The queue name, job name and payload type are the contract between the API (producer) and the worker (consumer). They live in `src/video-processing/video-processing.constants.ts` and `video-processing.types.ts`, and both sides import from there; neither side hard-codes the strings.

#### process-video

**Queue:** `video-processing` (`VIDEO_PROCESSING_QUEUE`)
**Job name:** `process-video` (`PROCESS_VIDEO_JOB`)

**Payload:**
```json
{
  "videoId": "3f6c2a9e-8b1d-4c7a-9e2f-1a2b3c4d5e6f"
}
```

The payload contains only the internal UUID (`ProcessVideoJobData = { videoId: string }`). Everything else is read from the database at processing time, so a retried or stalled job always sees current state.

**Job options** (`VIDEO_PROCESSING_JOB_OPTIONS`, set at enqueue; library-refs BullMQ):
- `jobId: 'video-{videoId}'` — deduplication. BullMQ silently ignores a second `add` with an existing jobId, which makes a re-enqueue from a retried complete a no-op.
- `attempts: 3`
- `backoff: { type: 'exponential', delay: 1000 }` — 1 s, then 2 s
- `removeOnComplete: { age: 3600, count: 1000 }`
- `removeOnFail: { age: 86400 }`

  The jobId stays reserved while the job is retained. A failed video is terminal in this phase (TD-09), so a reserved id is never needed for a re-run.

**Producer:** `VideoProcessingQueue.enqueue(videoId)` (`src/video-processing/video-processing.queue.ts`, SI-03.3), called by `VideoUploadService.complete` (SI-03.7).
**Consumer:** `VideoProcessingProcessor` (`@Processor(VIDEO_PROCESSING_QUEUE)`, extends `WorkerHost`, SI-03.9.2; process entrypoint SI-03.9.1). It runs only in the `video-worker` process (`src/worker.ts`); the API process registers the queue (producer) but never a processor.
**Trigger:** a successful `POST /videos/:publicId/upload/complete`, after the row is set to `processing`. It also fires on a repeated complete while the row is still `processing`.
**Delivery semantics:** at-least-once. BullMQ re-runs stalled jobs (library-refs), so processing must be idempotent:
- if the row is missing (deleted) or already `ready`/`failed`, the job completes as a no-op;
- the thumbnail is written with `PutObject` to a fixed key (an overwrite is harmless);
- `markReady`/`markFailed` update the row with `WHERE status = 'processing'`.

**Processing steps** (`VideoProcessingService.process(videoId)`):

| # | Step | Failure → |
|---|---|---|
| 1 | Load the video; skip if missing or `status ≠ 'processing'` | — (no-op) |
| 2 | `HeadObject('{id}/original')` | not found → terminal `SOURCE_OBJECT_MISSING` |
| 3 | Presign an internal GET (**internal** client, `http://minio:9000`, AMB-7) with a 3600 s TTL; ffprobe reads it over HTTP (no download to disk) | ffprobe exit ≠ 0 / not a media container → terminal `NO_VIDEO_STREAM` |
| 4 | Validate: at least one `codec_type = 'video'` stream | none → terminal `NO_VIDEO_STREAM` |
| 5 | Extract metadata (AMB-2): `duration_seconds` (format.duration, null if absent), `width`/`height`/`video_codec` (first video stream), `audio_codec` (first audio stream or null), `container_format` (format.format_name) | — |
| 6 | Thumbnail: ffmpeg `-ss {t} -i {url} -frames:v 1 -vf scale='min(640,iw)':-2 -q:v 3 -f image2 pipe:1`, where `t = duration × 0.10` if duration ≥ 2 s, else `0` (first frame) (TD-05) | ffmpeg exit ≠ 0 or empty output → transient error (retry) |
| 7 | `PutObject` to the thumbnails bucket, `{id}/thumbnail.jpg`, `ContentType: image/jpeg` | storage error → transient (retry) |
| 8 | `VideosService.markReady(id, metadata)` — the invariant that ready implies a thumbnail holds because step 7 precedes it | — |

**Failure handling** (in `VideoProcessingProcessor.process`, TD-09):
- terminal error (`VideoProcessingTerminalError` carrying a code) → `markFailed(id, code)`, then throw `new UnrecoverableError(code)` so BullMQ stops retrying;
- transient error on the final attempt (pure helper `isFinalAttempt(job) = job.attemptsMade + 1 >= (job.opts.attempts ?? 1)`) → `markFailed(id, 'PROCESSING_FAILED')`, then rethrow;
- transient error on an earlier attempt → rethrow only (BullMQ schedules the backoff retry).

The `failed` state is written **inside** `process()` rather than in a `@OnWorkerEvent('failed')` listener. Listener errors are swallowed and a crash between the throw and the listener would lose the transition, whereas inside `process()` the write happens before BullMQ records the failure.

---

## Dependency Map

```
SI-03.1 (root — Redis, MinIO, video-worker, ffmpeg na imagem, namespaces de config)
├── SI-03.2 — depends on SI-03.1 (MinIO e namespace storage)
├── SI-03.3 — depends on SI-03.1 (Redis e namespace queue)
├── SI-03.4 — depends on SI-03.1 (ordem DG-1: infra antes da entidade)
│   └── SI-03.5.1 — depends on SI-03.4 (entidade Video)
│       └── SI-03.5.2 — depends on SI-03.5.1 + SI-03.2 + SI-03.3 (VideosService, createMultipartUpload, módulo da fila)
│           └── SI-03.6 — depends on SI-03.5.2 (controller, VideoUploadService, rascunho com upload_id)
│               └── SI-03.7 — depends on SI-03.6 + SI-03.3 (partes enviadas; enqueue)
│                   └── SI-03.9.2 — depends on SI-03.7 + SI-03.9.1 + SI-03.8 (vídeos em processing; WorkerModule; FfmpegService)
│                       └── SI-03.10 — depends on SI-03.9.2 + SI-03.5.2 (vídeos ready com thumbnail; toVideoResponse)
│                           └── SI-03.11 — depends on SI-03.10 (VideoPlaybackService)
│                               └── SI-03.12 — depends on SI-03.11 (último endpoint; fluxo completo)
│                                   └── SI-03.13 — depends on SI-03.12 (bootstrap do fluxo; verificação real de 10 GiB)
├── SI-03.8 — depends on SI-03.1 (ffmpeg/ffprobe na imagem) ──────────────► SI-03.9.2
└── SI-03.9.1 — depends on SI-03.3 + SI-03.4 (QueueModule; entidade Video) ► SI-03.9.2
```

**Paralelizáveis após SI-03.1:** SI-03.2, SI-03.3, SI-03.4 e SI-03.8. SI-03.9.1 só precisa de SI-03.3 e SI-03.4, então corre em paralelo com a trilha de upload (SI-03.5.1 → SI-03.7). O caminho crítico é SI-03.1 → 03.4 → 03.5.1 → 03.5.2 → 03.6 → 03.7 → 03.9.2 → 03.10 → 03.11 → 03.12 → 03.13.

---

## Deliverables

- [ ] SI-03.1 — Infra: Redis, MinIO, serviço video-worker e namespaces de configuração
- [ ] SI-03.2 — StorageModule: clientes S3, StorageService e bootstrap de buckets
- [ ] SI-03.3 — QueueModule e produtor da fila video-processing
- [ ] SI-03.4 — Entidade Video, migration e re-entrância do teste de migrations
- [ ] SI-03.5.1 — Domínio de vídeos: canal do usuário, public_id, título default e política de acesso
- [ ] SI-03.5.2 — Endpoint POST /videos: iniciar upload e pré-cadastrar rascunho
- [ ] SI-03.6 — Endpoints de upload em andamento: URLs de partes, partes enviadas e cancelamento
- [ ] SI-03.7 — Endpoint POST /videos/:publicId/upload/complete: concluir upload e enfileirar processamento
- [ ] SI-03.8 — MediaModule: FfmpegService (ffprobe/ffmpeg via spawn) e fixtures de vídeo
- [ ] SI-03.9.1 — Infra: runtime do worker (entrypoint, WorkerModule e módulos raiz compartilhados)
- [ ] SI-03.9.2 — Pipeline de processamento: consumidor process-video, metadados, thumbnail e falhas
- [ ] SI-03.10 — Endpoint GET /videos/:publicId: leitura do dono com status, metadados e thumbnail
- [ ] SI-03.11 — Endpoints GET /videos/:publicId/stream e /download: URLs presignadas de reprodução e download
- [ ] SI-03.12 — Fluxo ponta a ponta: upload direto → processamento → reprodução, e contrato OpenAPI
- [ ] SI-03.13 — Verificação do limite de 10 GiB com um vídeo real

**Full test suites:**

- [ ] Backend tests pass, unit + integration (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] 10 GiB limit suite passes (`docker compose exec nestjs-api npm run fixtures:large && docker compose exec nestjs-api npm run test:large`) — precisa de cerca de 30 GB livres no disco do Docker
- [ ] Type/compilation checks pass (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully (`docker compose exec nestjs-api npm run build`) — confere que `dist/worker.js` é gerado ao lado de `dist/main.js`
- [ ] `docker compose up -d` sobe `nestjs-api`, `video-worker`, `db`, `redis` e `minio` saudáveis, sem nenhum `localhost` nas variáveis de conexão entre serviços
