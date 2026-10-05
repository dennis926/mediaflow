import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  CAPABILITY_GROUPS,
  CAPABILITY_LABELS,
  DANGEROUS_CAPABILITIES,
} from '../../auth/capabilities';

/**
 * 权限分组表的结构约束。
 *
 * 这些断言守的是"界面上不会漏项、也不会出现裸代码"：
 * 用户要求权限用勾选表格选，所以分组表必须覆盖**每一个**能力点——
 * 漏一个就意味着某条权限在界面上根本没法勾，只能回去手写 JSON。
 */
describe('权限分组表', () => {
  it('每个能力点都必须在某个分组里出现（且只出现一次）', () => {
    const grouped = CAPABILITY_GROUPS.flatMap((group) => group.capabilities);
    expect(new Set(grouped).size, '同一个能力点不能出现在两个分组').toBe(grouped.length);
    for (const capability of CAPABILITIES) {
      expect(grouped, `能力点 ${capability} 没有出现在任何分组里，界面上将无法勾选`).toContain(capability);
    }
  });

  it('每个能力点都有中文名（界面上不能出现裸代码）', () => {
    for (const capability of CAPABILITIES) {
      const label = CAPABILITY_LABELS[capability];
      expect(label, `能力点 ${capability} 缺少中文名`).toBeTruthy();
      expect(label).not.toBe(capability);
    }
  });

  it('每个分组都有标题与说明', () => {
    for (const group of CAPABILITY_GROUPS) {
      expect(group.label).toBeTruthy();
      expect(group.description).toBeTruthy();
      expect(group.capabilities.length, `分组 ${group.group} 是空的`).toBeGreaterThan(0);
    }
  });

  it('高风险能力点必须在能力点全集内', () => {
    for (const capability of DANGEROUS_CAPABILITIES) {
      expect(CAPABILITIES).toContain(capability);
    }
    // 至少要有几个高危项，否则界面上永远不会出现红色标记（说明标注漏了）
    expect(DANGEROUS_CAPABILITIES.length).toBeGreaterThan(0);
  });
});
