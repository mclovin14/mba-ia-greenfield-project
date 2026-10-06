import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ENDPOINT: 'http://minio:9000',
  S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage and queue', () => {
  const validateWithout = (key: keyof typeof requiredEnv) => {
    const env: Record<string, string> = { ...requiredEnv };
    delete env[key];
    return envValidationSchema.validate(env, {
      allowUnknown: true,
      abortEarly: false,
    });
  };

  it('should reject boot without S3_ENDPOINT, citing the key', () => {
    const { error } = validateWithout('S3_ENDPOINT');
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_ENDPOINT');
  });

  it('should reject boot without S3_ACCESS_KEY_ID, citing the key', () => {
    const { error } = validateWithout('S3_ACCESS_KEY_ID');
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_ACCESS_KEY_ID');
  });

  it('should reject a non-URI S3_PUBLIC_ENDPOINT', () => {
    const { error } = validate({ S3_PUBLIC_ENDPOINT: 'not a url' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_PUBLIC_ENDPOINT');
  });

  it('should apply bucket, Redis and lifecycle defaults', () => {
    const result = validate({});
    expect(result.error).toBeUndefined();
    const value: unknown = result.value;
    expect(value).toMatchObject({
      S3_REGION: 'us-east-1',
      S3_VIDEOS_BUCKET: 'videos',
      S3_THUMBNAILS_BUCKET: 'thumbnails',
      STORAGE_LIFECYCLE_RULES_ENABLED: 'false',
      REDIS_HOST: 'redis',
      REDIS_PORT: 6379,
      QUEUE_PREFIX: 'bull',
    });
  });

  it('should reject STORAGE_LIFECYCLE_RULES_ENABLED outside true/false', () => {
    const { error } = validate({ STORAGE_LIFECYCLE_RULES_ENABLED: 'yes' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_LIFECYCLE_RULES_ENABLED');
  });
});
