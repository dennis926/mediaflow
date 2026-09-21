import type { QuotaService } from '../../billing/quota.service';
import { HttpException, HttpStatus } from '@nestjs/common';
import { ObjectLiteral, Repository } from 'typeorm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyRuntimeConfig } from '../../settings/runtime-config';
import { WorkspaceContextService } from '../../../common/workspace-context.service';
import { AiProviderFactory } from '../ai-provider.factory';
import { AiGeneration } from '../entities/ai-generation.entity';
import { AiService } from '../ai.service';
import { ModelPricingService } from '../model-pricing.service';

const WORKSPACE_ID = '22222222-2222-2222-2222-222222222222';

const pricing = {
  priceFor: vi.fn(async () => ({
    provider: 'deepseek', providerLabel: 'DeepSeek', model: 'mock-model', label: 'Mock',
    price: { input: 2, output: 8, cacheWrite: 2, cacheRead: 0.5 },
    officialUsd: { input: 0.28, output: 0.42, cacheWrite: 0, cacheRead: 0.028 },
    source: 'catalog', configured: true, reference: true,
  })),
  computeCost: vi.fn((tokens: { input: number; output: number; cacheWrite?: number; cacheRead?: number }) => {
    const perMillion = (count: number, unit: number): number => (Math.max(0, count) / 1_000_000) * unit;
    const input = perMillion(tokens.input, 2); const output = perMillion(tokens.output, 8);
    const cacheWrite = perMillion(tokens.cacheWrite ?? 0, 2); const cacheRead = perMillion(tokens.cacheRead ?? 0, 0.5);
    return { total: input + output + cacheWrite + cacheRead, input, output, cacheWrite, cacheRead };
  }),
  costOf: vi.fn(async () => ({ cost: '0.000010', price: { input: 2, output: 8, cacheWrite: 2, cacheRead: 0.5 }, source: 'catalog', breakdown: { total: 0.00001, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } })),
  list: vi.fn(async () => []),
  rules: vi.fn(async () => ({ usdToCny: 7, description: 'test' })),
  rate: vi.fn(async () => 7),
  catalog: vi.fn(() => []),
} as unknown as ModelPricingService;

function buildService(overrides: { recentCount?: number; dailyTokens?: number } = {}): AiService {
  const generations = {
    count: vi.fn(async () => overrides.recentCount ?? 0),
    createQueryBuilder: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      getRawOne: vi.fn(async () => ({ total: String(overrides.dailyTokens ?? 0) })),
    })),
    create: vi.fn((value: unknown) => value),
    save: vi.fn(async (value: ObjectLiteral) => ({ ...value, id: 'gen-1' })),
    findAndCount: vi.fn(async () => [[], 0]),
  } as unknown as Repository<AiGeneration>;

  const providers = {
    get: vi.fn(async () => ({
      name: 'mock',
      model: 'mock-model',
      complete: vi.fn(async () => ({ text: '连接正常', model: 'mock-model', tokensInput: 10, tokensOutput: 5 })),
    })),
    describe: vi.fn(async () => ({ provider: 'mock', model: 'mock-model' })),
  } as unknown as AiProviderFactory;

  const workspaceContext = { current: vi.fn(async () => ({ tenantId: 't', workspaceId: WORKSPACE_ID })) } as unknown as WorkspaceContextService;
  return new AiService(generations, providers, workspaceContext, pricing, quotaStub);
}

/** B0.7：配额服务替身（默认放行、记录用量） */
const quotaStub = {
  assertQuota: vi.fn(async () => undefined),
  recordUsage: vi.fn(async () => undefined),
  status: vi.fn(async () => null),
  statusAll: vi.fn(async () => []),
  effectivePlan: vi.fn(async () => ({ code: 'test', name: '测试计划' })),
} as unknown as QuotaService;

describe('AI 额度保护（可配置）', () => {
  afterEach(() => applyRuntimeConfig({}));

  it('未配置限流时不拦截', async () => {
    const service = buildService({ recentCount: 999 });
    await expect(service.generate('你好', undefined, {})).resolves.toBeTruthy();
  });

  it('每分钟次数超限时抛出 429 并说明可调整位置', async () => {
    applyRuntimeConfig({ AI_RATE_LIMIT_PER_MINUTE: '2' });
    const service = buildService({ recentCount: 2 });

    await expect(service.generate('你好', undefined, {})).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
    await expect(service.generate('你好', undefined, {})).rejects.toThrow(/每分钟最多 2 次/);
  });

  it('当日 token 达到上限时停止调用', async () => {
    applyRuntimeConfig({ AI_DAILY_TOKEN_QUOTA: '1000' });
    const service = buildService({ dailyTokens: 1000 });

    await expect(service.generate('你好', undefined, {})).rejects.toBeInstanceOf(HttpException);
    await expect(service.generate('你好', undefined, {})).rejects.toThrow(/今日 AI 额度已用完/);
  });

  it('额度充足时正常调用', async () => {
    applyRuntimeConfig({ AI_RATE_LIMIT_PER_MINUTE: '10', AI_DAILY_TOKEN_QUOTA: '1000' });
    const service = buildService({ recentCount: 1, dailyTokens: 10 });
    const result = await service.generate('你好', undefined, {});
    expect(result.text).toBe('连接正常');
  });
});
