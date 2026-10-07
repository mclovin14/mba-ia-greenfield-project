---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: test/videos-upload-complete.e2e-spec.ts
---

# POST /videos/:publicId/upload/complete — Test Plan

## Application Overview

`POST /videos/:publicId/upload/complete` encerra o upload multipart. Em ordem:
1. Monta a lista de partes a partir de `ListParts`; o cliente não envia ETags.
2. Exige o conjunto completo `{1..part_count}`.
3. Chama `CompleteMultipartUpload`.
4. Reconfere o tamanho real com `HeadObject` (teto de 10 GiB, AMB-3).
5. Move o vídeo de `uploading` para `processing` com um update condicional.
6. Publica `process-video` com `jobId = video-{id}` deduplicado (TD-03).

Repetir o complete com o vídeo em `processing` é idempotente: devolve 202 e não cria job novo. Um vídeo `ready` ou `failed` recebe 409.

## Test Scenarios

### 1. Concluir upload e enfileirar processamento

**Setup:**
- `Test.createTestingModule({ imports: [AppModule] })`, com o `ValidationPipe` e os filtros globais de `main.ts` e `QUEUE_PREFIX = test-{uuid}`. O prefixo garante que o `video-worker` do compose não consuma os jobs;
- `beforeEach`: `cleanAllTables(dataSource)`, `emptyBucket` dos buckets e `queue.obliterate({ force: true })` da fila de teste;
- dono via `registerConfirmAndLogin`;
- rascunho criado via `POST /videos` com `size_bytes: 5242880 + 1024`, com 2 partes enviadas por URLs presignadas (`requestPresigned`).

#### 1.1. complete-move-para-processing-e-enfileira

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-10-05T20:24:00Z

**Steps:**
  1. POST /videos/:publicId/upload/complete, sem body
    - expect: status 202, `status = "processing"`, `size_bytes = 5243904` e `thumbnail_url = null`
  2. Ler a linha de `videos`
    - expect: `status = 'processing'`, `upload_id = NULL` e `size_bytes = 5243904`
  3. `HeadObject` em `{id}/original`
    - expect: `ContentLength = 5243904`
  4. Inspecionar a fila `video-processing` (prefixo de teste)
    - expect: exatamente um job, com `name = "process-video"`, `id = "video-{id}"` e `data = { videoId: <id> }`

#### 1.2. complete-repetido-e-idempotente

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-05T20:24:00Z

**Steps:**
  1. POST complete
    - expect: status 202
  2. POST complete de novo no mesmo `publicId`
    - expect: status 202, `status = "processing"`
  3. Contar os jobs da fila para `video-{id}`
    - expect: exatamente 1

### 2. Upload incompleto e estados inválidos

**Setup:** igual ao grupo 1, com variações de partes enviadas por cenário.

#### 2.1. complete-com-parte-faltando

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-05T20:24:00Z

**Steps:**
  1. Enviar só a parte 1 de 2 e chamar POST complete
    - expect: status 409, `error = "UPLOAD_INCOMPLETE"`
  2. Ler a linha e GET /videos/:publicId/upload/parts
    - expect: `status = 'uploading'`, `upload_id` inalterado, parts lista a parte 1 (o upload continua retomável)
  3. Enviar a parte 2 e chamar POST complete
    - expect: status 202 (a retomada funciona)

#### 2.2. complete-com-parte-nao-final-pequena

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-05T20:24:00Z

**Steps:**
  1. Rascunho com `size_bytes: 2048` declarado em 2 partes não é possível (o `part_count` é 1). Por isso o rascunho tem `size_bytes: 16777217` (`part_count = 2`) e a parte 1 é enviada com só 1024 bytes, abaixo dos 5 MiB mínimos, junto com a parte 2
  2. POST complete
    - expect: status 409, `error = "UPLOAD_INCOMPLETE"` (S3 `EntityTooSmall` mapeado, não 503)
    - expect: o vídeo continua `uploading`

#### 2.3. complete-de-video-ready-ou-failed

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-05T20:24:00Z

**Steps:**
  1. Mover o vídeo para `ready` direto no banco e chamar POST complete
    - expect: status 409, `error = "INVALID_UPLOAD_STATE"`
  2. Mover o vídeo para `failed` (`processing_error = 'PROCESSING_FAILED'`) e chamar POST complete
    - expect: status 409, `error = "INVALID_UPLOAD_STATE"`
    - expect: a fila continua sem jobs para o vídeo

### 3. Teto de tamanho

**Setup:** igual ao grupo 1.

#### 3.1. complete-acima-do-teto

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-05T20:24:00Z

**Steps:**
  1. Este cenário não monta 10 GiB no e2e (isso é o SI-03.13). Ele exercita o mesmo ramo HTTP com o teto rebaixado: o módulo de teste usa `overrideProvider` para substituir apenas o valor de `VIDEO_MAX_SIZE_BYTES` por 5242880. Se a constante não for injetável, o cenário é coberto pela suíte de 10 GiB (`test/videos-10gib.large-spec.ts`) e este passo é removido na implementação
  2. Enviar as 2 partes (5243904 bytes > 5242880) e chamar POST complete
    - expect: status 422, `error = "VIDEO_FILE_TOO_LARGE"`
  3. Ler a linha e fazer `HeadObject` em `{id}/original`
    - expect: `status = 'failed'`, `processing_error = 'FILE_TOO_LARGE'`, `upload_id = NULL`
    - expect: o objeto não existe no storage (404 no `HeadObject`)
    - expect: nenhum job na fila

### 4. Autorização e validação de param

**Setup:** igual ao grupo 1, mais um segundo usuário autenticado (não dono).

#### 4.1. complete-nao-dono

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-10-05T20:24:00Z

**Steps:**
  1. POST complete no `publicId` do dono com o token do não dono
    - expect: status 404, `error = "VIDEO_NOT_FOUND"`
  2. Ler a linha, `ListMultipartUploads` e a fila
    - expect: vídeo ainda `uploading` com `upload_id`, multipart ainda aberto e nenhum job

#### 4.2. complete-param-e-token

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-10-05T20:24:00Z

**Steps:**
  1. POST /videos/abc/upload/complete com o token do dono
    - expect: status 400, `error = "VALIDATION_ERROR"`
  2. POST complete sem header `Authorization`
    - expect: status 401
