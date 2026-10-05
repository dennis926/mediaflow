import { describe, expect, it } from 'vitest';
import { AiFlagType, appendAiDisclosure, requiresAiDisclosure } from '@mediaflow/shared';

/**
 * AI 标识策略变更的守卫测试。
 *
 * 用户明确要求：「为什么一定要加 AI 辅助生成，不要加这个，默认就是没有」。
 * 所以 `appendAiDisclosure` 现在**不再被内容链路调用**（创建/更新/适配/回填全部移除），
 * 但函数本身仍保留——知识库等其它入口可能用到，而且删掉会让历史数据的兼容性无从判断。
 *
 * 这里守住两件事：
 *   ① 函数语义本身没被改坏（将来若有人重新启用，行为是可预期的）；
 *   ② 「人工撰写」永远不产生任何追加文案。
 */
describe('AI 标识文案', () => {
  it('人工撰写不追加任何内容', () => {
    expect(requiresAiDisclosure(AiFlagType.None)).toBe(false);
    expect(appendAiDisclosure('正文', AiFlagType.None)).toBe('正文');
  });

  it('标记为 AI 参与时，显式标识只追加一次', () => {
    const once = appendAiDisclosure('正文', AiFlagType.Assisted);
    expect(once).toContain('AI');
    // 幂等：重复调用不会叠加第二遍
    expect(appendAiDisclosure(once, AiFlagType.Assisted)).toBe(once);
  });

  it('三种 AI 参与类型都需要标识，人工撰写不需要', () => {
    expect(requiresAiDisclosure(AiFlagType.FullyGenerated)).toBe(true);
    expect(requiresAiDisclosure(AiFlagType.Assisted)).toBe(true);
    expect(requiresAiDisclosure(AiFlagType.Translated)).toBe(true);
    expect(requiresAiDisclosure(AiFlagType.None)).toBe(false);
  });

  it('标识后缀可配置（交给别的公司时能改成自己的措辞）', () => {
    const custom = appendAiDisclosure('正文', AiFlagType.Assisted, '（AI 生成）');
    expect(custom.endsWith('（AI 生成）')).toBe(true);
  });
});
