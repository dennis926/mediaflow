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

  /** 命中缓存的输入 token（计费时单独按缓存价） */
  @Column({ type: 'int', default: 0 })
  tokensCached!: number;

  /** 输出中的推理（思考）token，便于判断推理模型的额度消耗 */
  @Column({ type: 'int', default: 0 })
  tokensReasoning!: number;

  /** 缓存写入 token（Anthropic 等会额外计费，其他供应商通常为 0） */
  @Column({ type: 'int', default: 0 })
  tokensCacheWrite!: number;

  /**
   * 本次调用使用的价格快照（元/百万 token，四段）+ 供应商/模型，
   * 便于日后核对账单：即使价目表改了，历史记录也能说明当时按什么价计费。
   */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  priceSnapshot!: Record<string, unknown>;

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
