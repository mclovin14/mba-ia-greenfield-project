import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('should compile with the real root modules and register no controllers', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    const controllers = [...module.get(ModulesContainer).values()].flatMap(
      (moduleRef) => [...moduleRef.controllers.keys()],
    );
    expect(controllers).toEqual([]);
    expect(module.get(DataSource)).toBeInstanceOf(DataSource);
    await module.close();
  });
});
