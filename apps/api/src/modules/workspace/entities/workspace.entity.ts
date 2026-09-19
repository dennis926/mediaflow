import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { User } from './user.entity';

/**
 * 工作区生命周期状态（B0.4）：
 * active → 正常｜archived → 只读（可随时取消归档）｜soft_deleted → 已软删，保留期内可恢复。
 * 旧的 'suspended' 语义与 archived 重叠且从未投入使用，迁移时统一改写为 archived。
 */
export type WorkspaceStatus = 'active' | 'archived' | 'soft_deleted';

@Entity('workspaces')
export class Workspace extends BaseEntity {
  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 50 })
  slug!: string;

  @Column({ type: 'varchar', length: 32, default: 'active' })
  status!: WorkspaceStatus;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  settings!: Record<string, unknown>;

  /** 进入归档态的时间（active 时为 null） */
  @Column({ type: 'timestamptz', nullable: true })
  archivedAt!: Date | null;

  /** 软删时间：保留期从这里开始计算 */
  @Column({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  /** 到期清理时间 = deleted_at + WORKSPACE_SOFT_DELETE_RETENTION_DAYS（软删时写入，便于索引扫描） */
  @Column({ type: 'timestamptz', nullable: true })
  purgeAfter!: Date | null;

  @OneToMany(() => User, (user) => user.workspace)
  users?: User[];
}
