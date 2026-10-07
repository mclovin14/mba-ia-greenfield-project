# Evidências — Fase 03 (vídeos)

Execução real do fluxo de vídeos contra a stack do Docker Compose (API, worker, PostgreSQL, Redis, MinIO e Mailpit), sem mocks, em 2026-10-07. Cada evidência tem um log em texto (`logs/`), gerado pelos scripts desta pasta, e um print (`screenshots/`).

Vídeos usados:

| Vídeo | `public_id` | Uso |
| --- | --- | --- |
| `video-10gib.mp4`: 10 737 418 240 bytes, 1920x1080, 67 s | `Q34hT1nOgiQ` | upload, processamento, thumbnail, streaming e download no limite de 10 GiB |
| `corrompido.mp4`: 6 MiB de bytes `0x41` | `wfASSxRONFY` | caminho de falha do processamento |
| `sample-60s-720p.mp4`: 19,7 MiB, 1280x720, 60 s | `pKJzpghG_Sw` | reprodução no player do navegador |

## Critério → evidência

| Critério do enunciado | Log | Print |
| --- | --- | --- |
| Infraestrutura: API, worker com FFmpeg, PostgreSQL, Redis e MinIO | [00-compose-stack.log](logs/00-compose-stack.log) | [00](screenshots/00-compose-stack.png) |
| Usuário autenticado (cadastro, confirmação por e-mail e login) | [01-auth.log](logs/01-auth.log) | [01](screenshots/01-auth.png) |
| Upload de 10 GB: início, com status `uploading` e o limite aceito | [02-initiate-upload.log](logs/02-initiate-upload.log) | [02](screenshots/02-initiate-upload.png) |
| Upload de 10 GB: 640 partes de 16 MiB enviadas direto ao MinIO por URL presignada (10 GiB em 58 s) | [03-direct-upload.log](logs/03-direct-upload.log) | [03](screenshots/03-direct-upload.png) |
| A API continua respondendo durante o upload, e os bytes do vídeo não passam por ela | [04-api-responsive-during-upload.log](logs/04-api-responsive-during-upload.log) | [04](screenshots/04-api-responsive-during-upload.png) |
| Conclusão do upload (`202`), status `processing` e job enfileirado no BullMQ | [05-complete-and-enqueue.log](logs/05-complete-and-enqueue.log) | [05](screenshots/05-complete-and-enqueue.png) |
| Processamento assíncrono: metadados via ffprobe, thumbnail e status `ready` | [06-processing-ready.log](logs/06-processing-ready.log) | [06](screenshots/06-processing-ready.png) |
| Thumbnail gerada e salva no bucket `thumbnails` | [06-processing-ready.log](logs/06-processing-ready.log), [assets/thumbnail-10gib.jpg](assets/thumbnail-10gib.jpg) | [14](screenshots/14-minio-thumbnails-bucket.png) |
| Arquivo original de 10 GiB no bucket `videos` | — | [13](screenshots/13-minio-videos-bucket.png) |
| Streaming com Range: três requisições, todas `206` (início, meio em 5 GiB e final) | [07-streaming-range.log](logs/07-streaming-range.log) | [07](screenshots/07-streaming-range.png) |
| Streaming no player do navegador | [11-playback-sample.log](logs/11-playback-sample.log) | [11](screenshots/11-playback-sample.png), [12](screenshots/12-streaming-player.png) |
| Download completo: 10 737 418 240 bytes com `Content-Disposition: attachment` | [08-download.log](logs/08-download.log) | [08](screenshots/08-download.png) |
| Ciclo de status no caminho de falha: `failed` com `NO_VIDEO_STREAM` e streaming recusado com `409` | [09-processing-failure.log](logs/09-processing-failure.log) | [09](screenshots/09-processing-failure.png) |
| URL única por vídeo: `public_id` de 11 caracteres com índice `UNIQUE` | [10-unique-url.log](logs/10-unique-url.log) | [10](screenshots/10-unique-url.png) |
| Rotas de vídeo documentadas no Swagger | — | [15](screenshots/15-swagger-videos-routes.png) |
| Definition of Done: `tsc`, lint e testes unitários, de integração e e2e | [16-definition-of-done.log](logs/16-definition-of-done.log) | [16](screenshots/16-definition-of-done.png) |

O ciclo `uploading → processing → ready` do vídeo de 10 GiB aparece nos logs 02, 05 e 06. O ciclo `uploading → processing → failed` aparece no log 09.

## Notas de leitura

**`NET in/out` do `docker stats` (log 04).** Os valores são contadores acumulados desde que o container subiu, não taxas. A evidência está na variação durante o upload:

| Container | `NET in` no início | `NET in` no fim |
| --- | --- | --- |
| API | 5,23 MB | 5,27 MB |
| MinIO | 10,9 GB | 21,6 GB |

O MinIO recebeu os ~10 GiB, e a API recebeu apenas as requisições de controle. O mesmo log traz 25 heartbeats `GET /` feitos a cada 2 s, todos `200`.

**Por que o player usa outro vídeo.** O `video-10gib.mp4` é gerado por [`generate-large-video-fixture.sh`](../../../nestjs-project/scripts/generate-large-video-fixture.sh) com ruído aleatório em H.264 sem perdas, para chegar a 10 GiB com apenas 67 s de duração. A taxa resultante, de ~1,3 Gbit/s, inviabiliza a reprodução em tempo real no navegador. A capacidade de streaming do arquivo de 10 GiB está demonstrada pelas requisições Range do log 07. Para o print do player foi gerado um vídeo de taxa normal com o FFmpeg do próprio worker, e esse vídeo percorreu o mesmo fluxo de upload, processamento e streaming (log 11, prints 11 e 12).

**URLs presignadas.** As assinaturas (`X-Amz-Signature`) aparecem como `…` nos logs. As URLs completas usadas para montar o player ficam em `assets/*-url.txt`, que está no `.gitignore` desta pasta, então nenhuma URL assinada foi versionada.

**Banco após a coleta.** Os testes da DoD rodaram por último porque limpam as tabelas do banco `streamtube`. As linhas do banco citadas nos logs foram registradas antes dessa limpeza. Os objetos no MinIO (prints 13 e 14) permanecem.

## Como reproduzir

Com a stack no ar (`docker compose up -d` em `nestjs-project/`):

```bash
# 1. Fixture de 10 GiB (gitignored)
docker compose -f nestjs-project/docker-compose.yml exec nestjs-api npm run fixtures:large

# 2. API (o CMD do container é `tail -f /dev/null`); o Swagger só é servido com SWAGGER_ENABLED=true
docker compose -f nestjs-project/docker-compose.yml exec -d nestjs-api \
  sh -c 'SWAGGER_ENABLED=true npm run start > /tmp/api.log 2>&1'

# 3. Fluxo completo (logs 01–10) e vídeo para o player (log 11)
node docs/evidences/phase-03-videos/scripts/run-evidence-flow.mjs
node docs/evidences/phase-03-videos/scripts/run-playback-sample.mjs

# 4. Logs em HTML no estilo de terminal (.render/, gitignored), para os prints
node docs/evidences/phase-03-videos/scripts/render-logs.mjs
```

O log 00 foi coletado manualmente com `docker compose ps`, `ps` no worker, `ffprobe -version`, `redis-cli CONFIG GET maxmemory-policy` e a listagem de `/data` no MinIO. Os prints foram feitos com o `playwright-cli` no Chrome, que é necessário para decodificar H.264. Os prints 13 e 14 vêm do console do MinIO (`localhost:9001`), e o 15 vem de `localhost:3000/api/docs`.
