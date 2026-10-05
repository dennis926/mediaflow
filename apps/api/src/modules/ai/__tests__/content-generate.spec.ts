import type { QuotaService } from '../../billing/quota.service';
import { ObjectLiteral, Repository } from 'typeorm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformCode } from '@mediaflow/shared';
import { applyRuntimeConfig } from '../../settings/runtime-config';
import { WorkspaceContextService } from '../../../common/workspace-context.service';
import { AiProviderFactory } from '../ai-provider.factory';
import { AiGeneration } from '../entities/ai-generation.entity';
import { AiService } from '../ai.service';
import { ModelPricingService } from '../model-pricing.service';

/**
 * 内容中心「AI 一键生成」（POST /contents/ai-draft）的核心：`AiService.generateContent`。
 *
 * 这组用例守三件事：
 *   1. 主题、平台、语气、关键词、字数要求真的进了 prompt（否则用户填了等于没填）；
 *   2. 品牌资料被拼进 prompt（这是"不编造"的唯一依据），且 id 记入 inputRefs 可追溯；
 *   3. 返回的草案结构可用（标题/摘要/正文/标签），坏 JSON 有明确报错而不是静默产出空内容。
 */

const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';

const pricing = {
  costOf: vi.fn(async () => ({
    cost: '0.000010',
    price: { input: 2, output: 8, cacheWrite: 2, cacheRead: 0.5 },
    source: 'catalog',
    breakdown: { total: 0.00001, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
  })),
} as unknown as ModelPricingService;

const quotaStub = {
  assertQuota: vi.fn(async () => undefined),
  recordUsage: vi.fn(async () => undefined),
  status: vi.fn(async () => null),
  statusAll: vi.fn(async () => []),
  effectivePlan: vi.fn(async () => ({ code: 'test', name: '测试计划' })),
} as unknown as QuotaService;

function buildService(reply: string): {
  service: AiService;
  complete: ReturnType<typeof vi.fn>;
  saved: ObjectLiteral[];
} {
  const complete = vi.fn(async () => ({
    text: reply,
    model: 'deepseek-flash',
    tokensInput: 100,
    tokensOutput: 200,
    tokensCached: 0,
    tokensReasoning: 0,
    finishReason: 'stop',
  }));

  const saved: ObjectLiteral[] = [];
  const generations = {
    create: vi.fn((value: ObjectLiteral) => value),
    save: vi.fn(async (value: ObjectLiteral) => {
      saved.push(value);
      return { ...value, id: 'gen-1' };
    }),
  } as unknown as Repository<AiGeneration>;

  const providers = {
    get: vi.fn(async () => ({ name: 'deepseek', model: 'deepseek-flash', complete })),
  } as unknown as AiProviderFactory;

  const workspaceContext = {
    current: vi.fn(async () => ({ tenantId: '11111111-1111-4111-8111-111111111111', workspaceId: WORKSPACE_ID })),
  } as unknown as WorkspaceContextService;

  return {
    service: new AiService(generations, providers, workspaceContext, pricing, quotaStub),
    complete,
    saved,
  };
}

/** 一次合法的模型返回。 */
const GOOD_JSON = JSON.stringify({
  title: '秋季肠道健康：膳食纤维怎么补',
  summary: '讲清膳食纤维的作用与日常补充方式。',
  body: '秋天气候转凉，肠道菌群也会随之变化。\n\n膳食纤维是肠道菌群的重要食粮，日常可通过全谷物、豆类与蔬果补充。\n\n卿尔美膳食纤维特膳粉以菊粉、低聚果糖等水溶性膳食纤维为配方基础，按说明冲调即可。',
  tags: ['肠道健康', '膳食纤维', '秋季养生'],
});

/** 取出本次调用实际发给模型的 user prompt。 */
const userPromptOf = (complete: ReturnType<typeof vi.fn>): string =>
  String((complete.mock.calls[0]?.[0] as { user?: string } | undefined)?.user ?? '');

const taskOf = (complete: ReturnType<typeof vi.fn>): string =>
  String((complete.mock.calls[0]?.[0] as { task?: string } | undefined)?.task ?? '');

describe('内容中心：AI 一键生成（generateContent）', () => {
  afterEach(() => applyRuntimeConfig({}));

  it('主题、平台、语气、关键词、字数都写进了 prompt', async () => {
    const { service, complete } = buildService(GOOD_JSON);

    await service.generateContent(
      {
        topic: '秋季肠道健康科普',
        platform: PlatformCode.Xiaohongshu,
        tone: '亲切',
        keywords: ['膳食纤维', '肠道菌群'],
        wordCount: 600,
      },
      {},
    );

    const prompt = userPromptOf(complete);
    expect(prompt).toContain('秋季肠道健康科普');
    expect(prompt).toContain('xiaohongshu');
    expect(prompt).toContain('语气=亲切');
    expect(prompt).toContain('膳食纤维,肠道菌群');
    expect(prompt).toContain('约 600 字');
  });

  it('未填的可选项不出现在 prompt 里（不留空占位）', async () => {
    const { service, complete } = buildService(GOOD_JSON);

    await service.generateContent({ topic: '肠道健康' }, {});

    const prompt = userPromptOf(complete);
    expect(prompt).not.toContain('语气=');
    expect(prompt).not.toContain('必须覆盖的关键词=');
    expect(prompt).not.toContain('目标平台：');
    expect(prompt).not.toContain('正文长度约');
  });

  it('品牌资料被拼进 prompt，并要求"资料里没有的不得编造"', async () => {
    const { service, complete, saved } = buildService(GOOD_JSON);

    const result = await service.generateContent(
      {
        topic: '膳食纤维的作用',
        brand: '卿尔美',
        knowledge: {
          ids: ['k1', 'k2'],
          section: '以下是品牌方提供的资料，生成内容时必须遵守（不得编造资料中没有的功效、成分或认证）：\n1. 【卿尔美·产品】膳食纤维特膳粉\n配料为菊粉、低聚果糖。',
        },
      },
      { inputRefs: { topic: '膳食纤维的作用', knowledgeIds: ['k1', 'k2'] } },
    );

    const prompt = userPromptOf(complete);
    expect(prompt).toContain('品牌方提供的资料');
    expect(prompt).toContain('菊粉、低聚果糖');
    expect(prompt).toContain('品牌=卿尔美');
    // 引用的资料 id 必须留痕，否则日后无法解释 AI 的依据
    expect(result.generationId).toBe('gen-1');
    expect(saved[0]?.inputRefs).toMatchObject({ knowledgeIds: ['k1', 'k2'] });
  });

  it('任务类型是 content_generate，与知识库起草区分开（便于按任务统计花费）', async () => {
    const { service, complete } = buildService(GOOD_JSON);

    await service.generateContent({ topic: '肠道健康' }, {});

    expect(taskOf(complete)).toBe('content_generate');
  });

  it('返回可直接填入表单的草案结构', async () => {
    const { service } = buildService(GOOD_JSON);

    const result = await service.generateContent({ topic: '秋季肠道健康科普' }, {});

    expect(result.model).toBe('deepseek-flash');
    expect(result.draft.title).toBe('秋季肠道健康：膳食纤维怎么补');
    expect(result.draft.summary).toContain('膳食纤维');
    expect(result.draft.body.length).toBeGreaterThan(50);
    expect(result.draft.tags).toEqual(['肠道健康', '膳食纤维', '秋季养生']);
  });

  it('标签超过 8 个时截断，避免模型塞一堆无意义标签', async () => {
    const many = JSON.stringify({
      title: '标题',
      summary: '摘要',
      body: '正文'.repeat(40),
      tags: Array.from({ length: 15 }, (_, index) => `标签${index}`),
    });
    const { service } = buildService(many);

    const result = await service.generateContent({ topic: '肠道健康' }, {});

    expect(result.draft.tags).toHaveLength(8);
  });

  it('正文过短时报错，而不是静默产出空内容让用户以为生成成功', async () => {
    const tooShort = JSON.stringify({ title: '标题', summary: '摘要', body: '太短', tags: [] });
    const { service } = buildService(tooShort);

    await expect(service.generateContent({ topic: '肠道健康' }, {})).rejects.toThrow(/过短/);
  });

  it('模型返回坏 JSON 时抛错，不返回半成品', async () => {
    const { service } = buildService('这不是 JSON');
    await expect(service.generateContent({ topic: '肠道健康' }, {})).rejects.toThrow();
  });

  it('缺标题时用正文开头兜底，保证填进表单的标题非空', async () => {
    const noTitle = JSON.stringify({
      summary: '摘要',
      body: '膳食纤维是肠道菌群的重要食粮，日常可通过全谷物、豆类与蔬果补充。秋天饮食偏燥，更要注意饮水与纤维摄入的搭配，按产品说明冲调饮用即可。',
      tags: ['肠道健康'],
    });
    const { service } = buildService(noTitle);

    const result = await service.generateContent({ topic: '肠道健康' }, {});

    expect(result.draft.title.length).toBeGreaterThan(0);
  });
});
