import { describe, expect, it } from 'vitest';
import { REVIEW_STATUS_LABELS, REVIEW_STATUS_TONES, roleLabel, roleTone } from '../roles';

describe('移动端角色与状态映射', () => {
  it('内置角色有中文名，未知角色原样返回', () => {
    expect(roleLabel('owner')).toBe('所有者');
    expect(roleLabel('reviewer')).toBe('审核员');
    expect(roleLabel('unknown-role')).toBe('unknown-role');
  });

  it('角色配色回退为默认', () => {
    expect(roleTone('admin')).toBe('info');
    expect(roleTone('nope')).toBe('default');
  });

  it('四种审核状态都有中文名与配色', () => {
    for (const status of ['pending', 'approved', 'rejected', 'changes_requested']) {
      expect(REVIEW_STATUS_LABELS[status]).toBeTruthy();
      expect(REVIEW_STATUS_TONES[status]).toBeTruthy();
    }
  });
});
