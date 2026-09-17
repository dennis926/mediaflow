import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import type { AiTaskType } from '../ai.types';

export type AiGenerationStatus = 'success' | 'failed';

@Entity('ai_generations')
export class AiGeneration extends BaseEntity {
  @Column({ type: 'varchar', length: 40 })
  provider!: string;

  @Column({ type: 'varchar', length: 80 })
  model!: string;

  @Index()
  @Column({ type: 'varchar', length: 40 })
  taskType!: AiTaskType;

  @Column({ type: 'varchar', length: 32, default: 'success' })
  status!: AiGenerationStatus;

  @Column({ type: 'text' })
  prompt!: string;

  @Column({ type: 'text', nullable: true })
  output!: string | null;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  inputRefs!: Record<string, unknown>;

  @Column({ type: 'int', default: 0 })
  tokensInput!: number;

  @Column({ type: 'int', default: 0 })
  tokensOutput!: number;

  @Column({ type: 'int', default: 0 })
  latencyMs!: number;

  @Column({ type: 'numeric', precision: 12, scale: 6, default: 0 })
  cost!: string;

  @Column({ type: 'text', nullable: true })
  errorMessage!: string | null;

  @Column({ type: 'uuid', nullable: true })
  requestedBy!: string | null;

  @Column({ type: 'uuid', nullable: true })
  contentId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  contentVariantId!: string | null;
}
