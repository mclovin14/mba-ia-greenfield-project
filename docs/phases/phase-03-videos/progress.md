# phase-03-videos — Progress

**Status:** completed
**SIs:** 16/16 completed

### SI-03.1 — Infra: Redis, MinIO, serviço video-worker e namespaces de configuração
- **Status:** completed
- **Tests:** 17/17 passing (env.validation.integration-spec.ts, storage.config.spec.ts); ACs de infra verificados manualmente (db/redis/minio healthy, ffprobe/ffmpeg exit 0, `noeviction`, env resolvido do minio)
- **Observations:**
  - **Ambiente:** dentro do container, os symlinks de `node_modules/.bin` (bind mount `fuse.sshfs` do Rancher Desktop) falham com `Operation not permitted`, então `npm test`, `npx tsc`, `npm run build` e `npm run lint` não iniciam. Arquivos regulares são lidos normalmente; os testes rodaram com `node node_modules/jest/bin/jest.js`. Parece ser permissão do macOS (pasta `~/Documents` protegida por TCC, atributo `com.apple.provenance`) sobre o processo sshfs do Rancher. `npm install` no container não resolveu.
  - `.env` local (gitignored) recebeu as mesmas variáveis novas do `.env.example`; sem elas o boot falha na validação.

### SI-03.2 — StorageModule: clientes S3, StorageService e bootstrap de buckets
- **Status:** completed
- **Tests:** 33/33 passing (storage.module.spec.ts, storage.service.spec.ts, storage-bootstrap.service.spec.ts, storage.service.integration-spec.ts e storage-cors.integration-spec.ts contra o MinIO real); `tsc --noEmit` e eslint limpos nos arquivos do SI
- **Observations:**
  - As suítes de integração usam buckets próprios (`it-storage-*`, `it-cors-*`) via `S3_VIDEOS_BUCKET`/`S3_THUMBNAILS_BUCKET`, para que o `emptyBucket` nunca apague dados de desenvolvimento dos buckets `videos`/`thumbnails`.
  - `StorageModule` ainda não está no `AppModule`. Pelo plano, ele entra como import do `VideosModule` (SI-03.5.2) e do `WorkerModule` (SI-03.9.2). O AC "boot cria os buckets; segundo boot não falha" foi verificado pelo `init()` do módulo na integração (dois boots seguidos).
  - `emptyBucket(bucket)` cria e destrói o próprio cliente S3 de teste. Também foi exportado `createTestS3Client()` para asserções diretas (HeadBucket).
  - Os nomes de erro do SDK e os tokens dos clientes ficam em `storage.constants.ts`.

### SI-03.3 — QueueModule e produtor da fila video-processing
- **Status:** completed
- **Tests:** 4/4 passing (video-processing-queue.module.spec.ts, video-processing.queue.integration-spec.ts com Redis real e `QUEUE_PREFIX=test-{uuid}`); regressão e2e existente 52/52 com `QueueModule` no `AppModule`; `tsc --noEmit` e eslint limpos
- **Observations:**
  - `BullModule.forRootAsync` injeta o namespace tipado `queueConfig.KEY` em vez de `ConfigService`, seguindo a convenção de config do projeto (library-refs também recomenda isso).
  - `VIDEO_PROCESSING_JOB_OPTIONS` usa `as const satisfies JobsOptions`, o que faz o compilador checar o contrato contra os tipos do BullMQ.
  - O AC "API sem worker" foi verificado com `getWorkersCount() = 0` no módulo produtor. `VideoProcessingQueueModule` ainda não está no `AppModule`: ele entra via `VideosModule` (SI-03.5.2/03.7).

### SI-03.4 — Entidade Video, migration e re-entrância do teste de migrations
- **Status:** completed
- **Tests:** 11 passing (video.entity integration 6, migrations integration 3, video-object-keys unit 2), estáveis em duas execuções seguidas (re-entrância OK). Regressão: unit+integration 33 suítes / 203 testes; e2e 52/52. `tsc --noEmit` limpo.
- **Observations:**
  - Migration `1791237941900-CreateVideos` gerada via CLI chamando `node node_modules/typeorm/cli-ts-node-commonjs.js` direto (symlinks de `.bin` dão EPERM no volume fuse.sshfs). Revert/run conferidos no DB de dev, que ficou com 3 migrations.
  - A relação inversa `Channel.videos` obriga todo DataSource que carrega `Channel` a carregar também `Video`. Por isso `Video` entrou nos `ALL_ENTITIES` de 10 specs da Fase 02, e `cleanAllTables` agora apaga `videos` antes de `channels`.
  - **Desvio:** `src/videos/videos-core.module.ts` foi criado já neste SI, só com `TypeOrmModule.forFeature([Video])` exportado, e importado no `AppModule`. Sem ele o boot da app quebrava (`Entity metadata for Channel#videos was not found`, com `autoLoadEntities`). O SI-03.5.1 acrescenta `VideosService` e `VideoAccessPolicy` a esse módulo. Registrar `Video` no `ChannelsModule` foi descartado, porque violaria a propriedade do domínio.
  - **Fora de escopo:** `npm run lint` já falhava com 190 problemas (150 erros, 40 avisos; medido na verificação final contra o HEAD) em arquivos da Fase 02 (`auth.service.spec.ts`, `channels.service.spec.ts` e outros). Os arquivos deste SI não adicionam nenhum.

### SI-03.5.1 — Domínio de vídeos: canal do usuário, public_id, título default e política de acesso
- **Status:** completed
- **Tests:** 18 novos passando (videos.service unit 3, videos.service integration 5, video-access.policy unit 3, video-title unit 5, channels.service integration +2 de `findByUserId`). Regressão: unit+integration 37 suítes / 221 testes; e2e 52/52. `tsc --noEmit` limpo.
- **Observations:**
  - `VideosCoreModule`, criado no SI-03.4, recebeu `VideosService` e `VideoAccessPolicy` (providers + exports). Continua sem controller, storage ou fila.
  - `VideoAccessPolicy.assertOwner` é uma assertion function (`asserts video is Video`), então `findOwnedByPublicId` devolve `Video` sem cast.
  - Constantes do domínio (`PUBLIC_ID_*`, `VIDEO_TITLE_MAX_LENGTH`, `DEFAULT_VIDEO_TITLE`) ficam em `src/videos/videos.constants.ts`. O SI-03.9.2 adiciona `VideoProcessingErrorCode` a esse arquivo.
  - `createDraft` grava `description: null` explicitamente para que o objeto devolvido bata com a linha persistida. O `insert` completa id, status default e timestamps via RETURNING.
  - Teste extra de `setUploadId`/`delete` em videos.service integration, além da tabela do plano.
  - **Fora de escopo, conforme o plano:** `ChannelsService` ainda usa sua cópia privada de `isPgUniqueViolationOnColumn`. A migração para `src/common/database/pg-errors.ts` fica como tarefa separada. O lint de `channels.service.ts` continua com os mesmos 6 problemas pré-existentes.

### SI-03.5.2 — Endpoint POST /videos: iniciar upload e pré-cadastrar rascunho
- **Status:** completed
- **Tests:** 13 unit/module novos (video-upload.service unit 9, video-response.dto unit 3, videos.module compilação 1) + e2e `test/videos-initiate-upload.e2e-spec.ts` com os 9 cenários do spec, todos passando. Regressão: unit+integration 40 suítes / 234 testes; e2e 4 suítes / 61 testes. `tsc --noEmit` limpo; lint limpo nos arquivos do SI.
- **Observations:**
  - `videos.constants.ts` já existia (SI-03.5.1) e foi estendido com MIME allowlist, limites de tamanho/partes, `VideoProcessingErrorCode`, `PUBLIC_ID_PATTERN` e `videoPartCount`.
  - `AppModule` passou a importar `VideosModule` no lugar de `VideosCoreModule`. O core continua carregado, via `VideosModule`.
  - Helpers e2e novos em `test/support/`:
    - `auth.ts` → `registerConfirmAndLogin(app, email)`, pelos endpoints reais; só intercepta o e-mail de confirmação para ler o token;
    - `videos-app.ts` → `createVideosTestApp()`, que reproduz os globais de `main.ts` e isola o ambiente: buckets dedicados `e2e-videos`/`e2e-thumbnails`, criados pelo bootstrap do storage, e `QUEUE_PREFIX=test-{uuid}`. Restaura o env no `close()`.
    
    Com isso o `emptyBucket` dos suites de vídeo nunca toca os buckets de dev. Os SIs 03.6, 03.7, 03.10 e 03.11 reaproveitam esses helpers.
  - **Fora de escopo:** `test/auth.e2e-spec.ts` mantém sua cópia local de `registerConfirmAndLogin`. Migrar para o helper compartilhado é refatoração separada.
  - context7 não está disponível nesta sessão. A API do `@Transform` foi conferida na tipagem instalada (class-transformer 0.5.1). Os demais decorators seguem o padrão já usado no projeto (`auth.controller.ts`, `api-error-envelope.dto.ts`).

### SI-03.6 — Endpoints de upload em andamento: URLs de partes, partes enviadas e cancelamento
- **Status:** completed
- **Tests:** 12 novos passando: video-upload.service unit +9, video-upload.service integration 2 (MinIO + Postgres reais), videos.service integration +1 (`deleteIfStatus`). Também passa o e2e `test/videos-upload-session.e2e-spec.ts`, com os 9 cenários do spec. Regressão: unit+integration 41 suítes / 246 testes; e2e 5 suítes / 70 testes. `tsc --noEmit` limpo; lint limpo nos arquivos do SI.
- **Observations:**
  - **Divergência no spec, grupo 2:** o setup diz que `size_bytes: 5242880 + 1024` gera "2 partes". Com partes de 16 MiB (`VIDEO_UPLOAD_PART_SIZE_BYTES`), esse tamanho dá `part_count = 1`. Os passos do cenário usam só a parte 1, então o e2e segue o tamanho do spec e continua válido. A integração usa 20 MiB (2 partes) para exercitar a ordem `[2, 1]` e o PUT real de 5 MiB. Corrigir o texto do spec fica como tarefa separada.
  - `findUploading` (privado no `VideoUploadService`) estreita o tipo para `Video & { upload_id: string }`, sem non-null assertion. Também trata `upload_id = NULL` como estado inválido, além de `status ≠ 'uploading'`.
  - No `cancel`, só `StorageUploadNotFoundError` é absorvido no abort, conforme o contrato. Qualquer outro erro de storage propaga e o `deleteObject` não roda (teste unitário dedicado).
  - `expires_at` é calculado a partir do instante anterior à assinatura, então nunca passa do vencimento real das URLs.
  - O e2e limpa o storage do throttler em cada `beforeEach`, porque os logins passam pelas rotas de auth, que têm limite. As rotas de vídeo seguem fora do throttler (`@SkipThrottle` no controller).

### SI-03.7 — Endpoint POST /videos/:publicId/upload/complete: concluir upload e enfileirar processamento
- **Status:** completed
- **Tests:** 14 novos: video-upload.service unit +13 (todos os ramos do `complete`) e video-upload.service integration +1 (MinIO + Postgres + Redis reais: objeto montado, linha em `processing` com o `size_bytes` real e `upload_id` NULL, 1 job `video-{id}`, segundo complete sem job novo). O e2e `test/videos-upload-complete.e2e-spec.ts` cobre os 8 cenários do spec. Regressão: unit+integration 41 suítes / 260 testes; e2e 6 suítes / 78 testes. `tsc --noEmit` limpo; lint limpo nos arquivos do SI.
- **Observations:**
  - **Divergência no spec, grupos 1 a 4:** o setup diz que `size_bytes: 5242880 + 1024` dá 2 partes (mesmo problema do SI-03.6). O e2e declara `16777217` (`part_count = 2`) e envia a parte 1 com 5 MiB e a parte 2 com 1024 bytes. O total real fica 5243904, como o spec pede. Isso também confirma que `size_bytes` passa a ser o tamanho real medido no `HeadObject`, não o declarado.
  - **Cenário 3.1:** o teto não é um provider, então o `overrideProvider` do spec não se aplica. O teste usa `jest.replaceProperty` no export `VIDEO_MAX_SIZE_BYTES` de `videos.constants`, chamado depois do `POST /videos` para que o `@Max` do DTO continue com o limite real. O ramo HTTP de 422 roda de verdade (objeto apagado, linha `failed`/`FILE_TOO_LARGE`, nenhum job). O cenário de 10 GiB segue no SI-03.13.
  - `VideosService` ganhou `findById` e `transitionStatus(id, from, patch)`. Esse é um update condicional `WHERE id AND status = from`, e o tipo `VideoStatusPatch` limita as colunas que uma transição pode alterar.
  - Quando a transição não afeta nenhuma linha, o service relê a linha:
    - já está em `processing` (complete concorrente): reenfileira, e o jobId determinístico deduplica o job;
    - foi para outro estado: 409;
    - a linha sumiu (cancel concorrente): apaga o objeto montado e responde 404.
  - `NoSuchUpload` no `CompleteMultipartUpload` (retry depois de um complete que já tinha montado o objeto) só é aceito se o `HeadObject` confirmar que o objeto existe. Se não existir, a resposta é `UPLOAD_INCOMPLETE`.
  - `VideoUploadService` passou a depender de `VideoProcessingQueue`. A suíte de integração dele agora carrega `queueConfig`, `QueueModule` e `VideoProcessingQueueModule`, com `QUEUE_PREFIX=test-{uuid}`.

### SI-03.8 — MediaModule: FfmpegService (ffprobe/ffmpeg via spawn) e fixtures de vídeo
- **Status:** completed
- **Tests:** 17 novos passando: media.utils unit 8 (`parseProbeOutput` com vídeo + áudio, só vídeo, só áudio e sem duração; `thumbnailTimestamp` para 30 s, 2 s, 1.5 s e `null`) e ffmpeg.service integration 9, com ffprobe/ffmpeg 5.1 reais no contêiner `nestjs-api`. Regressão: unit+integration 43 suítes / 277 testes; e2e 6 suítes / 78 testes. `tsc --noEmit` limpo; lint limpo nos arquivos do SI.
- **Observations:**
  - **Fixture extra `mp4-wide` (1280x720, 1 s):** o AC "largura limitada a 640 px" não tinha fixture no plano, então ela foi adicionada a `getVideoFixture`. O teste confirma 640x360 (proporção mantida). O caso 320 px confirma que vídeos menores não são ampliados. A largura do JPEG é medida rodando o próprio `probe` nos bytes gerados.
  - **AC de injeção:** um nome de arquivo não pode conter `/`, então `; rm -rf /` literal é impossível. O teste copia uma fixture para `clip; touch pwned-…; rm -rf .mp4` e verifica duas coisas:
    - o `probe` lê o arquivo, o que prova que o nome chegou inteiro como um único argumento;
    - o sentinela não existe nem no cwd nem no diretório de trabalho.
  - `parseProbeOutput` recebe a saída já com `format.format_name` garantido no tipo. JSON inválido, container ausente, exit ≠ 0 e estouro de saída viram `MediaNotReadableError` no service.
  - Falha ao iniciar o binário (ex.: `ENOENT`) propaga como erro de ambiente. Ela não vira `MediaNotReadableError`, para não ser confundida com mídia ruim no SI-03.9.2.
  - O timeout usa as opções `timeout` + `killSignal: 'SIGKILL'` do `spawn`. Estourar o teto de stdout mata o processo com `SIGKILL`. O stderr guarda só os últimos 2 KB. Limites e nomes dos binários ficam em `media.constants.ts`.
  - `MediaModule` não tem imports configurados, então não ganhou teste de compilação. A integração já monta o módulo real via `Test.createTestingModule({ imports: [MediaModule] })`.

### SI-03.9.1 — Infra: runtime do worker (entrypoint, WorkerModule e módulos raiz compartilhados)
- **Status:** completed
- **Tests:** 3 novos passando: worker.module unit 1 (compila com os módulos raiz reais e nenhum controller no `ModulesContainer`) e database.module unit 2 (`RootConfigModule` isolado com os 7 namespaces; `DatabaseModule` com conexão inicializada e `synchronize: false`). Regressão: unit+integration 45 suítes / 280 testes; e2e 6 suítes / 78 testes, com `test/auth.e2e-spec.ts` sem alteração. `tsc --noEmit` limpo; lint limpo nos arquivos do SI. ACs operacionais verificados manualmente no contêiner `video-worker`, tanto via ts-node quanto via `node dist/worker` depois de `nest build` (que gera `dist/worker.js`): loga `Video worker started (queue: video-processing)`, o processo fica vivo, não abre socket em LISTEN e encerra com exit 0 cerca de 20 ms após o `SIGTERM`.
- **Observations:**
  - **`enableShutdownHooks(['SIGTERM', 'SIGINT'], { useProcessExit: true })`:** sem a opção, o Nest 11.1.16 relança o sinal no fim do cleanup (`process.kill(pid, signal)`), e o processo sai com 143, não com o 0 que o AC pede. Com `useProcessExit`, o cleanup inteiro (destroy hooks, workers BullMQ, conexão de banco) roda antes do `process.exit(0)`. A opção foi conferida no código e na tipagem instalados.
  - **Ambiente:** `npm run start:worker` no contêiner esbarra no mesmo EPERM dos symlinks `.bin` registrado no SI-03.1 (`sh: ts-node: Operation not permitted`). O comando do script foi executado de forma equivalente, como `node node_modules/ts-node/dist/bin.js -r tsconfig-paths/register src/worker.ts`. O script em si está correto para um ambiente sem essa restrição de permissão.
  - **Verificação de porta:** contei só os sockets LISTEN cujo inode pertence a um fd do processo do worker. O único LISTEN da rede do contêiner é `127.0.0.11`, o DNS embutido do Docker, que não pertence ao processo.
  - `RootConfigModule` e `DatabaseModule` trazem as opções do `AppModule` sem mudança. O `AppModule` ficou só com a composição de módulos, controller e provider.
  - `nestjs-project/CLAUDE.md` passou a documentar o reinício do worker após mudanças de código, o build compilado (`start:worker:prod`) e o encerramento com `SIGTERM`.

### SI-03.9.2 — Pipeline de processamento: consumidor process-video, metadados, thumbnail e falhas
- **Status:** completed
- **Tests:** 42 passing no SI — video-processing.service.spec.ts (15), video-processing.processor.spec.ts (10, inclui `isFinalAttempt`), video-processing.service.integration-spec.ts (7, MinIO + Postgres + ffmpeg reais), video-processing.processor.integration-spec.ts (5, worker BullMQ real com prefixo de teste e as opções de produção: 3 tentativas, backoff exponencial), video-processing-worker.module.spec.ts (3), media.errors.spec.ts (2), mais worker.module.spec.ts revalidado. Regressão: unit + integration 51 suítes / 322 testes; e2e 6 suítes / 78 testes; `tsc --noEmit` 0; lint sem problemas nos arquivos da fase (os restantes estão nos arquivos do baseline da Fase 02)
- **Observations:**
  - **Bug encontrado pelo teste de compilação do WorkerModule:** `autoLoadEntities` só carrega entidades registradas via `forFeature`, e `Video#channel → Channel → User` não estavam registradas no worker (na API vinham pelo `AuthModule`). O worker real teria falhado ao subir com `Entity metadata for Video#channel was not found`. Correção: `WorkerModule` importa `UsersModule` (que importa `ChannelsModule`), e cada domínio continua registrando a própria entidade. Os integration specs não pegavam o bug porque usam `createTestDataSource` com todas as entidades.
  - `MediaNotReadableError`/`MediaFrameExtractionError` agora descartam a query string do input na mensagem, porque a URL presignada carrega a assinatura e a mensagem chega ao log (ação 5); coberto por `media.errors.spec.ts`. Constantes novas em `video-processing.constants.ts`: `VIDEO_SOURCE_URL_TTL_SECONDS = 3600` e `THUMBNAIL_CONTENT_TYPE`.
  - `VideoProcessingService.process` retorna `'ready' | 'skipped'` só para o log distinguir sucesso de no-op idempotente; o contrato de status continua nas transições condicionais (`markReady`/`markFailed` retornam boolean).
  - A checagem "AppModule não contém VideoProcessingProcessor" é estática (percorre os metadados `imports`/`providers` do Nest), sem compilar o `AppModule`: compilá-lo no spec deixava um handle nativo aberto (`@css-inline` do mailer) e o Jest não saía.
  - Helper novo `src/test/processing-fixtures.ts` (`seedProcessingVideo`, `uploadOriginal`) reproduz o estado deixado pelo complete do SI-03.7. Buckets dedicados: `it-processing-*` e `it-processor-*`.
  - **ACs operacionais verificados com o processo real** (`video-worker`, node + bin do ts-node, `QUEUE_PREFIX=bull` e buckets de dev), com script de rascunho fora do repo que deixa linha `processing` + `{id}/original` + job `video-{id}`, igual ao complete: (a) sem worker, a linha fica `processing` e o job `waiting`; (b) com o worker no ar, o MP4 com áudio chega a `ready` em 130 ms com todos os metadados, `processing_error = null` e thumbnail `image/jpeg` de 8223 B; (c) o arquivo só de áudio termina `failed`/`NO_VIDEO_STREAM` com attemptsMade=1; (d) o log tem `videoId` e tentativa, e zero ocorrências de URL ou assinatura; (e) o SIGTERM encerra com exit 0. Os dados de verificação foram removidos (linhas, objetos, jobs). Os ACs de 3 tentativas/`PROCESSING_FAILED`, `SOURCE_OBJECT_MISSING` e reprocessamento no-op estão cobertos pelos integration specs.

### SI-03.10 — Endpoint GET /videos/:publicId: leitura do dono com status, metadados e thumbnail
- **Status:** completed
- **Tests:** 11 passing no SI (video-playback.service.spec.ts 5; videos-get.e2e-spec.ts 6, cobrindo os 6 cenários de `specs/videos-get.plan.md`). Regressão: unit + integração 52 suítes / 327 testes, e2e 7 suítes / 84 testes, `tsc` 0, lint 0 nos arquivos do SI
- **Observations:**
  - `VideoPlaybackService` reusa `THUMBNAIL_CONTENT_TYPE` de `video-processing.constants.ts` em vez de repetir o literal `'image/jpeg'`; `VIDEO_THUMBNAIL_URL_TTL_SECONDS = 900` foi para `videos.constants.ts`, como o plano pede.
  - No e2e, o estado `ready` é semeado com dados reais: o vídeo chega a `processing` pelo fluxo HTTP (POST, PUT da parte única presignada, complete), o JPEG e os metadados vêm do `FfmpegService` real sobre a fixture `mp4-with-audio`, e a transição usa `VideosService.markReady`. O `MediaModule` é compilado à parte porque a API não o carrega.
  - O AC de URL do thumbnail foi verificado ponta a ponta: o host é o de `S3_PUBLIC_ENDPOINT`, e o GET presignado devolve `200`, `Content-Type: image/jpeg` e bytes `FF D8 FF`.
  - O 404 de não dono e o de `publicId` inexistente têm corpo idêntico byte a byte; o envelope de erro não tem path nem timestamp, o que torna essa comparação estável.

### SI-03.11 — Endpoints GET /videos/:publicId/stream e /download: URLs presignadas de reprodução e download
- **Status:** completed
- **Tests:** 21 passing no SI (content-disposition.spec.ts 3; video-playback.service.spec.ts +8 para stream/download; videos-playback.e2e-spec.ts 7, cobrindo os 7 cenários de `specs/videos-playback.plan.md`). Regressão: unit + integração 53 suítes / 338 testes, e2e 8 suítes / 91 testes, `tsc` 0, lint 0 em `src/videos` e nos e2e de vídeo
- **Observations:**
  - `buildAttachmentDisposition` usa regex com flag `u` para o `{safe}`, então um emoji (par substituto) vira um único `_`, não dois.
  - `VideoPlaybackService` ganhou dois helpers privados: `findReadyVideo` (dono + `VIDEO_NOT_READY`) e `presignOriginal` (cliente público, `expires_at` a partir do instante da assinatura, mesmo padrão de `presignPartUrls`).
  - O setup comum dos e2e de leitura (upload pelo fluxo HTTP até `processing` e o estado `ready` semeado com ffmpeg real) foi extraído de `videos-get.e2e-spec.ts` para `test/support/video-states.ts`, e as duas suítes passaram a usá-lo. `uploadToProcessing` aceita o `filename`, o que o cenário de nome não ASCII exige.
  - Verificado contra o MinIO real: `Range: bytes=0-1023` → `206` com `Content-Range: bytes 0-1023/{size}`, `Content-Type: video/mp4` e os primeiros 1024 bytes da fixture; download com `Content-Disposition: attachment;` e SHA-256 igual ao da fixture; o nome `aula 1 — introdução (parte 'a').mp4` decodifica de volta exatamente a partir de `filename*=UTF-8''`.

### SI-03.12 — Fluxo ponta a ponta: upload direto → processamento → reprodução, e contrato OpenAPI
- **Status:** completed
- **Tests:** 5/5 passing (`test/videos.e2e-spec.ts`); regressão: unit + integration 53 suites / 338 testes, e2e 9 suites / 96 testes; `tsc --noEmit` 0; lint dos arquivos da fase 0
- **Observations:**
  - O worker real sobe com `NestFactory.createApplicationContext(WorkerModule)` logo após `createVideosTestApp()`, sob o mesmo env (buckets `e2e-*` e `QUEUE_PREFIX=test-{uuid}`). O consumo é feito pela fila de verdade, sem chamar o processor à mão. No `afterAll`, o worker fecha antes da API.
  - A contagem de bytes usa um listener `'request'` no `node:http` `Server` (o `getHttpServer()` tipado como `App` do supertest exigiu cast). Ela é zerada após o login e cobre só o fluxo do vídeo.
  - AC de isolamento por prefixo: um job publicado numa `Queue` com outro prefixo `test-{uuid}` continua `waiting` com `attemptsMade = 0` enquanto o worker da suíte processa um vídeo de ponta a ponta. Isso prova o isolamento sem sleep fixo. O `video-worker` do compose estava ocioso (só `tail -f`), então o teste não depende dele.
  - O fluxo de upload ficou inline na spec, parametrizado pela fixture (`mp4-with-audio`, `not-media`, `mp4-video-only`). O helper `video-states.ts` não foi alterado.
  - `npm run openapi:export` falha com `ts-node: Operation not permitted` (o mesmo EPERM de `.bin`). O equivalente rodado foi `node node_modules/ts-node/dist/bin.js -r tsconfig-paths/register src/openapi-export.ts`. O `openapi.json` gerado tem as 8 rotas de vídeos e os schemas `VideoResponseDto` e `PresignedUrlResponseDto`, e a segunda execução não gerou diff.
  - `api.http`: nova seção de vídeos com as requisições 10–17, cobrindo as 8 rotas. `@publicId` é capturado do response de `initiateUpload` e reaproveita o `@accessToken` do login.

### SI-03.13 — Verificação do limite de 10 GiB com um vídeo real
- **Status:** completed
- **Tests:** 2/2 passando em `test/videos-10gib.large-spec.ts` (143 s: limite exato 73 s, acima do limite 62 s). `test/videos.e2e-spec.ts` continua 5/5 após a extração. Regressão: unit + integration 53 suites / 338 testes, e2e 9 suites / 96 testes, `tsc --noEmit` 0, lint dos arquivos da fase 0.
- **Observations:**
  - **Fixture:** `npm run fixtures:large` gera `.large-fixtures/video-10gib.mp4` em cerca de 1min44s.
    - O arquivo tem exatamente 10737418240 bytes; o `ffprobe` lê h264 Constrained Baseline yuv420p 1920x1080 + aac LC, com duração de 67,1 s.
    - Uma segunda execução não regenera o arquivo, e `git status` não lista `.large-fixtures/`.
    - Já havia uma fixture com o mesmo nome no diretório. Ela foi movida para o lado, o script gerou a nova do zero para provar que funciona, e a cópia antiga foi apagada.
  - **Padding:** o `free` atom tem o header escrito com `printf "\xNN…free"` e o resto em zeros via `truncate`, porque `xxd` não existe na imagem. O `pad` precisa ficar entre 8 B e 4 GiB (tamanho de 32 bits); fora disso o script aborta.
  - **Bootstrap extraído:** o do SI-03.12 foi para `test/support/videos-test-app.ts` (`createVideosFlowApp`), sobre o `createVideosTestApp` existente. Ele expõe `queue`, `apiBytes()` e `resetApiBytes()`, e `close()` faz obliterate → worker → API. O nome `videos-test-app.ts` vem do plano e convive com o `videos-app.ts` que já existia.
  - **Upload das partes:** cada parte vai por `createReadStream({start, end})` com `content-length` explícito, porque o `requestPresigned` não define esse header para streams. As URLs são pedidas em lotes de `max_part_urls_per_request`, e cada lote sobe com concorrência 4. No cenário acima do limite, a parte 640 recebe 1 byte extra via `Readable.from` de um generator.
  - **Asserts do tail:** o `Range: bytes=-1024` volta 206 com `Content-Range: bytes 10737417216-10737418239/10737418240`, e o corpo é comparado com os últimos 1024 bytes lidos do disco. A API recebeu menos de 1 MiB nos dois cenários.
  - **Acima do limite:** além de 422 e `failed`/`FILE_TOO_LARGE`, o teste confere que o bucket de vídeos está vazio e que `queue.getJob(video-{id})` é `undefined`.
  - **Fixture ausente:** a suíte falha nos 2 testes com a mensagem que aponta para `npm run fixtures:large`. Verificado renomeando o arquivo temporariamente.
  - **Isolamento da suíte:** `test/jest-large.json` usa `testRegex \.large-spec\.ts$` e `testTimeout 3600000`. A suíte não é listada pelas configs de `npm test` nem de `test:e2e` (`--listTests`).
  - **EPERM nos scripts:** `npm run test:large` passa pelo `.bin/jest`, que tem o mesmo EPERM dos outros binários, então a suíte foi rodada com `node node_modules/jest/bin/jest.js --config ./test/jest-large.json --runInBand`. Já `npm run fixtures:large` funciona, porque chama `bash`.

### SI-03.14 (amendment of SI-03.4) — Chaves de storage do original e do thumbnail persistidas no vídeo
- **Status:** completed
- **Tests:** ver a entrada "Correção pós-entrega — chaves de storage persistidas" abaixo (341 / 96, `tsc` 0, lint 0).
- **Observations:** Appended by /plan-build append-mode on 2026-10-07; tracks delta from phase-03-videos/TD-11 Revision 2026-10-07. Entra como `completed`, e não `pending`, porque o código já tinha sido entregue e verificado no commit `d115040` antes da emenda. A emenda só formaliza no plano o trabalho registrado na entrada abaixo.

### Correção pós-entrega — chaves de storage persistidas e context7 (2026-10-07)
- **Status:** completed
- **Motivação:** o enunciado pede que a persistência do vídeo registre, no mínimo, as chaves de storage do arquivo e do thumbnail. Até aqui elas eram apenas derivadas do id (TD-11). Além disso, o `.mcp.json` não tinha o context7.
- **Tests:** unit + integration 53 suites / 341 testes (+3: `original_key` obrigatório na entity, `createDraft` persiste `original_key` e deixa `thumbnail_key` nulo, `original_key` acompanha o id de cada tentativa). A spec de migrations agora reverte `AddVideoStorageKeys` e verifica o backfill de linhas existentes. e2e 9 suites / 96 testes; `tsc --noEmit` 0; lint 0.
- **Observations:**
  - Migration `1791382169844-AddVideoStorageKeys` gerada pela CLI. Removida a recriação espúria de `videos_status_enum` que a CLI emitiu (o enum não mudou), e adicionado à mão o backfill (`{id}/original` para todas as linhas; `{id}/thumbnail.jpg` para as `ready`) antes do `SET NOT NULL`, porque a CLI não expressa migração de dados.
  - `VideosService.createDraft` passou a gerar o uuid (`randomUUID`) antes do insert, para gravar `original_key` na mesma escrita. `markReady` recebe e grava `thumbnail_key`. Upload, worker e playback leem as colunas; `video-object-keys.ts` continua sendo o único lugar que monta as chaves.
  - `.mcp.json` ganhou o servidor `context7` (`@upstash/context7-mcp` 4.2.0). As bibliotecas da fase foram reconferidas por ele (ver *Context7 cross-check* em `library-refs.md`); nenhuma divergência de API. Divergências de versão sinalizadas: o context7 indexa `bullmq` v6.3.11 (projeto em 5.x) e `typeorm` 0.3.27 (projeto em 0.3.28).
  - A tabela *Decisions Summary* do documento de TDs ainda mostrava `_[pending]_` na coluna Choice, embora as 14 TDs estivessem decididas. Ela foi preenchida a partir das linhas `**Decision:**`.

## Correção pós-entrega — suíte serial por configuração (2026-10-07)

- **Status:** done
- **Branch:** `bugfix/test-serial-run`
- **Observations:**
  - `npm test` era `jest` puro, e o Jest usa CPUs−1 workers. Numa máquina com vários núcleos as suítes de integração rodavam em paralelo sobre o mesmo Postgres, Redis e MinIO. Com `--maxWorkers=4` foram 18 testes vermelhos em 7 suítes (limpeza de tabelas e de bucket concorrente).
  - A config do Jest em `package.json` e `test/jest-e2e.json` agora fixa `maxWorkers: 1`. A config de unit + integração também fixa `testTimeout: 30000`, contra o estouro do timeout padrão de 5 s em hooks sob carga. `npm test` e `npm run test:e2e` são seriais em qualquer máquina, sem flags.
  - Verificado sem flags: unit + integração 341/341 e e2e 96/96; `tsc` 0; lint 0.

## Correção pós-entrega — diagnóstico do EPERM em `node_modules/.bin` (2026-10-07)

- **Status:** done
- **Branch:** `docs/rancher-mount-diagnosis`
- **Observations:**
  - A hipótese registrada no SI-03.1 (permissão TCC do macOS sobre `~/Documents`) foi refutada: com Acesso Total ao Disco concedido ao Rancher Desktop e a VM reiniciada, `readlink` em `node_modules/.bin/*` continuou falhando com `Operation not permitted`.
  - Causa real: a VM do Rancher Desktop rodava com emulação `qemu` e montava `/Users` via `reverse-sshfs` (`fuse.sshfs`), que não resolve symlinks. Confirmado com `rdctl shell mount` e `rdctl list-settings`.
  - Correção: emulação **VZ** e mount type **virtiofs** nas preferências do Rancher Desktop. Com `/Users` montado como `virtiofs`, os scripts rodaram direto pelo npm, sem o contorno via `node`: `npx tsc --noEmit` 0, `npm run lint` 0, `npm test` 53 suítes / 341 testes, `npm run test:e2e` 9 suítes / 96 testes.
  - `nestjs-project/CLAUDE.md` passou a registrar a causa e a correção; o contorno via `node` ficou como alternativa.

## Evidências da entrega (2026-10-07)

- **Status:** done
- **Branch:** `docs/phase-03-evidences`
- **Observations:**
  - `docs/evidences/phase-03-videos/` reúne logs, prints e os scripts que os geraram. O fluxo rodou contra a stack real do Compose, sem mocks. O vídeo de 10 GiB (`Q34hT1nOgiQ`) passou por upload direto ao MinIO (640 partes, 58 s), processamento até `ready`, thumbnail, streaming com Range `206` e download completo de 10 737 418 240 bytes. O caminho de falha (`NO_VIDEO_STREAM`) e a unicidade do `public_id` também estão registrados. O `README.md` da pasta mapeia cada critério do enunciado para o log e o print correspondentes.
  - O print do player usa um vídeo de 60 s em 720p gerado com o FFmpeg do worker, porque a fixture de 10 GiB (ruído sem perdas, ~1,3 Gbit/s) não reproduz em tempo real no navegador.
  - A DoD rodou por último, porque os testes limpam as tabelas: `tsc` 0, lint 0, `npm test` 53 suítes / 341 testes (inclui as 20 suítes / 140 testes de integração), e2e 9 suítes / 96 testes.
