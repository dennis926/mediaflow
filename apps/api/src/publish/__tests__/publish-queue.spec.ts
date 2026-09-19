import { describe, expect, it, vi, afterEach } from 'vitest';
import Redis from 'ioredis';
import { applyRuntimeConfig } from '../../modules/settings/runtime-config';
import { PublishQueueService } from '../publish.queue';

/** 极简 ioredis 替身：记录 xadd / xtrim / XPENDING 的调用参数。 */
function redisMock(pendingRaw: unknown = []): {
  client: Redis;
  xadd: ReturnType<typeof vi.fn>;
  xtrim: ReturnType<typeof vi.fn>;
  call: ReturnType<typeof vi.fn>;
} {
  const xadd = vi.fn(async () => '1700000000000-0');
  const xtrim = vi.fn(async () => 123);
  const call = vi.fn(async () => pendingRaw);
  const client = {
    xadd,
    xtrim,
    call,
    xgroup: vi.fn(async () => 'OK'),
    duplicate: () => ({ xreadgroup: vi.fn(async () => null), quit: vi.fn(async () => 'OK'), disconnect: vi.fn() }),
  } as unknown as Redis;
  return { client, xadd, xtrim, call };
}

describe('发布队列长度保护（任务 4b，含未确认消息保护）', () => {
  afterEach(() => applyRuntimeConfig({}));

  it('入队不做 MAXLEN 自动修剪（实测会误删未 ack 的消息）', async () => {
    const { client, xadd } = redisMock();
    const queue = new PublishQueueService(client);

    await queue.enqueue('task-1');

    const args = xadd.mock.calls[0] as unknown as string[];
    expect(args[0]).toBe('mediaflow:publish:tasks');
    expect(args).not.toContain('MAXLEN');
    expect(args.slice(1, 2)).toEqual(['*']);
    expect(args).toContain('task-1');
  });

  it('有未 ack 消息时用 MINID 修剪，保留待确认消息', async () => {
    const { client, xtrim, call } = redisMock([['1700000000000-5', 'c1', 1, 0]]);
    const queue = new PublishQueueService(client);

    const result = await queue.trim();

    expect(call).toHaveBeenCalledWith('XPENDING', 'mediaflow:publish:tasks', 'publish-workers', '-', '+', '1');
    expect(xtrim).toHaveBeenCalledWith('mediaflow:publish:tasks', 'MINID', '~', '1700000000000-5');
    expect(result.floor).toBe('1700000000000-5');
    expect(result.removed).toBe(123);
  });

  it('没有未 ack 消息时按 MAXLEN 上限修剪', async () => {
    const { client, xtrim } = redisMock([]);
    const queue = new PublishQueueService(client);

    const result = await queue.trim();

    expect(xtrim).toHaveBeenCalledWith('mediaflow:publish:tasks', 'MAXLEN', '~', '10000');
    expect(result.floor).toBeNull();
  });

  it('上限与流名可在「设置 → 发布队列」里调整', async () => {
    applyRuntimeConfig({ PUBLISH_STREAM_MAXLEN: '2500', PUBLISH_STREAM_NAME: 'test:publish:stream' });
    const { client, xtrim } = redisMock([]);
    const queue = new PublishQueueService(client);

    await queue.trim();

    expect(xtrim).toHaveBeenCalledWith('test:publish:stream', 'MAXLEN', '~', '2500');
  });

  it('修剪失败不影响主流程（返回 0 而不是抛错）', async () => {
    const { client, xtrim } = redisMock([]);
    xtrim.mockRejectedValueOnce(new Error('ERR unknown command'));
    const queue = new PublishQueueService(client);

    await expect(queue.trim()).resolves.toEqual({ removed: 0, floor: null });
  });

  it('XPENDING 不可用时退化为按长度修剪（不阻塞队列）', async () => {
    const { client, xtrim, call } = redisMock([]);
    call.mockRejectedValueOnce(new Error('NOPROTO'));
    const queue = new PublishQueueService(client);

    const result = await queue.trim();

    expect(result.floor).toBeNull();
    expect(xtrim).toHaveBeenCalledWith('mediaflow:publish:tasks', 'MAXLEN', '~', '10000');
  });
});

describe('清理已消失任务的队列消息（任务 8c：防止 Worker 处理幽灵任务）', () => {
  /** 极简 ioredis 替身：只提供 xrange 与 call，用于观察 XDEL 的一举一动。 */
  function streamMock(entries: Array<[string, string[]]>) {
    const xrange = vi.fn(async () => entries);
    const call = vi.fn(async () => 'OK');
    const client = { xrange, call } as unknown as Redis;
    return { client, xrange, call };
  }

  it('只删除 taskId 命中的消息，其他消息（含别的未确认消息）不动', async () => {
    const { client, call } = streamMock([
      ['1-0', ['taskId', 'me-1', 'enqueuedAt', '2026-01-01T00:00:00.000Z']],
      ['2-0', ['taskId', 'other-1', 'enqueuedAt', '2026-01-01T00:00:01.000Z']],
      ['3-0', ['taskId', 'me-2', 'enqueuedAt', '2026-01-01T00:00:02.000Z']],
    ]);
    const queue = new PublishQueueService(client);

    const result = await queue.removeByTaskIds(['me-1', 'me-2']);

    expect(result).toEqual({ removed: 2, inspected: 3, matched: ['1-0', '3-0'] });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith('XDEL', 'mediaflow:publish:tasks', '1-0', '3-0');
  });

  it('空 taskIds 时直接返回，不发起 XDEL（避免误清空队列）', async () => {
    const { client, xrange, call } = streamMock([['1-0', ['taskId', 'me-1']]]);
    const queue = new PublishQueueService(client);

    const result = await queue.removeByTaskIds([]);

    expect(result).toEqual({ removed: 0, inspected: 0, matched: [] });
    expect(xrange).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it('消息字段畸形或缺 taskId 时跳过，不误删', async () => {
    const { client, call } = streamMock([
      ['1-0', ['enqueuedAt', '2026-01-01T00:00:00.000Z']],
      ['2-0', ['taskId']],
      ['3-0', []],
    ]);
    const queue = new PublishQueueService(client);

    const result = await queue.removeByTaskIds(['me-1']);

    expect(result.removed).toBe(0);
    expect(result.inspected).toBe(3);
    expect(call).not.toHaveBeenCalled();
  });

  it('重复调用是幂等的：第二次没有命中就不会再 XDEL', async () => {
    const entries: Array<[string, string[]]> = [['1-0', ['taskId', 'me-1']]];
    const xrange = vi.fn(async () => entries);
    const call = vi.fn(async () => 'OK');
    const queue = new PublishQueueService({ xrange, call } as unknown as Redis);

    const first = await queue.removeByTaskIds(['me-1']);
    entries.length = 0; // 模拟 XDEL 之后流里已无该消息
    const second = await queue.removeByTaskIds(['me-1']);

    expect(first.removed).toBe(1);
    expect(second.removed).toBe(0);
    expect(call).toHaveBeenCalledTimes(1);
  });
});
