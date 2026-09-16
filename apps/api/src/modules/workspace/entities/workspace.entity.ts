import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { User } from './user.entity';

export type WorkspaceStatus = 'active' | 'suspended';

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

  @OneToMany(() => User, (user) => user.workspace)
  users?: User[];
}
