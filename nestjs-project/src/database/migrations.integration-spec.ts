import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video } from '../videos/entities/video.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1791237941900 } from './migrations/1791237941900-CreateVideos';
import { createTestDataSource } from '../test/create-test-data-source';

const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
  'videos',
];

// Reverse FK order: children before parents, so no CASCADE ordering races.
const DROP_ORDER = [
  'videos',
  'refresh_tokens',
  'verification_tokens',
  'channels',
  'users',
  'migrations',
];

const MANAGED_ENUMS = ['verification_tokens_type_enum', 'videos_status_enum'];

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
          CreateVideos1791237941900,
        ],
      },
    );

    await dataSource.initialize();

    for (const table of DROP_ORDER) {
      await dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }
    for (const enumName of MANAGED_ENUMS) {
      await dataSource.query(`DROP TYPE IF EXISTS "public"."${enumName}"`);
    }
  });

  afterAll(async () => {
    // The revert test undoes the last migration, leaving `videos` missing.
    // Re-apply so the shared DB is fully migrated when subsequent suites run.
    await dataSource.runMigrations();
    await dataSource.destroy();
  });

  const existingTables = async (tables: string[]): Promise<string[]> => {
    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [tables],
    );
    return result.map((r) => r.table_name);
  };

  const existingEnums = async (enums: string[]): Promise<string[]> => {
    const result = await dataSource.query<{ typname: string }[]>(
      `SELECT typname FROM pg_type WHERE typname = ANY($1::text[])`,
      [enums],
    );
    return result.map((r) => r.typname);
  };

  it('should apply all migrations from scratch and create all managed tables', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(3);
    expect(await existingTables(MANAGED_TABLES)).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'videos',
    ]);
    expect((await existingEnums(MANAGED_ENUMS)).sort()).toEqual(
      [...MANAGED_ENUMS].sort(),
    );
  });

  it('should revert the last migration, removing videos and its enum while keeping Phase 02 tables', async () => {
    await dataSource.undoLastMigration();

    expect(await existingTables(['videos'])).toEqual([]);
    expect(await existingEnums(['videos_status_enum'])).toEqual([]);
    expect(await existingTables(MANAGED_TABLES)).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
    ]);
  });

  it('should re-apply the reverted migration', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations.map((m) => m.name)).toEqual([
      'CreateVideos1791237941900',
    ]);
    expect(await existingTables(['videos'])).toEqual(['videos']);
  });
});
