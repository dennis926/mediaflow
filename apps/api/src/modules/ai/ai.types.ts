import { PlatformCode } from '@mediaflow/shared';
export type AiTaskType = 'generate' | 'adapt' | 'optimize_title' | 'compliance_check' | 'knowledge_generate' | 'knowledge_polish';

export interface AiCompletionRequest {
  task: AiTaskType;
  system: string;
  user: string;
  /** Ask the provider for a JSON object response. */
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
}

export interface AiCompletionResult {
  text: string;
  model: string;
  tokensInput: number;
  tokensOutput: number;
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  complete(request: AiCompletionRequest): Promise<AiCompletionResult>;
}

export interface AdaptedVariantPayload {
  platform: string;
  title: string;
  body: string;
  tags: string[];
}

export interface ComplianceViolation {
  term: string;
  category: 'medical_claim' | 'absolute_term' | 'guarantee' | 'endorsement';
  reason: string;
  suggestion: string;
}

export interface ComplianceReport {
  passed: boolean;
  score: number;
  violations: ComplianceViolation[];
  aiReview?: string;
}

/** 品牌资料（知识库）的 AI 加工输入。 */
export interface KnowledgeDraftInput {
  brand: string;
  category: string;
  /** 运营给的要点，AI 据此扩写成规范条目。 */
  points: string;
  platform?: PlatformCode;
  tone?: string;
  /** 同品牌既有资料，作为口径约束，避免自相矛盾。 */
  references?: Array<{ title: string; content: string }>;
}

export interface KnowledgeDraft {
  title: string;
  content: string;
  tags: string[];
  keywords: string[];
}

export interface KnowledgePolishInput {
  brand: string;
  category: string;
  content: string;
  instruction?: string;
}
