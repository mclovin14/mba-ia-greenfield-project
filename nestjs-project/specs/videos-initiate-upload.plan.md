---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.5.2
target_file: test/videos-initiate-upload.e2e-spec.ts
---

# POST /videos — Test Plan

## Application Overview

`POST /videos` inicia o upload de um vídeo numa única chamada autenticada:
- resolve o canal do chamador;
- pré-cadastra um rascunho `uploading` com `public_id` de 11 caracteres e título default derivado do nome do arquivo (AMB-1);
- abre um multipart upload no MinIO em `{id}/original`;
- devolve ao cliente o plano de partes (16 MiB cada, até 640) para enviar os bytes direto ao storage (AMB-3).

O body é validado pelo `ValidationPipe` global: allowlist de MIME e teto de 10 GiB. A rota fica fora do throttler (`@SkipThrottle()`) e nunca serializa `id`, `channel_id` ou `upload_id`.

## Test Scenarios

### 1. Iniciar upload e pré-cadastrar rascunho

**Setup:**
- `Test.createTestingModule({ imports: [AppModule] })`, com o `ValidationPipe` e os filtros globais de `main.ts` reproduzidos e `QUEUE_PREFIX = test-{uuid}`;
- `beforeEach`: `cleanAllTables(dataSource)`, `emptyBucket` dos buckets de vídeos e thumbnails e `throttlerStorage.storage.clear()`;
- usuário criado por register → confirm → login (helper `registerConfirmAndLogin`), o que cria o canal dele.

#### 1.1. initiate-cria-rascunho-e-plano-de-partes

**Covers AC:** #1, #7
**Source:** auto
**Last sync:** 2026-10-07T15:32:23Z

**Steps:**
  1. POST /videos com `Authorization: Bearer {access_token}` e body `{ "filename": "aula.mp4", "mime_type": "video/mp4", "size_bytes": 50000000 }`
    - expect: status 201
    - expect: `video.status = "uploading"`, `video.title = "aula"`, `video.thumbnail_url = null`, `video.public_id` casa `^[A-Za-z0-9_-]{11}$`
    - expect: `upload.part_size_bytes = 16777216`, `upload.part_count = 3`, `upload.max_part_urls_per_request = 100`
    - expect: o corpo não tem as chaves `id`, `video.id`, `video.channel_id` nem `video.upload_id`

#### 1.2. initiate-abre-multipart-no-storage

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-07T15:32:23Z

**Steps:**
  1. POST /videos com body válido e token válido
    - expect: status 201
  2. Ler a linha de `videos` pelo `public_id` retornado
    - expect: `upload_id` não nulo e `status = 'uploading'`
  3. `ListMultipartUploads` no bucket de vídeos via `StorageService`/cliente S3 interno
    - expect: existe um upload com `Key = {id}/original` e `UploadId` igual ao `upload_id` persistido

#### 1.3. initiate-titulo-explicito

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-07T15:32:23Z

**Steps:**
  1. POST /videos com `{ "filename": "aula.mp4", "mime_type": "video/mp4", "size_bytes": 1, "title": "  Minha aula  " }`
    - expect: status 201, `video.title = "Minha aula"` (trim aplicado) e `upload.part_count = 1`

### 2. Validação e autenticação

**Setup:** igual ao grupo 1.

#### 2.1. initiate-rejeita-mime-fora-da-allowlist

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-07T15:32:23Z

**Steps:**
  1. POST /videos com `mime_type: "application/pdf"` e o restante válido
    - expect: status 400, `error = "VALIDATION_ERROR"`
    - expect: nenhuma linha em `videos` e nenhum multipart aberto no storage

#### 2.2. initiate-rejeita-tamanho-acima-do-teto

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-07T15:32:23Z

**Steps:**
  1. POST /videos com `size_bytes: 10737418241`
    - expect: status 400, `error = "VALIDATION_ERROR"`
  2. POST /videos com `size_bytes: 10737418240`
    - expect: status 201, `upload.part_count = 640` (o limite exato é aceito)

#### 2.3. initiate-rejeita-propriedade-desconhecida

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-07T15:32:23Z

**Steps:**
  1. POST /videos com body válido mais `"channel_id": "qualquer"`
    - expect: status 400, `error = "VALIDATION_ERROR"` (`forbidNonWhitelisted`)

#### 2.4. initiate-sem-token

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-07T15:32:23Z

**Steps:**
  1. POST /videos sem header `Authorization`, com body válido
    - expect: status 401
    - expect: nenhuma linha em `videos`

#### 2.5. initiate-usuario-sem-canal

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-07T15:32:23Z

**Steps:**
  1. Criar e autenticar um usuário e então remover a linha dele em `channels` direto no banco
  2. POST /videos com body válido e o token desse usuário
    - expect: status 404, `error = "CHANNEL_NOT_FOUND"`
    - expect: nenhuma linha em `videos` e nenhum multipart aberto no storage

### 3. Throttling

**Setup:** igual ao grupo 1. O throttler global fica ativo, com a configuração real de `AppModule`.

#### 3.1. initiate-fora-do-throttler

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-07T15:32:23Z

**Steps:**
  1. POST /videos 15 vezes em sequência, com o mesmo token e body válido (`size_bytes: 1`)
    - expect: todas as 15 respostas são 201 e nenhuma é 429
