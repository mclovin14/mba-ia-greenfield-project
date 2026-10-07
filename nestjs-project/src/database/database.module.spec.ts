import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { RootConfigModule } from '../config/root-config.module';
import { DatabaseModule } from './database.module';

describe('Root modules', () => {
  it('should compile RootConfigModule alone with every config namespace loaded', async () => {
    const module = await Test.createTestingModule({
      imports: [RootConfigModule],
    }).compile();

    const config = module.get(ConfigService);
    for (const namespace of [
      'app',
      'auth',
      'database',
      'mail',
      'swagger',
      'storage',
      'queue',
    ]) {
      expect(config.get(namespace)).toBeDefined();
    }
    await module.close();
  });

  it('should compile DatabaseModule with autoLoadEntities and no synchronize', async () => {
    const module = await Test.createTestingModule({
      imports: [RootConfigModule, DatabaseModule],
    }).compile();

    const dataSource = module.get(DataSource);
    expect(dataSource.options).toMatchObject({
      type: 'postgres',
      synchronize: false,
    });
    expect(dataSource.isInitialized).toBe(true);
    await module.close();
  });
});
