import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';

export type RoleCode = 'owner' | 'admin' | 'editor' | 'reviewer' | 'viewer';

@Entity('roles')
@Index(['tenantId', 'code'], { unique: true })
export class Role extends BaseEntity {
  @Column({ type: 'varchar', length: 50 })
  code!: RoleCode;

  @Column({ type: 'varchar', length: 80 })
  name!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  description!: string | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  permissions!: string[];

  @Column({ type: 'boolean', default: true })
  isSystem!: boolean;
}
