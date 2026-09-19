import { describe, expect, it } from 'vitest';
import { AiFlagType } from '../../types/content';
import { AI_DISCLOSURE_TEXT, AI_METADATA_KEY } from '../../constants';
import { appendAiDisclosure, buildAiMetadata, requiresAiDisclosure } from '../ai-flag';

/**
 * 审计 P1-3：AI 生成内容必须带显式标识（正文末尾）与隐式标识（元数据）。
 * 修复点：translated（AI 翻译/改写）此前没有显式标识。
 */
describe('AI 生成内容标识（合规 / 审计 P1-3）', () => {
  it('完全生成 / 辅助生成 / AI 翻译 都需要显式标识', () => {
    expect(requiresAiDisclosure(AiFlagType.FullyGenerated)).toBe(true);
    expect(requiresAiDisclosure(AiFlagType.Assisted)).toBe(true);
    expect(requiresAiDisclosure(AiFlagType.Translated)).toBe(true);
  });

  it('人工撰写（none）不加标识', () => {
    expect(requiresAiDisclosure(AiFlagType.None)).toBe(false);
  });

  it('追加标识：只在末尾加一次，重复调用不叠加', () => {
    const once = appendAiDisclosure('正文内容', AiFlagType.Assisted);
    expect(once.endsWith(AI_DISCLOSURE_TEXT)).toBe(true);
    expect(once).toContain('正文内容');

    const twice = appendAiDisclosure(once, AiFlagType.Assisted);
    expect(twice).toBe(once);
    expect(twice.split(AI_DISCLOSURE_TEXT)).toHaveLength(2);
  });

  it('翻译内容也必须被追加标识（P1-3 的回归防线）', () => {
    const translated = appendAiDisclosure('Translated copy', AiFlagType.Translated);
    expect(translated.endsWith(AI_DISCLOSURE_TEXT)).toBe(true);
  });

  it('隐式标识：元数据里带 is-ai 标记与模型名', () => {
    const generated = buildAiMetadata(AiFlagType.FullyGenerated, 'deepseek-flash');
    expect(generated[AI_METADATA_KEY]).toBe('true');
    expect(generated.model).toBe('deepseek-flash');
    expect(generated.flagType).toBe(AiFlagType.FullyGenerated);

    const manual = buildAiMetadata(AiFlagType.None, 'none');
    expect(manual[AI_METADATA_KEY]).toBe('false');
  });

  it('自定义标识文案（站点可配置）也能正确追加', () => {
    const custom = appendAiDisclosure('正文', AiFlagType.Assisted, '（本内容由 AI 生成）');
    expect(custom.endsWith('（本内容由 AI 生成）')).toBe(true);
  });
});
