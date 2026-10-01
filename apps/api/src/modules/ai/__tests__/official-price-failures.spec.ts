import { describe, expect, it, vi } from 'vitest';
import { SettingsService } from '../../settings/settings.service';
import { OfficialPriceStore } from '../pricing/official-price.store';
import type { ScrapeResult } from '../pricing/types';

/**
 * 官网价格快照的「失败留痕」行为。
 *
 * 这一组用例守的是一个具体缺陷：豆包（火山引擎）从上线起就被反爬拦截，
 * 但旧实现只在「该供应商曾经成功过」时才写失败原因，于是它在快照里
 * 完全不存在——界面上既看不出它被配置过，也看不出它为什么没有价格。
 */
function buildStore(initial: string | null = null): { store: OfficialPriceStore; values: Record<string, string> } {
  const values: Record<string, string> = {};
  if (initial !== null) values.AI_OFFICIAL_PRICES = initial;
  const settings = {
    get: vi.fn(async (key: string) => values[key] ?? null),
    updateMany: vi.fn(async (rows: Array<{ key: string; value: string }>) => {
      for (const row of rows) values[row.key] = row.value;
    }),
  } as unknown as SettingsService;
  return { store: new OfficialPriceStore(settings), values };
}

function result(provider: string, models: string[], fetchedAt = '2026-10-02T00:00:00.000Z'): ScrapeResult {
  return {
    provider,
    sourceUrl: `https://example.test/${provider}`,
    fetchedAt,
    prices: models.map((model) => ({
      model,
      currency: 'CNY' as const,
      peak: { input: 1, output: 2, cacheWrite: 1, cacheRead: 0 },
      offpeak: { input: 0.5, output: 1, cacheWrite: 0.5, cacheRead: 0 },
    })),
  };
}

describe('官网价格快照：失败留痕', () => {
  it('从未成功抓取过的供应商也要建档，并记录失败原因与来源', async () => {
    const { store } = buildStore();
    await store.recordFailure('doubao', '检测到人机校验页', 'https://www.volcengine.com/docs/82379/1099320');

    const snapshot = await store.read();
    const entry = snapshot?.detail?.doubao;
    expect(entry).toBeDefined();
    expect(entry?.error).toBe('检测到人机校验页');
    expect(entry?.failedAt).toBeTruthy();
    expect(entry?.consecutiveFailures).toBe(1);
    // 从未成功过 → fetchedAt 为空，界面才能区分「从未成功」与「上次成功时间」
    expect(entry?.fetchedAt).toBe('');
    expect(entry?.sourceUrl).toBe('https://www.volcengine.com/docs/82379/1099320');
    expect(entry?.failures?.[0].message).toBe('检测到人机校验页');
  });

  it('连续失败累加计数，并保留失败历史（新→旧，有上限）', async () => {
    const { store } = buildStore();
    for (let i = 1; i <= 3; i += 1) {
      await store.recordFailure('doubao', `第 ${i} 次失败`);
    }
    const entry = (await store.read())?.detail?.doubao;
    expect(entry?.consecutiveFailures).toBe(3);
    expect(entry?.failures?.map((item) => item.message)).toEqual([
      '第 3 次失败',
      '第 2 次失败',
      '第 1 次失败',
    ]);
  });

  it('失败不推进「上次成功时间」，也不覆盖上一份可用价格', async () => {
    const { store } = buildStore();
    await store.save(result('zhipu', ['glm-5.3'], '2026-10-01T00:00:00.000Z'));
    await store.recordFailure('zhipu', '页面结构变化', 'https://example.test/zhipu');

    const entry = (await store.read())?.detail?.zhipu;
    expect(entry?.fetchedAt).toBe('2026-10-01T00:00:00.000Z');
    expect(Object.keys(entry?.models ?? {})).toEqual(['glm-5.3']);
    expect(entry?.error).toBe('页面结构变化');
    expect(entry?.consecutiveFailures).toBe(1);
  });

  it('抓取成功后清空当前错误与失败计数，但保留失败历史', async () => {
    const { store } = buildStore();
    await store.recordFailure('doubao', '人机校验页', 'https://example.test/doubao');
    await store.save(result('doubao', ['doubao-pro'], '2026-10-02T01:00:00.000Z'));

    const entry = (await store.read())?.detail?.doubao;
    expect(entry?.error).toBeUndefined();
    expect(entry?.consecutiveFailures).toBeUndefined();
    expect(entry?.fetchedAt).toBe('2026-10-02T01:00:00.000Z');
    expect(Object.keys(entry?.models ?? {})).toEqual(['doubao-pro']);
    // 历史保留：一次成功不该抹掉「这家曾经被拦截过」
    expect(entry?.failures?.[0].message).toBe('人机校验页');
  });

  it('一家失败不影响其他供应商的成功时间与模型', async () => {
    const { store } = buildStore();
    await store.saveMany([
      result('deepseek', ['deepseek-flash'], '2026-10-02T00:00:00.000Z'),
      result('kimi', ['kimi-k3'], '2026-10-02T00:00:01.000Z'),
    ]);
    await store.recordFailure('doubao', '人机校验页', 'https://example.test/doubao');

    const snapshot = await store.read();
    expect(Object.keys(snapshot?.detail ?? {}).sort()).toEqual(['deepseek', 'doubao', 'kimi']);
    expect(snapshot?.detail?.deepseek.error).toBeUndefined();
    expect(snapshot?.detail?.kimi.fetchedAt).toBe('2026-10-02T00:00:01.000Z');
    expect(snapshot?.detail?.doubao.error).toBe('人机校验页');
  });

  it('失败记录上限为 20 条，避免设置项无限膨胀', async () => {
    const { store } = buildStore();
    for (let i = 0; i < 25; i += 1) {
      await store.recordFailure('doubao', `第 ${i} 次`);
    }
    const entry = (await store.read())?.detail?.doubao;
    expect(entry?.failures?.length).toBe(20);
    expect(entry?.failures?.[0].message).toBe('第 24 次');
    expect(entry?.consecutiveFailures).toBe(25);
  });

  it('快照 JSON 损坏时返回 null，不抛异常', async () => {
    const { store } = buildStore('{ 这不是 JSON');
    expect(await store.read()).toBeNull();
  });
});
