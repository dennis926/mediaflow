import { Column, Entity, Index, JoinTable, ManyToMany, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { Role } from './role.entity';
import { Workspace } from './workspace.entity';

export type UserStatus = 'active' | 'disabled';

@Entity('users')
@Index(['tenantId', 'email'], { unique: true })
export class User extends BaseEntity {
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

  @ManyToOne(() => Workspace, (workspace) => workspace.users, { onDelete: 'CASCADE' })
  workspace?: Workspace;

  @ManyToMany(() => Role)
  @JoinTable({ name: 'user_roles' })
  roles?: Role[];
}
