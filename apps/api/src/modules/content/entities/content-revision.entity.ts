import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { AiFlagType } from '@mediaflow/shared';

/**
 * 内容版本快照：每次保存前把"上一版"存下来，改错可以回滚。
 * 保留条数由配置 CONTENT_HISTORY_LIMIT 控制（默认 20，0 = 不留历史）。
 */
@Entity('content_revisions')
export class ContentRevision extends BaseEntity {
  @Index()
  @Column({ type: 'uuid' })
  contentId!: string;

  /** 版本号，从 1 开始递增 */
  @Column({ type: 'int' })
  version!: number;

  @Column({ type: 'varchar', length: 200 })
  title!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  summary!: string | null;

  @Column({ type: 'text' })
  body!: string;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  tags!: string[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  mediaUrls!: string[];

  @Column({ type: 'varchar', length: 512, nullable: true })
  coverUrl!: string | null;

  @Column({ type: 'varchar', length: 32 })
  aiFlagType!: AiFlagType;

  @Column({ type: 'varchar', length: 32 })
  status!: string;

  /** 保存原因/备注（例如"编辑保存"、"恢复历史版本"） */
  @Column({ type: 'varchar', length: 120, nullable: true })
  note!: string | null;

  @Column({ type: 'uuid', nullable: true })
  createdBy!: string | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  createdByName!: string | null;
}
