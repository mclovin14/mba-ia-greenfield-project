import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video } from '../videos/entities/video.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1791237941900 } from './migrations/1791237941900-CreateVideos';
import { AddVideoStorageKeys1791382169844 } from './migrations/1791382169844-AddVideoStorageKeys';
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
          AddVideoStorageKeys1791382169844,
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

    expect(ranMigrations).toHaveLength(4);
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

  const videoColumns = async (): Promise<string[]> => {
    const result = await dataSource.query<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'videos'
         AND column_name IN ('original_key', 'thumbnail_key')
       ORDER BY column_name`,
    );
    return result.map((r) => r.column_name);
  };

  it('should revert the last migration, removing only the storage key columns', async () => {
    await dataSource.undoLastMigration();

    expect(await videoColumns()).toEqual([]);
    expect(await existingTables(MANAGED_TABLES)).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'videos',
    ]);
  });

  it('should backfill the storage keys of existing rows when re-applied', async () => {
    const [{ id: userId }] = await dataSource.query<{ id: string }[]>(
      `INSERT INTO "users" ("email", "password")
       VALUES ('migration_backfill@example.com', 'hashed') RETURNING "id"`,
    );
    const [{ id: channelId }] = await dataSource.query<{ id: string }[]>(
      `INSERT INTO "channels" ("name", "nickname", "user_id")
       VALUES ('Backfill', 'backfill', $1) RETURNING "id"`,
      [userId],
    );
    const rows = await dataSource.query<{ id: string; status: string }[]>(
      `INSERT INTO "videos"
         ("public_id", "channel_id", "title", "status", "original_filename", "mime_type", "size_bytes")
       VALUES ('backfill001', $1, 'Clip', 'ready', 'clip.mp4', 'video/mp4', 1),
              ('backfill002', $1, 'Clip', 'uploading', 'clip.mp4', 'video/mp4', 1)
       RETURNING "id", "status"`,
      [channelId],
    );

    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations.map((m) => m.name)).toEqual([
      'AddVideoStorageKeys1791382169844',
    ]);
    const stored = await dataSource.query<
      { id: string; original_key: string; thumbnail_key: string | null }[]
    >(`SELECT "id", "original_key", "thumbnail_key" FROM "videos"`);
    const ready = rows.find((r) => r.status === 'ready')!;
    const uploading = rows.find((r) => r.status === 'uploading')!;
    expect(stored).toEqual(
      expect.arrayContaining([
        {
          id: ready.id,
          original_key: `${ready.id}/original`,
          thumbnail_key: `${ready.id}/thumbnail.jpg`,
        },
        {
          id: uploading.id,
          original_key: `${uploading.id}/original`,
          thumbnail_key: null,
        },
      ]),
    );

    await dataSource.query(`DELETE FROM "videos"`);
    await dataSource.query(`DELETE FROM "channels" WHERE "id" = $1`, [
      channelId,
    ]);
    await dataSource.query(`DELETE FROM "users" WHERE "id" = $1`, [userId]);
  });
});
