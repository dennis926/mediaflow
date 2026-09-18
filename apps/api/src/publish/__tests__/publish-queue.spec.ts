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
