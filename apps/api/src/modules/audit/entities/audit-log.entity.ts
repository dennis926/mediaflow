import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';

@Entity('audit_logs')
@Index(['resourceType', 'resourceId'])
export class AuditLog extends BaseEntity {
  @Column({ type: 'uuid', nullable: true })
  actorId!: string | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  actorName!: string | null;

  @Index()
  @Column({ type: 'varchar', length: 80 })
  action!: string;

  @Column({ type: 'varchar', length: 60 })
  resourceType!: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  resourceId!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  ip!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  userAgent!: string | null;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  payload!: Record<string, unknown>;
}
