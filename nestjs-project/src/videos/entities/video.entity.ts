import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  type ValueTransformer,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';

export enum VideoStatus {
  Uploading = 'uploading',
  Processing = 'processing',
  Ready = 'ready',
  Failed = 'failed',
}

// Postgres returns bigint as string; sizes are capped at 10 GiB, well within
// Number.MAX_SAFE_INTEGER.
const bigintToNumber: ValueTransformer = {
  to: (value: number | null) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};

@Entity('videos')
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 11 })
  public_id: string;

  @Index()
  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'varchar', length: 100 })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({
    type: 'enum',
    enum: VideoStatus,
    enumName: 'videos_status_enum',
    default: VideoStatus.Uploading,
  })
  status: VideoStatus;

  @Column({ type: 'varchar', length: 255 })
  original_filename: string;

  @Column({ type: 'varchar', length: 100 })
  mime_type: string;

  @Column({ type: 'bigint', transformer: bigintToNumber })
  size_bytes: number;

  @Column({ type: 'varchar', length: 1024, nullable: true })
  upload_id: string | null;

  @Column({ type: 'double precision', nullable: true })
  duration_seconds: number | null;

  @Column({ type: 'integer', nullable: true })
  width: number | null;

  @Column({ type: 'integer', nullable: true })
  height: number | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  video_codec: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  audio_codec: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  container_format: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  processing_error: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => Channel, (channel) => channel.videos)
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
