#!/usr/bin/env node
// Runs the Fase 03 flow end to end against the running Compose stack (no
// mocks) and writes one log per evidence into ../logs/.
//
// Usage (from the repository root, with `docker compose up -d` in nestjs-project):
//   node docs/evidences/phase-03-videos/scripts/run-evidence-flow.mjs
//
// Requirements: nestjs-project/.large-fixtures/video-10gib.mp4
// (`npm run fixtures:large` inside the nestjs-api container).

import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  LOGS,
  ASSETS,
  FIXTURE,
  API,
  SIZE_LIMIT,
  CONCURRENCY,
  now,
  fmtBytes,
  pretty,
  writeLog,
  psql,
  redis,
  api,
  putPart,
  getCounting,
  runPool,
  registerConfirmAndLogin,
  waitUntilSettled,
  startHeartbeat,
  apiContainerStats,
} from './lib.mjs';

async function main() {
  await mkdir(LOGS, { recursive: true });
  await mkdir(ASSETS, { recursive: true });
  const size = (await stat(FIXTURE)).size;
  if (size !== SIZE_LIMIT) throw new Error(`Fixture must be ${SIZE_LIMIT} bytes, got ${size}`);

  const runId = Date.now();
  const email = `evidence_${runId}@example.com`;

  // 01 — auth
  const auth = await registerConfirmAndLogin(email);
  const token = auth.accessToken;
  await writeLog('01-auth.log', [`# ${now()}  usuário ${email}`, ...auth.lines]);

  // 02 — initiate: draft pre-registered as `uploading`
  const init = await api('POST', '/videos', {
    token,
    body: {
      filename: 'video-10gib.mp4',
      mime_type: 'video/mp4',
      size_bytes: SIZE_LIMIT,
      title: 'Evidência — vídeo de 10 GiB',
    },
  });
  const video = init.body.video;
  const publicId = video.public_id;
  await writeLog('02-initiate-upload.log', [
    `# ${now()}  POST /videos  (${SIZE_LIMIT} bytes = 10 GiB)`,
    `HTTP ${init.status}`,
    pretty(init.body),
    '',
    '# Linha criada no banco ao iniciar o upload (rascunho = uploading)',
    psql(
      `SELECT public_id, title, status, size_bytes, original_key, upload_id IS NOT NULL AS has_upload_id FROM videos WHERE public_id = '${publicId}';`,
    ),
  ]);

  // 03 — direct multipart upload to MinIO via presigned URLs
  const { part_size_bytes, part_count, max_part_urls_per_request } = init.body.upload;
  const statsBefore = apiContainerStats();
  const stopHeartbeat = startHeartbeat();
  const uploadLines = [];
  const uploadStarted = Date.now();
  let done = 0;
  let sampleUrl;
  const numbers = Array.from({ length: part_count }, (_, i) => i + 1);
  const statsDuring = [];
  for (let i = 0; i < numbers.length; i += max_part_urls_per_request) {
    const batch = numbers.slice(i, i + max_part_urls_per_request);
    const urls = await api('POST', `/videos/${publicId}/upload/part-urls`, {
      token,
      body: { part_numbers: batch },
    });
    sampleUrl ??= urls.body.parts[0].url;
    uploadLines.push(
      `POST /videos/${publicId}/upload/part-urls  partes ${batch[0]}..${batch.at(-1)} -> ${urls.status}`,
    );
    await runPool(urls.body.parts, CONCURRENCY, async (part) => {
      const start = (part.part_number - 1) * part_size_bytes;
      const end = Math.min(start + part_size_bytes, SIZE_LIMIT) - 1;
      const put = await putPart(part.url, FIXTURE, start, end);
      if (put.status !== 200) throw new Error(`part ${part.part_number}: ${put.status}`);
      done++;
    });
    const elapsed = (Date.now() - uploadStarted) / 1000;
    uploadLines.push(
      `  PUT direto no MinIO: ${done}/${part_count} partes  ${fmtBytes(Math.min(done * part_size_bytes, SIZE_LIMIT))}  ${elapsed.toFixed(0)} s`,
    );
    statsDuring.push(...apiContainerStats().map((l) => `${now()}  ${l}`));
  }
  const uploadSeconds = (Date.now() - uploadStarted) / 1000;
  const heartbeat = await stopHeartbeat();
  const latencies = heartbeat.map((s) => s.ms);
  const okBeats = heartbeat.filter((s) => s.status === 200).length;

  const listed = await api('GET', `/videos/${publicId}/upload/parts`, { token });
  const storedBytes = listed.body.parts.reduce((a, p) => a + p.size_bytes, 0);

  await writeLog('03-direct-upload.log', [
    `# ${now()}  Upload multipart direto ao storage (${part_count} partes de ${part_size_bytes} bytes, ${CONCURRENCY} em paralelo)`,
    `# As URLs são presignadas e apontam para o MinIO; os bytes do vídeo não passam pela API.`,
    `Exemplo de URL de parte: ${sampleUrl.replace(/X-Amz-Signature=[^&]+/, 'X-Amz-Signature=…')}`,
    '',
    ...uploadLines,
    '',
    `Total: ${fmtBytes(SIZE_LIMIT)} em ${uploadSeconds.toFixed(0)} s (${(SIZE_LIMIT / 1024 ** 2 / uploadSeconds).toFixed(0)} MiB/s)`,
    '',
    `GET /videos/${publicId}/upload/parts -> ${listed.status}`,
    `  partes armazenadas: ${listed.body.parts.length}   soma: ${storedBytes} bytes`,
  ]);

  await writeLog('04-api-responsive-during-upload.log', [
    `# ${now()}  GET / na API a cada 2 s durante o upload de 10 GiB`,
    `amostras: ${heartbeat.length}   HTTP 200: ${okBeats}   falhas: ${heartbeat.length - okBeats}`,
    `latência (ms): min ${Math.min(...latencies)}   média ${(latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(1)}   máx ${Math.max(...latencies)}`,
    '',
    '# Primeiras e últimas amostras',
    ...heartbeat.slice(0, 5).map((s) => `${s.at}  HTTP ${s.status}  ${s.ms} ms`),
    '…',
    ...heartbeat.slice(-5).map((s) => `${s.at}  HTTP ${s.status}  ${s.ms} ms`),
    '',
    '# docker stats antes do upload',
    ...statsBefore,
    '',
    '# docker stats durante o upload: o NET in da API fica em MB enquanto o do MinIO cresce até ~10 GB',
    '# (os bytes do vídeo vão do cliente direto ao MinIO, sem passar pela API)',
    ...statsDuring,
  ]);

  // 05 — complete: status flips to processing and the job is enqueued
  const complete = await api('POST', `/videos/${publicId}/upload/complete`, { token });
  const internalId = psql(`SELECT id FROM videos WHERE public_id = '${publicId}';`)
    .split('\n')[2]
    .trim();
  const jobKey = `bull:video-processing:video-${internalId}`;
  const jobRightAfter = redis('HGETALL', jobKey);
  const timeline = [`${now()}  status = ${complete.body.status} (resposta do complete)`];
  await writeLog('05-complete-and-enqueue.log', [
    `# ${now()}  POST /videos/${publicId}/upload/complete`,
    `HTTP ${complete.status}`,
    pretty(complete.body),
    '',
    '# Banco logo após o complete',
    psql(`SELECT public_id, status, size_bytes, upload_id FROM videos WHERE public_id = '${publicId}';`),
    `# Job na fila BullMQ (Redis): ${jobKey}`,
    jobRightAfter,
  ]);

  // 06 — worker processes: metadata + thumbnail, status -> ready
  const ready = await waitUntilSettled(token, publicId, timeline);
  const thumb = await fetch(ready.thumbnail_url);
  const thumbBytes = Buffer.from(await thumb.arrayBuffer());
  await writeFile(join(ASSETS, 'thumbnail-10gib.jpg'), thumbBytes);
  await writeLog('06-processing-ready.log', [
    `# ${now()}  Linha do tempo do status (polling de GET /videos/${publicId})`,
    ...timeline,
    '',
    `# GET /videos/${publicId}`,
    pretty({ ...ready, thumbnail_url: ready.thumbnail_url.replace(/X-Amz-Signature=[^&]+/, 'X-Amz-Signature=…') }),
    '',
    `# Thumbnail via thumbnail_url -> HTTP ${thumb.status}, ${thumb.headers.get('content-type')}, ${thumbBytes.length} bytes (assets/thumbnail-10gib.jpg)`,
    '',
    '# Banco após o processamento',
    psql(
      `SELECT public_id, status, duration_seconds, width, height, video_codec, audio_codec, container_format, thumbnail_key, processing_error FROM videos WHERE public_id = '${publicId}';`,
    ),
    `# Job concluído na fila (${jobKey})`,
    (() => {
      const fields = ['name', 'data', 'attemptsMade', 'processedOn', 'finishedOn', 'failedReason'];
      const values = redis('HMGET', jobKey, ...fields).split('\n');
      return fields.map((f, i) => `${f.padEnd(13)} ${values[i] || '(vazio)'}`).join('\n');
    })(),
    `# Chaves no storage: videos/${internalId}/original e thumbnails/${internalId}/thumbnail.jpg`,
  ]);

  // 07 — streaming: presigned URL answered with 206 Partial Content
  const stream = await api('GET', `/videos/${publicId}/stream`, { token });
  const first = await getCounting(stream.body.url, { range: 'bytes=0-1023' });
  const middle = await getCounting(stream.body.url, { range: 'bytes=5368709120-5369757695' });
  const tail = await getCounting(stream.body.url, { range: 'bytes=-1024' });
  const rangeLine = (label, r) =>
    `${label}: HTTP ${r.status}  Content-Range: ${r.headers['content-range']}  Content-Length: ${r.headers['content-length']}  Content-Type: ${r.headers['content-type']}  Accept-Ranges: ${r.headers['accept-ranges']}  (${r.ms} ms)`;
  await writeLog('07-streaming-range.log', [
    `# ${now()}  GET /videos/${publicId}/stream`,
    `HTTP ${stream.status}`,
    pretty({ ...stream.body, url: stream.body.url.replace(/X-Amz-Signature=[^&]+/, 'X-Amz-Signature=…') }),
    '',
    '# Requisições com Range direto na URL presignada (sem baixar o arquivo inteiro)',
    rangeLine('Range bytes=0-1023          ', first),
    rangeLine('Range bytes=5 GiB..+1 MiB   ', middle),
    rangeLine('Range bytes=-1024 (final)   ', tail),
    `Primeiros bytes (ftyp do MP4): ${first.head.subarray(4, 12).toString('latin1')}`,
  ]);
  await writeFile(join(ASSETS, 'stream-url.txt'), stream.body.url);

  // 08 — download: attachment disposition, full 10 GiB body
  const download = await api('GET', `/videos/${publicId}/download`, { token });
  const full = await getCounting(download.body.url);
  await writeLog('08-download.log', [
    `# ${now()}  GET /videos/${publicId}/download`,
    `HTTP ${download.status}`,
    pretty({ ...download.body, url: download.body.url.replace(/X-Amz-Signature=[^&]+/, 'X-Amz-Signature=…') }),
    '',
    '# Download completo pela URL presignada (corpo descartado, bytes contados)',
    `HTTP ${full.status}`,
    `Content-Disposition: ${full.headers['content-disposition']}`,
    `Content-Length: ${full.headers['content-length']}`,
    `Bytes recebidos: ${full.bytes} (${fmtBytes(full.bytes)}) em ${(full.ms / 1000).toFixed(0)} s`,
    `Igual ao arquivo original: ${full.bytes === SIZE_LIMIT ? 'sim' : 'NÃO'}`,
  ]);

  // 09 — failure path: a non-video file ends as `failed`
  const bad = await api('POST', '/videos', {
    token,
    body: { filename: 'corrompido.mp4', mime_type: 'video/mp4', size_bytes: 6 * 1024 * 1024, title: 'Evidência — arquivo inválido' },
  });
  const badId = bad.body.video.public_id;
  const badUrls = await api('POST', `/videos/${badId}/upload/part-urls`, { token, body: { part_numbers: [1] } });
  const garbage = Buffer.alloc(6 * 1024 * 1024, 0x41);
  const garbagePath = join(ASSETS, '..', '.garbage.bin');
  await writeFile(garbagePath, garbage);
  const badPut = await putPart(badUrls.body.parts[0].url, garbagePath, 0, garbage.length - 1);
  const badComplete = await api('POST', `/videos/${badId}/upload/complete`, { token });
  const badTimeline = [`${now()}  status = ${badComplete.body.status} (resposta do complete)`];
  const failed = await waitUntilSettled(token, badId, badTimeline);
  const badStream = await api('GET', `/videos/${badId}/stream`, { token });
  await writeLog('09-processing-failure.log', [
    `# ${now()}  Arquivo que não é vídeo (6 MiB de bytes 0x41) enviado como video/mp4`,
    `POST /videos -> ${bad.status} (status ${bad.body.video.status})`,
    `PUT parte 1 no MinIO -> ${badPut.status}`,
    `POST /videos/${badId}/upload/complete -> ${badComplete.status}`,
    ...badTimeline,
    '',
    `# GET /videos/${badId}`,
    pretty(failed),
    '',
    `# GET /videos/${badId}/stream em vídeo com falha -> HTTP ${badStream.status}`,
    pretty(badStream.body),
    '',
    '# Banco',
    psql(`SELECT public_id, status, processing_error, thumbnail_key FROM videos WHERE public_id = '${badId}';`),
  ]);
  await rm(garbagePath);

  // 10 — unique URL: public_id is generated per video and backed by a UNIQUE index
  const drafts = [];
  for (let i = 0; i < 5; i++) {
    const d = await api('POST', '/videos', {
      token,
      body: { filename: `rascunho-${i}.mp4`, mime_type: 'video/mp4', size_bytes: 1024 },
    });
    drafts.push(d.body.video);
  }
  for (const d of drafts) await api('DELETE', `/videos/${d.public_id}/upload`, { token });
  await writeLog('10-unique-url.log', [
    `# ${now()}  public_id gerado para 5 rascunhos criados em sequência (depois cancelados)`,
    ...drafts.map((d) => `POST /videos -> public_id ${d.public_id}   título default "${d.title}"`),
    `Distintos: ${new Set(drafts.map((d) => d.public_id)).size}/${drafts.length}`,
    '',
    '# Unicidade garantida no banco (índice UNIQUE em public_id)',
    psql(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'videos';`),
    psql(`SELECT count(*) AS videos, count(DISTINCT public_id) AS public_ids_distintos FROM videos;`),
    '# A URL do vídeo usa só o public_id; o id interno (uuid) nunca é exposto',
    `Vídeo de 10 GiB: /videos/${publicId}`,
  ]);

  await writeFile(
    join(LOGS, 'run.json'),
    pretty({ runId, email, publicId, failedPublicId: badId, finishedAt: now() }),
  );
  console.log('\nOK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
