import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { PlatformCode, PublishMode } from '@mediaflow/shared';

export interface PlatformCapabilities {
  canPublish: boolean;
  canFetchAnalytics: boolean;
  canInteract: boolean;
  supportsSchedule: boolean;
  maxBodyLength: number;
  supportedMedia: Array<'image' | 'video' | 'audio'>;
}

@Entity('platforms')
export class Platform extends BaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 40 })
  code!: PlatformCode;

  @Column({ type: 'varchar', length: 80 })
  name!: string;

  @Column({ type: 'varchar', length: 16 })
  publishMode!: PublishMode;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  capabilities!: PlatformCapabilities;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'int', default: 0 })
  sortOrder!: number;
}
