import { describe, expect, it } from 'vitest';
import { checkCompliance, scoreViolations } from '../compliance.rules';

describe('checkCompliance', () => {
  it('flags medical efficacy claims', () => {
    const violations = checkCompliance('本品可以治疗糖尿病并降血糖');
    expect(violations.map((violation) => violation.term)).toEqual(expect.arrayContaining(['治疗', '降血糖']));
    expect(violations.every((violation) => violation.category === 'medical_claim')).toBe(true);
  });

  it('flags absolute wording', () => {
    const violations = checkCompliance('这是效果最好的产品，国家级配方');
    expect(violations.map((violation) => violation.term)).toEqual(expect.arrayContaining(['最好', '国家级']));
  });

  it('flags guarantees and medical endorsements', () => {
    const violations = checkCompliance('保证见效，医院推荐使用');
    expect(violations.map((violation) => violation.category)).toEqual(
      expect.arrayContaining(['guarantee', 'endorsement']),
    );
  });

  it('deduplicates repeated terms and passes clean copy', () => {
    expect(checkCompliance('治疗，治疗，还是治疗')).toHaveLength(1);
    expect(checkCompliance('本品为食品，日常营养补充，建议搭配均衡饮食。')).toHaveLength(0);
  });

  it('scores violations by severity', () => {
    expect(scoreViolations([])).toBe(100);
    expect(scoreViolations(checkCompliance('治疗糖尿病'))).toBe(75);
  });
});
