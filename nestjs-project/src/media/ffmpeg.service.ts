import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import {
  MEDIA_BINARIES,
  MEDIA_FRAME_MAX_OUTPUT_BYTES,
  MEDIA_FRAME_TIMEOUT_MS,
  MEDIA_PROBE_MAX_OUTPUT_BYTES,
  MEDIA_PROBE_TIMEOUT_MS,
  MEDIA_STDERR_MAX_BYTES,
  THUMBNAIL_MAX_WIDTH,
} from './media.constants';
import {
  MediaFrameExtractionError,
  MediaNotReadableError,
} from './media.errors';
import type { MediaProbeResult, ProbeOutput } from './media.types';
import { parseProbeOutput } from './media.utils';

interface RunOptions {
  timeoutMs: number;
  maxStdoutBytes: number;
}

interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: string;
  overflowed: boolean;
}

/**
 * Wraps the system ffprobe/ffmpeg binaries (TD-05). Inputs are passed as
 * argv entries with `shell: false`, so a file name is never interpreted by
 * a shell.
 */
@Injectable()
export class FfmpegService {
  async probe(input: string): Promise<MediaProbeResult> {
    const result = await this.run(
      MEDIA_BINARIES.FFPROBE,
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        input,
      ],
      {
        timeoutMs: MEDIA_PROBE_TIMEOUT_MS,
        maxStdoutBytes: MEDIA_PROBE_MAX_OUTPUT_BYTES,
      },
    );
    if (result.exitCode !== 0 || result.overflowed) {
      throw new MediaNotReadableError(input, describeFailure(result));
    }

    let output: ProbeOutput;
    try {
      output = JSON.parse(result.stdout.toString('utf8')) as ProbeOutput;
    } catch {
      throw new MediaNotReadableError(input, 'ffprobe returned invalid JSON');
    }
    const formatName = output?.format?.format_name;
    if (!formatName) {
      throw new MediaNotReadableError(input, 'ffprobe reported no container');
    }
    return parseProbeOutput({
      ...output,
      format: { ...output.format, format_name: formatName },
    });
  }

  /** Returns one JPEG frame at `atSeconds`, at most 640 px wide, never upscaled. */
  async extractFrame(input: string, atSeconds: number): Promise<Buffer> {
    const result = await this.run(
      MEDIA_BINARIES.FFMPEG,
      [
        '-v',
        'error',
        '-ss',
        String(atSeconds),
        '-i',
        input,
        '-frames:v',
        '1',
        '-vf',
        `scale='min(${THUMBNAIL_MAX_WIDTH},iw)':-2`,
        '-q:v',
        '3',
        '-f',
        'image2',
        'pipe:1',
      ],
      {
        timeoutMs: MEDIA_FRAME_TIMEOUT_MS,
        maxStdoutBytes: MEDIA_FRAME_MAX_OUTPUT_BYTES,
      },
    );
    if (result.exitCode !== 0 || result.overflowed) {
      throw new MediaFrameExtractionError(input, describeFailure(result));
    }
    if (result.stdout.length === 0) {
      throw new MediaFrameExtractionError(input, 'ffmpeg produced no frame');
    }
    return result.stdout;
  }

  /**
   * Resolves with the process outcome; rejects only when the binary cannot
   * be started (e.g. ENOENT), which is an environment fault, not bad media.
   */
  private run(
    command: string,
    args: string[],
    { timeoutMs, maxStdoutBytes }: RunOptions,
  ): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
      });
      const chunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderr = '';
      let overflowed = false;

      child.stdout.on('data', (chunk: Buffer) => {
        if (overflowed) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxStdoutBytes) {
          overflowed = true;
          chunks.length = 0;
          child.kill('SIGKILL');
          return;
        }
        chunks.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(
          -MEDIA_STDERR_MAX_BYTES,
        );
      });
      child.once('error', reject);
      child.once('close', (exitCode, signal) => {
        resolve({
          exitCode,
          signal,
          stdout: Buffer.concat(chunks),
          stderr,
          overflowed,
        });
      });
    });
  }
}

function describeFailure(result: RunResult): string {
  const reason = result.overflowed
    ? 'output exceeded the size limit'
    : result.signal
      ? `killed by ${result.signal}`
      : `exit code ${result.exitCode}`;
  return result.stderr ? `${reason}: ${result.stderr.trim()}` : reason;
}
