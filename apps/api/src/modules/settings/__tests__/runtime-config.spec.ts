import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SITE,
  DEFAULT_KNOWLEDGE_RUNTIME,
  DEFAULT_PUBLISH_RUNTIME,
  applyRuntimeConfig,
  estimateCost,
  runtime,
} from '../runtime-config';

describe('运行时配置（可配置化中心）', () => {
  afterEach(() => {
    applyRuntimeConfig({});
  });

  it('没有配置时使用默认值', () => {
    applyRuntimeConfig({});
    const config = runtime();
    expect(config.site.name).toBe(DEFAULT_SITE.name);
    expect(config.knowledge.injectLimit).toBe(DEFAULT_KNOWLEDGE_RUNTIME.injectLimit);
    expect(config.publish.streamName).toBe(DEFAULT_PUBLISH_RUNTIME.streamName);
    expect(config.site.brandColor).toBe(DEFAULT_SITE.brandColor);
  });

  it('数值/布尔/文本按类型解析并夹在合理范围', () => {
    applyRuntimeConfig({
      KB_INJECT_LIMIT: '99',
      UI_PAGE_SIZE: '999',
      KB_OCR_ENABLED: 'false',
      PUBLISH_MAX_ATTEMPTS: '7',
      SITE_NAME: '矩阵云',
    });
    const config = runtime();
    expect(config.knowledge.injectLimit).toBe(20); // 上限 20
    expect(config.site.pageSize).toBe(100); // 上限 100
    expect(config.knowledge.ocrEnabled).toBe(false);
    expect(config.publish.maxAttempts).toBe(7);
    expect(config.site.name).toBe('矩阵云');
  });

  it('非法颜色回退默认，避免把界面搞成不可读', () => {
    applyRuntimeConfig({ SITE_BRAND_COLOR: '紫色' });
    expect(runtime().site.brandColor).toBe(DEFAULT_SITE.brandColor);

    applyRuntimeConfig({ SITE_BRAND_COLOR: '#1fa97a' });
    expect(runtime().site.brandColor).toBe('#1FA97A');
  });

  it('坏 JSON 不抛异常，回退默认并给出提示', () => {
    const onError = vi.fn();
    applyRuntimeConfig({ COMPLIANCE_RULES: '{不是 JSON', PERMISSION_MATRIX: 'oops' }, onError);

    expect(onError).toHaveBeenCalled();
    expect(runtime().compliance.length).toBeGreaterThan(0);
    expect(runtime().permissions.matrix['settings.write']).toEqual(['owner', 'admin']);
  });

  it('合规词库按配置生效并可打分', () => {
    applyRuntimeConfig({
      COMPLIANCE_RULES: JSON.stringify([
        { category: 'absolute_term', terms: ['包治百病'], reason: '自定义红线', suggestion: '删掉', penalty: 30 },
      ]),
    });
    const rules = runtime().compliance;
    expect(rules).toHaveLength(1);
    expect(rules[0].terms).toContain('包治百病');
    expect(rules[0].penalty).toBe(30);
  });

  it('成本按可配置单价估算，单价为 0 时不计成本', () => {
    applyRuntimeConfig({});
    expect(estimateCost(1_000_000, 0)).toBe('0');

    applyRuntimeConfig({ AI_PRICE_INPUT_PER_MTOK: '2', AI_PRICE_OUTPUT_PER_MTOK: '8' });
    expect(estimateCost(500_000, 250_000)).toBe('3.000000'); // 0.5M×2 元 + 0.25M×8 元
  });

  it('队列名可改，默认保持兼容', () => {
    applyRuntimeConfig({ PUBLISH_STREAM_NAME: 'tenant-a:queue', PUBLISH_GROUP_NAME: 'group-a' });
    expect(runtime().publish.streamName).toBe('tenant-a:queue');
    expect(runtime().publish.groupName).toBe('group-a');
  });

  it('空字符串视为未配置（回退默认）', () => {
    applyRuntimeConfig({ SITE_NAME: '   ', KB_CHUNK_SIZE: '' });
    expect(runtime().site.name).toBe(DEFAULT_SITE.name);
    expect(runtime().knowledge.chunkSize).toBe(DEFAULT_KNOWLEDGE_RUNTIME.chunkSize);
  });
});
