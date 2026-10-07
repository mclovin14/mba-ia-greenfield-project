#!/usr/bin/env node
// Uploads a regular-bitrate sample video through the same Fase 03 flow and
// keeps its stream URL for the browser playback screenshot. The 10 GiB
// fixture is random noise at ~1.2 Gbit/s: valid for the size limit and Range
// requests, but no browser decodes it in real time.
//
// Usage (from the repository root, with the Compose stack and the API up):
//   node docs/evidences/phase-03-videos/scripts/run-playback-sample.mjs

import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ASSETS,
  CONCURRENCY,
  LOGS,
  NEST_DIR,
  api,
  compose,
  now,
  pretty,
  psql,
  putPart,
  registerConfirmAndLogin,
  runPool,
  waitUntilSettled,
  writeLog,
} from './lib.mjs';

const SAMPLE = 'sample-60s-720p.mp4';
const SAMPLE_PATH = join(NEST_DIR, '.large-fixtures', SAMPLE);

async function main() {
  await mkdir(LOGS, { recursive: true });
  await mkdir(ASSETS, { recursive: true });

  // Encoded inside the worker container, whose FFmpeg is the one the phase uses.
  compose(
    'exec', '-T', 'video-worker', 'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=60',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=60',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '23',
    '-c:a', 'aac', '-movflags', '+faststart',
    `.large-fixtures/${SAMPLE}`,
  );
  const size = (await stat(SAMPLE_PATH)).size;

  const { accessToken: token } = await registerConfirmAndLogin(`playback_${Date.now()}@example.com`);
  const init = await api('POST', '/videos', {
    token,
    body: { filename: SAMPLE, mime_type: 'video/mp4', size_bytes: size, title: 'Evidência — reprodução no navegador' },
  });
  const publicId = init.body.video.public_id;
  const { part_size_bytes, part_count } = init.body.upload;

  const numbers = Array.from({ length: part_count }, (_, i) => i + 1);
  const urls = await api('POST', `/videos/${publicId}/upload/part-urls`, { token, body: { part_numbers: numbers } });
  await runPool(urls.body.parts, CONCURRENCY, async (part) => {
    const start = (part.part_number - 1) * part_size_bytes;
    const end = Math.min(start + part_size_bytes, size) - 1;
    const put = await putPart(part.url, SAMPLE_PATH, start, end);
    if (put.status !== 200) throw new Error(`part ${part.part_number}: ${put.status}`);
  });

  const complete = await api('POST', `/videos/${publicId}/upload/complete`, { token });
  const timeline = [`${now()}  status = ${complete.body.status} (resposta do complete)`];
  const ready = await waitUntilSettled(token, publicId, timeline);
  const thumb = await fetch(ready.thumbnail_url);
  await writeFile(join(ASSETS, 'thumbnail-sample.jpg'), Buffer.from(await thumb.arrayBuffer()));
  const stream = await api('GET', `/videos/${publicId}/stream`, { token });
  await writeFile(join(ASSETS, 'sample-stream-url.txt'), stream.body.url);

  await writeLog('11-playback-sample.log', [
    `# ${now()}  Vídeo de taxa normal para a reprodução no navegador (${SAMPLE}, ${size} bytes, gerado com o FFmpeg do worker)`,
    `POST /videos -> ${init.status} (${part_count} parte${part_count > 1 ? 's' : ''})`,
    `PUT direto no MinIO -> 200`,
    `POST /videos/${publicId}/upload/complete -> ${complete.status}`,
    ...timeline,
    '',
    psql(`SELECT public_id, status, duration_seconds, width, height, video_codec, audio_codec, thumbnail_key FROM videos WHERE public_id = '${publicId}';`),
    `GET /videos/${publicId}/stream -> ${stream.status}  (expires_at ${stream.body.expires_at})`,
    `Thumbnail -> HTTP ${thumb.status} (assets/thumbnail-sample.jpg)`,
  ]);
  await writeFile(join(LOGS, 'playback.json'), pretty({ publicId, finishedAt: now() }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
