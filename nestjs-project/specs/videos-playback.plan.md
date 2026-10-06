---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.11
target_file: test/videos-playback.e2e-spec.ts
---

# GET /videos/:publicId/stream e /download — Test Plan

## Application Overview

Duas rotas do dono entregam URLs presignadas de `GetObject` sobre `{id}/original`, assinadas pelo cliente S3 público (TD-07). O navegador busca os bytes direto no storage; a API nunca trafega conteúdo de vídeo:
- `/stream` vale 6 h e força `Content-Type = mime_type`, para o `<video>` fazer requisições HTTP Range (206);
- `/download` vale 15 min e força `Content-Disposition: attachment; filename="{safe}"; filename*=UTF-8''{encoded}` (RFC 8187).

Um vídeo fora de `ready` recebe `409 VIDEO_NOT_READY`. Não dono e `publicId` inexistente recebem `404 VIDEO_NOT_FOUND`.

## Test Scenarios

### 1. Streaming e download de vídeo pronto

**Setup:**
- `Test.createTestingModule({ imports: [AppModule] })`, com o `ValidationPipe` e os filtros globais de `main.ts` e `QUEUE_PREFIX = test-{uuid}`;
- `beforeEach`: `cleanAllTables(dataSource)`, `emptyBucket` dos buckets e `obliterate` da fila de teste;
- dono via `registerConfirmAndLogin`;
- vídeo levado até `processing` pelo fluxo real (`POST /videos` com a fixture `mp4-with-audio`, `PUT` da parte, `POST complete`) e depois `ready` via `StorageService.putObject` do thumbnail + `VideosService.markReady` (sem worker; o caminho pelo worker é coberto pelo SI-03.12).

#### 1.1. stream-url-com-range

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-05T20:24:00Z

**Steps:**
  1. GET /videos/:publicId/stream com o token do dono
    - expect: status 200, o host de `url` é o de `S3_PUBLIC_ENDPOINT`, `expires_at` entre agora + 21590 s e agora + 21610 s
  2. `requestPresigned(url, { method: 'GET', headers: { Range: 'bytes=0-1023' } })`
    - expect: status 206
    - expect: `Content-Range: bytes 0-1023/{size_bytes}` e corpo de 1024 bytes iguais aos primeiros 1024 da fixture
    - expect: `Content-Type: video/mp4`

#### 1.2. download-url-com-attachment

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-05T20:24:00Z

**Steps:**
  1. GET /videos/:publicId/download com o token do dono
    - expect: status 200 e `expires_at` entre agora + 890 s e agora + 910 s
  2. `requestPresigned(url, { method: 'GET' })`
    - expect: status 200, com `Content-Disposition` começando por `attachment;`
    - expect: corpo byte a byte igual à fixture enviada (mesmo SHA-256)

#### 1.3. download-nome-nao-ascii

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-05T20:24:00Z

**Steps:**
  1. O rascunho é criado com `filename: "aula 1 — introdução (parte 'a').mp4"` e levado a `ready` como no setup
  2. GET /videos/:publicId/download e `GET` na `url`
    - expect: `Content-Disposition` contém `filename="aula 1 _ introdu__o _parte _a__.mp4"` (só `[A-Za-z0-9._ -]` literais)
    - expect: `Content-Disposition` contém `filename*=UTF-8''`, e decodificar o valor depois do delimitador com `decodeURIComponent` devolve exatamente o `filename` original
    - expect: nenhum `'` literal aparece depois de `UTF-8''`

### 2. Vídeo ainda não pronto

**Setup:** igual ao grupo 1, sem semear `ready`.

#### 2.1. stream-e-download-de-video-processing

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-05T20:24:00Z

**Steps:**
  1. Com o vídeo em `processing`: GET /stream e GET /download
    - expect: os dois retornam 409 com `error = "VIDEO_NOT_READY"`

#### 2.2. stream-e-download-de-video-failed

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-05T20:24:00Z

**Steps:**
  1. `VideosService.markFailed(id, 'NO_VIDEO_STREAM')`; GET /stream e GET /download
    - expect: os dois retornam 409 com `error = "VIDEO_NOT_READY"`

### 3. Autorização e validação

**Setup:** igual ao grupo 1 (vídeo `ready`), mais um segundo usuário autenticado (não dono).

#### 3.1. playback-nao-dono

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-05T20:24:00Z

**Steps:**
  1. GET /stream e GET /download no `publicId` do dono com o token do não dono
    - expect: os dois retornam 404 com `error = "VIDEO_NOT_FOUND"`

#### 3.2. playback-sem-token-e-param-malformado

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-05T20:24:00Z

**Steps:**
  1. GET /stream e GET /download sem header `Authorization`
    - expect: os dois retornam 401
  2. GET /videos/abc/stream e GET /videos/abc/download com o token do dono
    - expect: os dois retornam 400 com `error = "VALIDATION_ERROR"`
