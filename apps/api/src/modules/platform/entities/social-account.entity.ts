import { Column, Entity, Index, ManyToOne } from 'typeorm';
import { PlatformCode } from '@mediaflow/shared';
import { BaseEntity } from '../../../database/base.entity';
import { Platform } from './platform.entity';

export type SocialAccountStatus = 'active' | 'expired' | 'revoked';

@Entity('social_accounts')
@Index(['workspaceId', 'platformId', 'platformAccountId'], { unique: true })
export class SocialAccount extends BaseEntity {
  @ManyToOne(() => Platform, { onDelete: 'RESTRICT' })
  platform?: Platform;

  @Column({ type: 'uuid' })
  platformId!: string;

  @Column({ type: 'varchar', length: 40 })
  platformCode!: PlatformCode;

  @Column({ type: 'varchar', length: 120 })
  accountName!: string;

  @Column({ type: 'varchar', length: 160 })
  platformAccountId!: string;

  @Column({ type: 'varchar', length: 512, nullable: true })
  avatarUrl!: string | null;

  /** Secrets are never returned by default queries. */
  @Column({ type: 'varchar', length: 1024, nullable: true, select: false })
  accessToken!: string | null;

  @Column({ type: 'varchar', length: 1024, nullable: true, select: false })
  refreshToken!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  tokenExpiresAt!: Date | null;

  @Column({ type: 'varchar', length: 32, default: 'active' })
  status!: SocialAccountStatus;

  @Column({ type: 'uuid', nullable: true })
  boundBy!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastSyncedAt!: Date | null;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  extra!: Record<string, unknown>;
}
