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

/** 内置角色代码（与权限矩阵里的角色取值一致）。 */
export const ROLE_CODES = ['owner', 'admin', 'editor', 'reviewer', 'viewer'] as const;
