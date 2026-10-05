import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { SettingsService } from '../../settings/settings.service';
import { AiProviderFactory } from '../../ai/ai-provider.factory';
import { ProviderConfigService } from '../../ai/provider-config.service';
import { AiConfigController } from '../ai-config.controller';

/**
 * 保存 AI 配置时的占位符密钥防护。
 *
 * 真实事故（2026-10-05）：恢复中转渠道测试配置时，从 .env 读 AI_API_KEY 写回生产，
 * 而 .env 里是模板占位符 `sk-your-deepseek-api-key` —— 数据库里正在用的真实密钥
 * 被覆盖成假值，线上所有 AI 功能立即 401。
 *
 * 这样的密钥不需要联网就能认出来，必须在**保存前**拒绝，而不是等调用时报 401。
 */
function build() {
  const settings = {
    get: vi.fn(async () => null),
    updateMany: vi.fn(async () => undefined),
    revision: 1,
  } as unknown as SettingsService;
  const providers = {
    create: vi.fn(),
    test: vi.fn(async () => ({ ok: true, provider: 'deepseek', model: 'm', latencyMs: 1 })),
    fetchModels: vi.fn(async () => ['m']),
  } as unknown as AiProviderFactory;
  const configs = {
    listMasked: vi.fn(async () => []),
    find: vi.fn(async () => undefined),
    upsert: vi.fn(async () => []),
  } as unknown as ProviderConfigService;
  return new AiConfigController(settings, providers, configs);
}

describe('AI 配置保存：占位符密钥防护', () => {
  const base = { provider: 'deepseek', model: 'deepseek-v4-flash-0731' };

  it('拒绝 .env 模板里的示例密钥（真实事故场景）', async () => {
    const ctl = build();
    await expect(
      ctl.saveDefault({ ...base, apiKey: 'sk-your-deepseek-api-key' }),
    ).rejects.toThrow(BadRequestException);
    // 关键：绝不能落到写入，否则真实密钥就被覆盖了
    await expect(
      ctl.saveDefault({ ...base, apiKey: 'sk-your-deepseek-api-key' }),
    ).rejects.toThrow(/示例密钥/);
  });

  it('拒绝各类常见占位符写法', async () => {
    const ctl = build();
    const placeholders = [
      'sk-your-openai-key',
      'your-api-key-here',
      'sk-EXAMPLE123',
      'sk-placeholder',
      'sk-changeme',
      'sk-xxxxxxxxxxxx',
    ];
    for (const key of placeholders) {
      await expect(ctl.saveDefault({ ...base, apiKey: key })).rejects.toThrow(BadRequestException);
    }
  });

  it('真实格式的密钥必须放行', async () => {
    const ctl = build();
    // 构造一个不含真实密钥、但格式正常的测试串
    const fake = 'sk-' + 'a1b2c3d4'.repeat(4);
    await expect(ctl.saveDefault({ ...base, apiKey: fake })).resolves.toBeDefined();
  });

  it('未填密钥（留空表示不修改）不受影响', async () => {
    const ctl = build();
    await expect(ctl.saveDefault({ ...base })).resolves.toBeDefined();
    await expect(ctl.saveDefault({ ...base, apiKey: undefined })).resolves.toBeDefined();
  });

  it('界面回显的打码值不会被误判为占位符', async () => {
    const ctl = build();
    // SettingsService 会忽略打码值，控制器不该在这里拦下
    await expect(ctl.saveDefault({ ...base, apiKey: 'sk-d34***fc7f' })).resolves.toBeDefined();
  });

  it('中转渠道地址必填且需带协议，避免留下非法配置', async () => {
    const ctl = build();
    const key = 'sk-' + 'f'.repeat(20);

    // 预置目录里没有的供应商（典型中转场景）：没有默认地址可回落，必须自己填
    await expect(
      ctl.saveDefault({ provider: 'my-relay', model: 'gpt-x', apiKey: key, kind: 'relay', baseUrl: '' }),
    ).rejects.toThrow(/中转/);

    // 填了但没带协议，也要拦下——运行时只会拼出非法 URL
    await expect(
      ctl.saveDefault({ provider: 'my-relay', model: 'gpt-x', apiKey: key, kind: 'relay', baseUrl: 'relay.example.com/v1' }),
    ).rejects.toThrow(/http/);
  });

  it('中转校验不受"是否填了新密钥"影响（沿用旧密钥也必须校验）', async () => {
    const ctl = build();
    // 不传 apiKey：这条路径原本会绕过 ProviderConfigService 的校验
    await expect(
      ctl.saveDefault({ provider: 'my-relay', model: 'gpt-x', kind: 'relay', baseUrl: '' }),
    ).rejects.toThrow(/中转/);
  });
});