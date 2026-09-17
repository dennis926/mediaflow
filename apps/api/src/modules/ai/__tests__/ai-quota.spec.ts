import { HttpException, HttpStatus } from '@nestjs/common';
import { ObjectLiteral, Repository } from 'typeorm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyRuntimeConfig } from '../../settings/runtime-config';
import { WorkspaceContextService } from '../../../common/workspace-context.service';
import { AiProviderFactory } from '../ai-provider.factory';
import { AiGeneration } from '../entities/ai-generation.entity';
import { AiService } from '../ai.service';

const WORKSPACE_ID = '22222222-2222-2222-2222-222222222222';

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
  return new AiService(generations, providers, workspaceContext);
}

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
