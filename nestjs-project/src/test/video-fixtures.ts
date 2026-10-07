import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type VideoFixtureKind =
  | 'mp4-with-audio'
  | 'mp4-video-only'
  | 'mp4-short'
  | 'mp4-wide'
  | 'audio-only'
  | 'not-media';

const testsrc = (size: string, seconds: number): string[] => [
  '-f',
  'lavfi',
  '-i',
  `testsrc=size=${size}:rate=25:duration=${seconds}`,
];
const sine = (seconds: number): string[] => [
  '-f',
  'lavfi',
  '-i',
  `sine=frequency=440:duration=${seconds}`,
];
const H264 = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'];
const AAC = ['-c:a', 'aac'];

const FIXTURES: Record<
  Exclude<VideoFixtureKind, 'not-media'>,
  { file: string; args: string[] }
> = {
  'mp4-with-audio': {
    file: 'with-audio.mp4',
    args: [...testsrc('320x240', 3), ...sine(3), ...H264, ...AAC, '-shortest'],
  },
  'mp4-video-only': {
    file: 'video-only.mp4',
    args: [...testsrc('320x240', 3), ...H264, '-an'],
  },
  'mp4-short': {
    file: 'short.mp4',
    args: [...testsrc('320x240', 1), ...H264, '-an'],
  },
  'mp4-wide': {
    file: 'wide.mp4',
    args: [...testsrc('1280x720', 1), ...H264, '-an'],
  },
  'audio-only': {
    file: 'audio-only.m4a',
    args: [...sine(3), ...AAC, '-vn'],
  },
};

let directory: Promise<string> | undefined;
const generated = new Map<VideoFixtureKind, Promise<string>>();

/**
 * Generates the fixture with ffmpeg once per test process, under
 * os.tmpdir(), so the repository never stores media binaries.
 */
export function getVideoFixture(kind: VideoFixtureKind): Promise<string> {
  let fixture = generated.get(kind);
  if (!fixture) {
    fixture = generate(kind);
    generated.set(kind, fixture);
  }
  return fixture;
}

async function generate(kind: VideoFixtureKind): Promise<string> {
  directory ??= mkdtemp(join(tmpdir(), 'video-fixtures-'));
  const dir = await directory;

  if (kind === 'not-media') {
    const path = join(dir, 'not-media.mp4');
    await writeFile(path, randomBytes(64 * 1024));
    return path;
  }

  const { file, args } = FIXTURES[kind];
  const path = join(dir, file);
  await execFileAsync('ffmpeg', ['-v', 'error', '-y', ...args, path]);
  return path;
}
