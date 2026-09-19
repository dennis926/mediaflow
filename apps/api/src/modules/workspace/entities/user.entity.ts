import { Column, DeleteDateColumn, Entity, Index, JoinTable, ManyToMany, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { Role } from './role.entity';
import { Workspace } from './workspace.entity';

export type UserStatus = 'active' | 'disabled';

@Entity('users')
@Index(['tenantId', 'email'], { unique: true })
export class User extends BaseEntity {
  /**
   * 默认工作区（B0.4/M8：**数据库层可为空**）。
   *
   * 工作区被永久清除时这里置空，用户本身必须保留（他可能还属于其他工作区，
   * 账号不能因为删了一个工作区就消失）。类型沿用基类的 `string` 以符合多租户列约定，
   * 但**运行时可能为 null** —— 因此任何"用户归属/能进哪个工作区"的判断都必须走
   * `WorkspaceService.resolveLoginWorkspace()`（以 workspace_members 为准），不要读这个字段。
   */
  @Column({ type: 'uuid', nullable: true })
  declare workspaceId: string;

  @Column({ type: 'varchar', length: 160 })
  email!: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  phone!: string | null;

  @Column({ type: 'varchar', length: 80 })
  displayName!: string;

  /** Excluded from queries by default; only the auth flow selects it explicitly. */
  @Column({ type: 'varchar', length: 120, select: false })
  passwordHash!: string;

  @Column({ type: 'varchar', length: 512, nullable: true })
  avatarUrl!: string | null;

  @Column({ type: 'varchar', length: 32, default: 'active' })
  status!: UserStatus;

  @Column({ type: 'boolean', default: false })
  isSuperAdmin!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  lastLoginAt!: Date | null;

  /** Set when an admin creates/resets a password: the user must change it on first login. */
  @Column({ type: 'boolean', default: false })
  mustChangePassword!: boolean;

  @Column({ type: 'uuid', nullable: true })
  invitedBy!: string | null;

  /** Soft delete: the row stays for audit purposes but the account can no longer log in. */
  @DeleteDateColumn({ type: 'timestamptz' })
  deletedAt!: Date | null;

  @ManyToOne(() => Workspace, (workspace) => workspace.users, { onDelete: 'SET NULL', nullable: true })
  workspace?: Workspace;

  @ManyToMany(() => Role)
  @JoinTable({ name: 'user_roles' })
  roles?: Role[];
}
