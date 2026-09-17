import { runtime } from '../settings/runtime-config';
import { ComplianceViolation } from './ai.types';

/**
 * 违规词来自可配置的合规词库（设置 → 合规词库），换行业/换品类改配置即可，
 * 不用改代码；命中即按配置的原因与建议返回。
 */
export function checkCompliance(text: string): ComplianceViolation[] {
  const violations: ComplianceViolation[] = [];
  for (const rule of runtime().compliance) {
    for (const term of rule.terms) {
      if (!term || !text.includes(term)) continue;
      violations.push({ term, category: rule.category, reason: rule.reason, suggestion: rule.suggestion });
    }
  }
  return violations;
}

export function scoreViolations(violations: ComplianceViolation[]): number {
  const ruleFor = (category: ComplianceViolation['category']): number =>
    runtime().compliance.find((rule) => rule.category === category)?.penalty ?? 10;
  const penalty = violations.reduce((total, violation) => total + ruleFor(violation.category), 0);
  return Math.max(0, 100 - penalty);
}
