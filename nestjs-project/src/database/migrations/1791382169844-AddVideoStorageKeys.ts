import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Persists the storage keys of the original file and the thumbnail. Generated
 * by the CLI; the spurious enum re-creation it emitted was dropped, and the
 * backfill (keys previously derived from the id) was added by hand so the
 * NOT NULL constraint holds for existing rows.
 */
export class AddVideoStorageKeys1791382169844 implements MigrationInterface {
  name = 'AddVideoStorageKeys1791382169844';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" ADD "original_key" character varying(255)`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD "thumbnail_key" character varying(255)`,
    );
    await queryRunner.query(
      `UPDATE "videos" SET "original_key" = "id"::text || '/original'`,
    );
    await queryRunner.query(
      `UPDATE "videos" SET "thumbnail_key" = "id"::text || '/thumbnail.jpg' WHERE "status" = 'ready'`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ALTER COLUMN "original_key" SET NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "videos" DROP COLUMN "thumbnail_key"`);
    await queryRunner.query(`ALTER TABLE "videos" DROP COLUMN "original_key"`);
  }
}
