import { Column, CreateDateColumn, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * Every table carries tenant_id / workspace_id so the schema is ready for multi-tenant use,
 * plus the mandatory created_at / updated_at audit columns (AGENTS.md 2).
 */
export abstract class BaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  tenantId!: string;

  @Index()
  @Column({ type: 'uuid' })
  workspaceId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
