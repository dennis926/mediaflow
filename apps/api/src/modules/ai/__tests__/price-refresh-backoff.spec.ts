import { describe, expect, it, vi } from 'vitest';
import { OfficialPriceRefreshTask } from '../pricing/official-price-refresh.task';
import type { ModelPricingService } from '../model-pricing.service';

/**
 * 定时抓取的退避行为。
 *
 * 这组用例守的是一个真实缺陷：退避时长原先只写进日志，请求照发——火山引擎的
 * 人机校验就是被这样一轮轮打出来的（快照里「连续失败 4 次」仍在每轮重试）。
 * 退避必须是**真的跳过**。
 */

/** 把「上次运行时间」清零，让下一轮立刻可跑（否则要等真实间隔）。 */
function tickNow(task: OfficialPriceRefreshTask): Promise<void> {
  (task as unknown as { lastRunAt: number }).lastRunAt = 0;
  return task.tick();
}

/** 清空退避表，等价于「退避已到期」。 */
function clearBackoff(task: OfficialPriceRefreshTask): void {
  (task as unknown as { backoffUntil: Map<string, number> }).backoffUntil.clear();
}

function build(options: { enabled?: boolean; interval?: number; fail?: string[] } = {}) {
  const calls: Array<ReadonlySet<string>> = [];
  const failing = new Set(options.fail ?? []);
  const pricing = {
    officialRefreshEnabled: vi.fn(async () => options.enabled ?? true),
    officialRefreshIntervalMinutes: vi.fn(async () => options.interval ?? 720),
    refreshAllOfficialPrices: vi.fn(async (skip: ReadonlySet<string> = new Set()) => {
      calls.push(skip);
      const failed = [...failing]
        .filter((provider) => !skip.has(provider))
        .map((provider) => ({ provider, message: '人机校验页' }));
      return { succeeded: [], failed };
    }),
  } as unknown as ModelPricingService;
  return { task: new OfficialPriceRefreshTask(pricing), calls, pricing };
}

describe('定时抓取：退避必须真的跳过', () => {
  it('第 1 次失败不额外退避（偶发抖动不该被当成封禁）', async () => {
    const { task } = build({ fail: ['doubao'] });
    await tickNow(task);
    expect(task.failureCounts()).toEqual({ doubao: 1 });
    expect(task.backoffState()).toEqual({});
  });

  it('第 2 次失败后进入退避，下一轮不再请求该供应商', async () => {
    const { task, calls } = build({ fail: ['doubao'] });
    await tickNow(task); // 第 1 次失败 → 无退避
    await tickNow(task); // 第 2 次失败 → 进入退避
    expect(task.failureCounts()).toEqual({ doubao: 2 });
    expect(task.backoffState().doubao).toBeGreaterThan(0);

    calls.length = 0;
    await tickNow(task); // 退避中 → 应跳过
    expect(calls).toHaveLength(1);
    expect([...calls[0]]).toContain('doubao');
    // 被跳过不算「又失败一次」，计数不再增长
    expect(task.failureCounts()).toEqual({ doubao: 2 });
  });

  it('退避时长按 2^n 递增并封顶 24 小时', async () => {
    const { task } = build({ fail: ['doubao'] });
    // 跑到第 12 次失败：2^11 分钟 = 2048 分钟 > 1440，应封顶
    for (let i = 0; i < 12; i += 1) {
      clearBackoff(task); // 视为每轮退避都已到期，才能连续累计失败次数
      await tickNow(task);
    }
    expect(task.failureCounts().doubao).toBe(12);
    expect(task.backoffState().doubao).toBeLessThanOrEqual(24 * 60);
  });

  it('成功后退避与失败计数一并清零', async () => {
    let failing = true;
    const pricing = {
      officialRefreshEnabled: vi.fn(async () => true),
      officialRefreshIntervalMinutes: vi.fn(async () => 720),
      refreshAllOfficialPrices: vi.fn(async (skip: ReadonlySet<string> = new Set()) => {
        if (failing && !skip.has('doubao')) {
          return { succeeded: [], failed: [{ provider: 'doubao', message: '人机校验页' }] };
        }
        return {
          succeeded: [{ provider: 'doubao', sourceUrl: 'x', fetchedAt: 'now', prices: [] }],
          failed: [],
        };
      }),
    } as unknown as ModelPricingService;
    const task = new OfficialPriceRefreshTask(pricing);

    await tickNow(task);
    await tickNow(task);
    expect(task.backoffState().doubao).toBeGreaterThan(0);

    // 站点恢复：退避未到期时会被跳过，因此先清空退避表（视为到期）
    failing = false;
    clearBackoff(task);
    await tickNow(task);
    expect(task.failureCounts()).toEqual({});
    expect(task.backoffState()).toEqual({});
  });

  it('关闭开关时不抓取', async () => {
    const { task, calls } = build({ enabled: false });
    await tickNow(task);
    expect(calls).toHaveLength(0);
  });

  it('间隔未到时不重复抓取', async () => {
    const { task, calls } = build({ interval: 720 });
    await task.tick();
    await task.tick();
    expect(calls).toHaveLength(1);
  });
});
