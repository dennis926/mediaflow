export type AiTaskType = 'generate' | 'adapt' | 'optimize_title' | 'compliance_check';

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
