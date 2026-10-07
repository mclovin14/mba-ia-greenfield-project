import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { WorkerModule } from '../worker.module';
import { waitForVideoProcessingQueue } from '../test/queues';
import { VideoProcessingWorkerModule } from './video-processing-worker.module';
import { VideoProcessingProcessor } from './video-processing.processor';
import { VideoProcessingService } from './video-processing.service';

/**
 * Walks the static import graph (classes and dynamic modules) and collects
 * every module and provider reachable from `root`, without compiling it.
 */
function reachable(root: unknown): Set<unknown> {
  const seen = new Set<unknown>();
  const visit = (entry: unknown): void => {
    if (!entry || seen.has(entry)) return;
    seen.add(entry);
    const dynamic = entry as {
      module?: unknown;
      imports?: unknown[];
      providers?: unknown[];
    };
    const target = typeof entry === 'function' ? entry : dynamic.module;
    const metadata = (key: string): unknown[] =>
      (target ? (Reflect.getMetadata(key, target) as unknown[]) : null) ?? [];
    for (const imported of [
      ...metadata(MODULE_METADATA.IMPORTS),
      ...(dynamic.imports ?? []),
      target,
    ]) {
      visit(imported);
    }
    for (const provider of [
      ...metadata(MODULE_METADATA.PROVIDERS),
      ...(dynamic.providers ?? []),
    ]) {
      seen.add(provider);
    }
  };
  visit(root);
  return seen;
}

describe('VideoProcessingWorkerModule', () => {
  it('should compile inside WorkerModule and expose the processor', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(module.get(VideoProcessingProcessor)).toBeInstanceOf(
      VideoProcessingProcessor,
    );
    expect(module.get(VideoProcessingService)).toBeInstanceOf(
      VideoProcessingService,
    );
    await waitForVideoProcessingQueue(module);
    await module.close();
  });

  it('should be reachable from WorkerModule', () => {
    const graph = reachable(WorkerModule);

    expect(graph.has(VideoProcessingWorkerModule)).toBe(true);
    expect(graph.has(VideoProcessingProcessor)).toBe(true);
  });

  it('should keep the processor out of AppModule (TD-04)', () => {
    const graph = reachable(AppModule);

    expect(graph.has(VideoProcessingWorkerModule)).toBe(false);
    expect(graph.has(VideoProcessingProcessor)).toBe(false);
  });
});
