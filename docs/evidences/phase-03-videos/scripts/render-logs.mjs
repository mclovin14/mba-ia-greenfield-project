#!/usr/bin/env node
// Renders every ../logs/*.log into a terminal-styled HTML page under
// ../.render/, ready to be screenshotted into ../screenshots/.
//
// Usage: node docs/evidences/phase-03-videos/scripts/render-logs.mjs

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EVIDENCE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOGS = join(EVIDENCE_DIR, 'logs');
const OUT = join(EVIDENCE_DIR, '.render');

const escape = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const highlight = (line) => {
  const html = escape(line);
  if (/^#/.test(line)) return `<span class="c">${html}</span>`;
  return html
    .replace(/\b(HTTP (?:200|201|202|204|206))\b/g, '<span class="ok">$1</span>')
    .replace(/\b(HTTP (?:4\d\d|5\d\d))\b/g, '<span class="warn">$1</span>')
    .replace(/(-&gt; (?:200|201|202|204))\b/g, '<span class="ok">$1</span>')
    .replace(/(-&gt; 4\d\d)\b/g, '<span class="warn">$1</span>')
    .replace(/(status = (?:ready))/g, '<span class="ok">$1</span>')
    .replace(/(status = (?:failed))/g, '<span class="warn">$1</span>')
    .replace(/(status = (?:processing|uploading))/g, '<span class="info">$1</span>')
    .replace(/(\bPASS\b|passed|Healthy|healthy|\(healthy\))/g, '<span class="ok">$1</span>');
};

const page = (title, body) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${escape(title)}</title>
<style>
  body { margin: 0; background: #0d1117; font: 13px/1.45 Menlo, Consolas, monospace; color: #e6edf3; }
  .win { margin: 16px; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; width: max-content; min-width: 900px; max-width: 1500px; }
  .bar { background: #161b22; padding: 8px 12px; border-bottom: 1px solid #30363d; color: #8b949e; display: flex; gap: 8px; align-items: center; }
  .dot { width: 11px; height: 11px; border-radius: 50%; display: inline-block; }
  pre { margin: 0; padding: 14px 16px; white-space: pre-wrap; word-break: break-all; }
  .c { color: #8b949e; } .ok { color: #3fb950; font-weight: bold; } .warn { color: #f0883e; font-weight: bold; } .info { color: #58a6ff; font-weight: bold; }
</style></head>
<body><div class="win"><div class="bar">
<span class="dot" style="background:#ff5f56"></span><span class="dot" style="background:#ffbd2e"></span><span class="dot" style="background:#27c93f"></span>
<span>StreamTube · Fase 03 · ${escape(title)}</span></div>
<pre>${body}</pre></div></body></html>`;

await mkdir(OUT, { recursive: true });
for (const file of (await readdir(LOGS)).filter((f) => f.endsWith('.log')).sort()) {
  const text = await readFile(join(LOGS, file), 'utf8');
  const body = text.trimEnd().split('\n').map(highlight).join('\n');
  await writeFile(join(OUT, file.replace(/\.log$/, '.html')), page(file, body));
  console.log(file);
}
