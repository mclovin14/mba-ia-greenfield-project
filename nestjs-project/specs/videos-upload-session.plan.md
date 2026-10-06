---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: test/videos-upload-session.e2e-spec.ts
---

# Upload em andamento (part-urls, parts, cancel) — Test Plan

## Application Overview

Três rotas do dono de um vídeo `uploading` sustentam o upload resumível (TD-02):
- `POST /videos/:publicId/upload/part-urls` emite, em lotes de até 100, URLs presignadas de `UploadPart`, assinadas pelo cliente S3 público (AMB-7), válidas por 3600 s e devolvidas na ordem do request;
- `GET /videos/:publicId/upload/parts` lista as partes já gravadas no storage, para retomar o envio;
- `DELETE /videos/:publicId/upload` cancela: apaga a linha condicionalmente (`status = 'uploading'`), aborta o multipart e apaga o objeto (AMB-4).

Não dono e `publicId` inexistente recebem o mesmo `404 VIDEO_NOT_FOUND`. Um vídeo fora de `uploading` recebe `409 INVALID_UPLOAD_STATE`.

## Test Scenarios

### 1. Emitir URLs presignadas de partes

**Setup:**
- `Test.createTestingModule({ imports: [AppModule] })`, com o `ValidationPipe` e os filtros globais de `main.ts` e `QUEUE_PREFIX = test-{uuid}`;
- `beforeEach`: `cleanAllTables(dataSource)` e `emptyBucket` dos buckets;
- dono criado via `registerConfirmAndLogin`;
- rascunho criado via `POST /videos` com `size_bytes: 20971520` (2 partes de 16 MiB → `part_count = 2`).

#### 1.1. part-urls-ordem-do-request

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-05T20:24:00Z

**Steps:**
  1. POST /videos/:publicId/upload/part-urls com `{ "part_numbers": [2, 1] }`
    - expect: status 200
    - expect: `parts[0].part_number = 2` e `parts[1].part_number = 1`
    - expect: o host de cada `parts[i].url` é o host de `S3_PUBLIC_ENDPOINT`
    - expect: `expires_at` entre agora + 3590 s e agora + 3610 s

#### 1.2. part-urls-fora-do-intervalo

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-05T20:24:00Z

**Steps:**
  1. POST /videos/:publicId/upload/part-urls com `{ "part_numbers": [3] }` (`part_count = 2`)
    - expect: status 400, `error = "PART_NUMBER_OUT_OF_RANGE"`

#### 1.3. part-urls-validacao-do-body

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-05T20:24:00Z

**Steps:**
  1. POST /videos/:publicId/upload/part-urls com `{ "part_numbers": [1, 1] }`
    - expect: status 400, `error = "VALIDATION_ERROR"`
  2. POST /videos/:publicId/upload/part-urls com `part_numbers` de 101 itens (1..101)
    - expect: status 400, `error = "VALIDATION_ERROR"`

### 2. Listar partes enviadas

**Setup:** igual ao grupo 1, mas o rascunho é de `size_bytes: 5242880 + 1024` (2 partes; a primeira com 5 MiB, o mínimo do S3, e a segunda de 1024 bytes).

#### 2.1. parts-reflete-put-real

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-05T20:24:00Z

**Steps:**
  1. POST /videos/:publicId/upload/part-urls com `{ "part_numbers": [1] }`
    - expect: status 200
  2. `requestPresigned(parts[0].url, { method: 'PUT', body: <buffer de 5242880 bytes> })`
    - expect: status 200 com header `ETag`
  3. GET /videos/:publicId/upload/parts
    - expect: status 200 e `parts = [{ part_number: 1, size_bytes: 5242880, etag: <ETag do passo 2> }]`
    - expect: nenhum byte da parte trafegou pela API (o `PUT` foi para o host do storage)

### 3. Cancelar upload

**Setup:** igual ao grupo 1, com 1 parte já enviada via URL presignada.

#### 3.1. cancel-remove-linha-e-upload

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-05T20:24:00Z

**Steps:**
  1. DELETE /videos/:publicId/upload
    - expect: status 204 e corpo vazio
  2. Consultar `videos` pelo `public_id`
    - expect: nenhuma linha
  3. `ListMultipartUploads` no bucket de vídeos
    - expect: nenhum upload com `Key = {id}/original`
  4. DELETE /videos/:publicId/upload de novo
    - expect: status 404, `error = "VIDEO_NOT_FOUND"`

### 4. Autorização, validação de param e estado

**Setup:** igual ao grupo 1, mais um segundo usuário autenticado (não dono).

#### 4.1. rotas-de-upload-nao-dono

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-05T20:24:00Z

**Steps:**
  1. Com o token do não dono: POST part-urls (`{ "part_numbers": [1] }`), GET parts e DELETE upload no `publicId` do dono
    - expect: as três retornam 404 com `error = "VIDEO_NOT_FOUND"`
    - expect: o corpo das três é idêntico ao de um `publicId` inexistente bem formado
  2. Com o token do dono: GET /videos/:publicId/upload/parts
    - expect: status 200 (o rascunho continua intacto)

#### 4.2. rotas-de-upload-public-id-malformado

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-05T20:24:00Z

**Steps:**
  1. POST /videos/abc/upload/part-urls, GET /videos/abc/upload/parts e DELETE /videos/abc/upload com o token do dono
    - expect: as três retornam 400 com `error = "VALIDATION_ERROR"`

#### 4.3. rotas-de-upload-fora-de-uploading

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-05T20:24:00Z

**Steps:**
  1. Mover o rascunho para `processing` direto no banco (`UPDATE videos SET status = 'processing', upload_id = NULL`)
  2. POST part-urls, GET parts e DELETE upload com o token do dono
    - expect: as três retornam 409 com `error = "INVALID_UPLOAD_STATE"`
    - expect: a linha continua existindo em `processing` (o DELETE não a removeu)

#### 4.4. rotas-de-upload-sem-token

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-05T20:24:00Z

**Steps:**
  1. As três rotas sem header `Authorization`
    - expect: as três retornam 401
