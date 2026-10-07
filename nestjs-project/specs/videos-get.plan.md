---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.10
target_file: test/videos-get.e2e-spec.ts
---

# GET /videos/:publicId — Test Plan

## Application Overview

`GET /videos/:publicId` é a leitura do dono. Devolve status (para polling de `processing → ready | failed`), metadados extraídos pelo worker (AMB-2) e, só quando `ready`, `thumbnail_url`: um GET presignado do `{id}/thumbnail.jpg`, com 900 s de validade, assinado pelo cliente público e com `ResponseContentType: image/jpeg` (AMB-8). Não dono e `publicId` inexistente recebem o mesmo `404 VIDEO_NOT_FOUND`, com corpo idêntico (AMB-6).

## Test Scenarios

### 1. Ler o vídeo próprio em cada estado

**Setup:**
- `Test.createTestingModule({ imports: [AppModule] })`, com o `ValidationPipe` e os filtros globais de `main.ts` e `QUEUE_PREFIX = test-{uuid}`;
- `beforeEach`: `cleanAllTables(dataSource)`, `emptyBucket` dos buckets e `obliterate` da fila de teste;
- dono via `registerConfirmAndLogin`;
- vídeo levado até `processing` pelo fluxo real da API: `POST /videos` com a fixture `mp4-with-audio` (SI-03.8), `PUT` da parte única via URL presignada e `POST complete`;
- o estado final de cada cenário é semeado com serviços reais, sem worker (o caminho pelo worker é coberto pelo SI-03.12):
  - `ready`: `StorageService.putObject('thumbnails', videoThumbnailKey(id), <jpeg>, 'image/jpeg')` seguido de `VideosService.markReady(id, <metadados do probe real da fixture>)`;
  - `failed`: `VideosService.markFailed(id, 'NO_VIDEO_STREAM')`.

#### 1.1. get-video-ready-com-thumbnail

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-07T15:32:23Z

**Steps:**
  1. Semear o estado `ready`; GET /videos/:publicId com o token do dono
    - expect: status 200 e `status = "ready"`
    - expect: `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec` e `container_format` não nulos e `processing_error = null`
    - expect: o host de `thumbnail_url` é o de `S3_PUBLIC_ENDPOINT`
    - expect: o corpo não tem `id`, `channel_id` nem `upload_id`
  2. `requestPresigned(thumbnail_url, { method: 'GET' })`
    - expect: status 200, `Content-Type: image/jpeg` e corpo começando com os bytes `FF D8 FF`

#### 1.2. get-video-processing

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-07T15:32:23Z

**Steps:**
  1. Sem semear estado final (o vídeo está `processing`), GET /videos/:publicId
    - expect: status 200, `status = "processing"` e `thumbnail_url = null`

#### 1.3. get-video-failed

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-07T15:32:23Z

**Steps:**
  1. Semear o estado `failed`; GET /videos/:publicId
    - expect: status 200, `status = "failed"`, `processing_error = "NO_VIDEO_STREAM"` e `thumbnail_url = null`

### 2. Autorização e validação

**Setup:** igual ao grupo 1, mais um segundo usuário autenticado (não dono).

#### 2.1. get-nao-dono-indistinguivel-de-inexistente

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-07T15:32:23Z

**Steps:**
  1. GET /videos/:publicId do dono com o token do não dono
    - expect: status 404 e `error = "VIDEO_NOT_FOUND"`
  2. GET /videos/AAAAAAAAAAA (bem formado, inexistente) com o token do não dono
    - expect: status 404 e corpo idêntico, byte a byte, ao do passo 1

#### 2.2. get-public-id-malformado

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-07T15:32:23Z

**Steps:**
  1. GET /videos/abc com o token do dono
    - expect: status 400 e `error = "VALIDATION_ERROR"`

#### 2.3. get-sem-token

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-07T15:32:23Z

**Steps:**
  1. GET /videos/:publicId sem header `Authorization`
    - expect: status 401
