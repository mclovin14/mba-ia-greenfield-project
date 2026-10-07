import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import queueConfig from './queue.config';
import storageConfig from './storage.config';

const STORAGE_ENV_KEYS = [
  'S3_ENDPOINT',
  'S3_PUBLIC_ENDPOINT',
  'S3_REGION',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_VIDEOS_BUCKET',
  'S3_THUMBNAILS_BUCKET',
  'STORAGE_LIFECYCLE_RULES_ENABLED',
  'REDIS_HOST',
  'REDIS_PORT',
  'QUEUE_PREFIX',
] as const;

type EnvKey = (typeof STORAGE_ENV_KEYS)[number];

const loadConfigs = async (
  env: Partial<Record<EnvKey, string>>,
): Promise<{
  storage: ConfigType<typeof storageConfig>;
  queue: ConfigType<typeof queueConfig>;
}> => {
  for (const key of STORAGE_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);

  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        ignoreEnvFile: true,
        load: [storageConfig, queueConfig],
      }),
    ],
  }).compile();

  const storage = module.get<ConfigType<typeof storageConfig>>(
    storageConfig.KEY,
  );
  const queue = module.get<ConfigType<typeof queueConfig>>(queueConfig.KEY);
  await module.close();
  return { storage, queue };
};

describe('storageConfig / queueConfig', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('should map storage env to typed config', async () => {
    const { storage } = await loadConfigs({
      S3_ENDPOINT: 'http://minio:9000',
      S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
      S3_REGION: 'sa-east-1',
      S3_ACCESS_KEY_ID: 'key',
      S3_SECRET_ACCESS_KEY: 'secret',
      S3_VIDEOS_BUCKET: 'v',
      S3_THUMBNAILS_BUCKET: 't',
    });

    expect(storage).toEqual({
      endpoint: 'http://minio:9000',
      publicEndpoint: 'http://localhost:9000',
      region: 'sa-east-1',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      videosBucket: 'v',
      thumbnailsBucket: 't',
      forcePathStyle: true,
      lifecycleRulesEnabled: false,
    });
  });

  it('should apply region and bucket defaults', async () => {
    const { storage } = await loadConfigs({});
    expect(storage.region).toBe('us-east-1');
    expect(storage.videosBucket).toBe('videos');
    expect(storage.thumbnailsBucket).toBe('thumbnails');
  });

  it.each([
    ['true', true],
    ['false', false],
    ['TRUE', false],
    ['1', false],
  ])(
    'should set lifecycleRulesEnabled=%s → %s (only the string "true" enables it)',
    async (raw, expected) => {
      const { storage } = await loadConfigs({
        STORAGE_LIFECYCLE_RULES_ENABLED: raw,
      });
      expect(storage.lifecycleRulesEnabled).toBe(expected);
    },
  );

  it('should map queue env with a numeric port', async () => {
    const { queue } = await loadConfigs({
      REDIS_HOST: 'cache',
      REDIS_PORT: '6380',
      QUEUE_PREFIX: 'test-x',
    });
    expect(queue).toEqual({ host: 'cache', port: 6380, prefix: 'test-x' });
  });

  it('should apply queue defaults', async () => {
    const { queue } = await loadConfigs({});
    expect(queue).toEqual({ host: 'redis', port: 6379, prefix: 'bull' });
  });
});
