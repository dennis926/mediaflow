import { ObjectLiteral, Repository } from 'typeorm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiFlagType, PlatformCode } from '@mediaflow/shared';
import { applyRuntimeConfig } from '../../settings/runtime-config';
import { WorkspaceContextService } from '../../../common/workspace-context.service';
import { AiProviderFactory } from '../ai-provider.factory';
import { AiGeneration } from '../entities/ai-generation.entity';
import { AdaptInput, AiService } from '../ai.service';
import { ModelPricingService } from '../model-pricing.service';

const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';

const pricing = {
  costOf: vi.fn(async () => ({
    cost: '0.000010',
    price: { input: 2, output: 8, cacheWrite: 2, cacheRead: 0.5 },
    source: 'catalog',
    breakdown: { total: 0.00001, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
  })),
} as unknown as ModelPricingService;

/** 第一次返回坏 JSON（代码块 + 尾逗号），第二次返回干净 JSON —— 复现真实模型的抖动。 */
function buildService(replies: string[]): { service: AiService; complete: ReturnType<typeof vi.fn> } {
  const queue = [...replies];
  const complete = vi.fn(async () => ({
    text: queue.shift() ?? '',
    model: 'deepseek-flash',
    tokensInput: 100,
    tokensOutput: 50,
    tokensCached: 0,
    tokensReasoning: 0,
    finishReason: 'stop',
  }));

  const generations = {
    create: vi.fn((value: unknown) => value),
    save: vi.fn(async (value: ObjectLiteral) => ({ ...value, id: 'gen-1' })),
  } as unknown as Repository<AiGeneration>;

  const providers = {
    get: vi.fn(async () => ({ name: 'deepseek', model: 'deepseek-flash', complete })),
  } as unknown as AiProviderFactory;

  const workspaceContext = {
    current: vi.fn(async () => ({ tenantId: '11111111-1111-4111-8111-111111111111', workspaceId: WORKSPACE_ID })),
  } as unknown as WorkspaceContextService;

  return { service: new AiService(generations, providers, workspaceContext, pricing), complete };
}

const adaptInput: AdaptInput = {
  title: '标题',
  body: '正文内容',
  tags: ['标签'],
  platforms: [PlatformCode.WechatMp],
  aiFlagType: AiFlagType.None,
};

describe('AI JSON 容错与重试', () => {
  afterEach(() => applyRuntimeConfig({}));

  it('模型返回代码块包裹的 JSON 时自动修复，不触发重试', async () => {
    const broken = '```json\n{"variants":[{"platform":"wechat_mp","title":"标题","body":"正文","tags":["标签"]}]}\n```';
    const { service, complete } = buildService([broken]);

    const result = await service.adapt(adaptInput, {});

    expect(result.variants).toHaveLength(1);
    expect(result.variants[0].platform).toBe('wechat_mp');
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('抢救出的版本不完整（缺正文）时重试一次并收紧指令', async () => {
    // 截断在正文之前：抢救后标题在、正文缺失 —— 属于"不完整"，必须重试
    const truncated = '{"variants":[{"platform":"wechat_mp","title":"标题"';
    const good = '{"variants":[{"platform":"wechat_mp","title":"好标题","body":"好正文","tags":[]}]}';
    const { service, complete } = buildService([truncated, good]);

    const result = await service.adapt(adaptInput, {});

    expect(complete).toHaveBeenCalledTimes(2);
    const secondCall = complete.mock.calls[1][0] as { system: string; temperature: number; maxTokens: number };
    expect(secondCall.system).toContain('只输出一个 JSON 对象');
    expect(secondCall.temperature).toBe(0);
    expect(secondCall.maxTokens).toBeGreaterThan(4096);
    expect(result.variants[0].title).toBe('好标题');
  });

  it('两次都拿不到结构化结果时给出可读错误', async () => {
    const { service, complete } = buildService(['抱歉，我无法完成这个请求。', '还是不行，抱歉。']);

    await expect(service.adapt(adaptInput, {})).rejects.toThrow(/不是合法 JSON|未返回可用的平台版本/);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('输出被 max_tokens 截断时报"调大输出长度"而不是笼统的解析失败', async () => {
    const generations = {
      create: vi.fn((value: unknown) => value),
      save: vi.fn(async (value: ObjectLiteral) => ({ ...value, id: 'gen-1' })),
    } as unknown as Repository<AiGeneration>;
    const complete = vi.fn(async () => ({
      text: '{"variants":[{"platform":"wechat_mp","title":"标题"',
      model: 'deepseek-flash',
      tokensInput: 10,
      tokensOutput: 10,
      finishReason: 'length',
    }));
    const providers = { get: vi.fn(async () => ({ name: 'deepseek', model: 'deepseek-flash', complete })) } as unknown as AiProviderFactory;
    const workspaceContext = {
      current: vi.fn(async () => ({ tenantId: 't', workspaceId: WORKSPACE_ID })),
    } as unknown as WorkspaceContextService;
    const service = new AiService(generations, providers, workspaceContext, pricing);

    await expect(service.adapt(adaptInput, {})).rejects.toThrow(/最大长度截断/);
  });
});
