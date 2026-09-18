import { Column, Entity, Index, Unique } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { RoleCode } from './role.entity';

/**
 * 工作区成员：让同一个人可以属于多个工作区（例如同时管两家公司/两个品牌矩阵），
 * 并在每个工作区里拥有不同的角色。没有这一层时，用户只能绑在单一 workspaceId 上。
 */
@Entity('workspace_members')
@Unique('UQ_workspace_members_workspace_user', ['workspaceId', 'userId'])
export class WorkspaceMember extends BaseEntity {
  @Index()
  @Column({ type: 'uuid' })
  userId!: string;

  /** 该成员在这个工作区里的角色（与全局角色取并集的语义：这里优先） */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  roleCodes!: RoleCode[];

  @Column({ type: 'uuid', nullable: true })
  invitedBy!: string | null;
}
