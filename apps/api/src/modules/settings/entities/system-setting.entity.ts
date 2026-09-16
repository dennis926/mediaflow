import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';

/** One configurable key. Secrets are stored encrypted (see CryptoService). */
@Entity('system_settings')
@Index(['workspaceId', 'key'], { unique: true })
export class SystemSetting extends BaseEntity {
  @Column({ type: 'varchar', length: 80 })
  key!: string;

  @Column({ type: 'text', nullable: true })
  value!: string | null;

  @Column({ type: 'boolean', default: false })
  isSecret!: boolean;

  @Column({ type: 'uuid', nullable: true })
  updatedBy!: string | null;
}
