// Shared helpers for the Fase 03 evidence scripts: HTTP calls against the
// running Compose stack, presigned part uploads, psql/redis-cli via docker compose.

import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const EVIDENCE_DIR = resolve(HERE, '..');
export const LOGS = join(EVIDENCE_DIR, 'logs');
export const ASSETS = join(EVIDENCE_DIR, 'assets');
export const NEST_DIR = resolve(HERE, '../../../../nestjs-project');
export const FIXTURE = join(NEST_DIR, '.large-fixtures', 'video-10gib.mp4');

export const API = 'http://localhost:3000';
export const MAILPIT = 'http://localhost:8025';
export const SIZE_LIMIT = 10_737_418_240;
export const CONCURRENCY = 4;
export const PASSWORD = 'password123';

export const now = () => new Date().toISOString();
export const fmtBytes = (n) => `${(n / 1024 ** 3).toFixed(2)} GiB`;
export const pretty = (v) => JSON.stringify(v, null, 2);

export async function writeLog(name, lines) {
  const text = lines.join('\n') + '\n';
  await writeFile(join(LOGS, name), text);
  console.log(`\n===== ${name} =====\n${text}`);
}

export function compose(...args) {
  return execFileSync('docker', ['compose', ...args], {
    cwd: NEST_DIR,
    encoding: 'utf8',
  });
}

export const psql = (sql) =>
  compose('exec', '-T', 'db', 'psql', '-U', 'streamtube', '-d', 'streamtube', '-c', sql);

export const redis = (...args) => compose('exec', '-T', 'redis', 'redis-cli', ...args);

export async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

/** PUTs a byte range of a file to a presigned URL with an explicit Content-Length. */
export function putPart(url, file, start, end) {
  return new Promise((ok, fail) => {
    const req = http.request(
      url,
      { method: 'PUT', headers: { 'content-length': String(end - start + 1) } },
      (res) => {
        res.resume();
        res.on('end', () => ok({ status: res.statusCode, etag: res.headers.etag }));
      },
    );
    req.on('error', fail);
    createReadStream(file, { start, end }).pipe(req);
  });
}

/** GETs a URL, discards the body and returns status, headers and byte count. */
export function getCounting(url, headers = {}) {
  return new Promise((ok, fail) => {
    const started = Date.now();
    http
      .get(url, { headers }, (res) => {
        let bytes = 0;
        const chunks = [];
        res.on('data', (c) => {
          bytes += c.length;
          if (bytes <= 2048) chunks.push(c);
        });
        res.on('end', () =>
          ok({
            status: res.statusCode,
            headers: res.headers,
            bytes,
            ms: Date.now() - started,
            head: Buffer.concat(chunks),
          }),
        );
      })
      .on('error', fail);
  });
}

export async function runPool(items, concurrency, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

export async function registerConfirmAndLogin(email) {
  const lines = [];
  const reg = await api('POST', '/auth/register', { body: { email, password: PASSWORD } });
  lines.push(`POST /auth/register -> ${reg.status}`);

  let token;
  for (let i = 0; i < 30 && !token; i++) {
    const search = await fetch(
      `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
    ).then((r) => r.json());
    const id = search.messages?.[0]?.ID;
    if (id) {
      const msg = await fetch(`${MAILPIT}/api/v1/message/${id}`).then((r) => r.json());
      token = /confirm-email\?token=([A-Za-z0-9_-]+)/.exec(msg.HTML ?? msg.Text)?.[1];
    }
    if (!token) await sleep(500);
  }
  if (!token) throw new Error(`No confirmation email for ${email}`);
  lines.push('Confirmation e-mail read from Mailpit');

  const confirm = await api('GET', `/auth/confirm-email?token=${token}`);
  lines.push(`GET /auth/confirm-email -> ${confirm.status}`);
  const login = await api('POST', '/auth/login', { body: { email, password: PASSWORD } });
  lines.push(`POST /auth/login -> ${login.status} (access_token received)`);
  return { accessToken: login.body.access_token, lines };
}

export async function waitUntilSettled(token, publicId, timeline) {
  let last;
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const res = await api('GET', `/videos/${publicId}`, { token });
    if (res.body.status !== last) {
      timeline.push(`${now()}  status = ${res.body.status}`);
      last = res.body.status;
    }
    if (res.body.status === 'ready' || res.body.status === 'failed') return res.body;
    await sleep(1000);
  }
  throw new Error(`${publicId} did not settle`);
}

/** Pings the API while the upload runs, proving it keeps answering. */
export function startHeartbeat() {
  const samples = [];
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const t = Date.now();
      const res = await fetch(`${API}/`).catch(() => null);
      samples.push({ at: now(), status: res?.status ?? 'ERR', ms: Date.now() - t });
      await sleep(2000);
    }
  })();
  return async () => {
    stopped = true;
    await loop;
    return samples;
  };
}

export function apiContainerStats() {
  return execFileSync(
    'docker',
    ['stats', '--no-stream', '--format', '{{.Name}}  CPU {{.CPUPerc}}  MEM {{.MemUsage}}  NET in/out {{.NetIO}}'],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter((l) => /nestjs-api|video-worker|minio/.test(l));
}

