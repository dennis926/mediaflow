import { ComplianceViolation } from './ai.types';

interface RuleDefinition {
  category: ComplianceViolation['category'];
  pattern: RegExp;
  reason: string;
  suggestion: string;
}

/**
 * Advertising law red lines for food / health products (framework: no medical efficacy claims,
 * no absolute wording, no guaranteed results, no medical endorsements).
 */
const RULES: RuleDefinition[] = [
  {
    category: 'medical_claim',
    pattern: /(治疗|治愈|根治|痊愈|疗效|药用|处方|主治|抗癌|抗肿瘤|降血糖|降血压|降血脂|消炎|杀菌)/g,
    reason: '食品不得宣称疾病治疗或药理作用',
    suggestion: '改为"有助于/日常营养支持"等非治疗性表述',
  },
  {
    category: 'absolute_term',
    pattern: /(最好|最佳|最有效|最强|最优|第一|国家级|最高级|顶级|特效|包治|100%有效|百分百|永久|彻底解决)/g,
    reason: '《广告法》禁止使用绝对化用语',
    suggestion: '删除绝对化描述，改为具体、可验证的事实描述',
  },
  {
    category: 'guarantee',
    pattern: /(保证见效|保证治愈|无效退款|立竿见影|一次见效|当天见效)/g,
    reason: '不得对效果作出保证性承诺',
    suggestion: '删除效果承诺，补充个体差异说明',
  },
  {
    category: 'endorsement',
    pattern: /(医院推荐|医生推荐|专家推荐|临床验证特效|药监局认证疗效)/g,
    reason: '不得利用医疗机构、专家名义作证明',
    suggestion: '删除医疗机构/专家背书表述',
  },
];

export function checkCompliance(text: string): ComplianceViolation[] {
  const violations: ComplianceViolation[] = [];
  for (const rule of RULES) {
    const matches = text.match(rule.pattern);
    if (!matches) continue;
    for (const term of new Set(matches)) {
      violations.push({ term, category: rule.category, reason: rule.reason, suggestion: rule.suggestion });
    }
  }
  return violations;
}

export function scoreViolations(violations: ComplianceViolation[]): number {
  const penalty = violations.reduce((total, violation) => {
    switch (violation.category) {
      case 'medical_claim':
        return total + 25;
      case 'guarantee':
        return total + 20;
      case 'endorsement':
        return total + 20;
      default:
        return total + 10;
    }
  }, 0);
  return Math.max(0, 100 - penalty);
}
