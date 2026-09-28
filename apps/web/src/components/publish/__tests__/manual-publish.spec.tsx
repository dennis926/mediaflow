// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublishTask } from '../../../lib/api/types';
import { ManualPublishDialog } from '../ManualPublishDialog';

/**
 * 人工发布回填对话框（无平台密钥时的主路径）。
 *
 * 断言的重点是"成员真的能把事情做完"：
 *   ① 成品文本 = 标题 + 正文 + 话题标签（可直接粘到平台后台），并能一键复制；
 *   ② 标记已发布会带上链接与备注调用接口；
 *   ③ 标记失败必须填原因（按钮在原因 < 2 字时禁用），不会误提交空原因；
 *   ④ 接口报错时把后端消息显示出来，而不是静默失败。
 */
const getContent = vi.fn();
const getVariants = vi.fn();
const markPublished = vi.fn();
const markFailed = vi.fn();

vi.mock('../../../lib/api/endpoints', () => ({
  contentApi: {
    get: (...args: unknown[]) => getContent(...args),
    variants: (...args: unknown[]) => getVariants(...args),
  },
  publishApi: {
    markManualPublished: (...args: unknown[]) => markPublished(...args),
    markManualFailed: (...args: unknown[]) => markFailed(...args),
  },
}));

const task = {
  id: 'task-1',
  contentId: 'content-1',
  platform: 'wechat_mp',
  status: 'manual_required',
} as unknown as PublishTask;

function renderDialog(props: Partial<Parameters<typeof ManualPublishDialog>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ManualPublishDialog open task={task} onClose={() => undefined} {...props} />
    </QueryClientProvider>,
  );
}

describe('人工发布回填对话框', () => {
  beforeEach(() => {
    getContent.mockResolvedValue({
      id: 'content-1',
      title: '益生菌怎么吃',
      body: '正文内容……\n\n（本文由 AI 辅助生成）',
      tags: ['益生菌', '肠道健康'],
    });
    getVariants.mockResolvedValue([]);
    markPublished.mockResolvedValue({ ...task, status: 'published' });
    markFailed.mockResolvedValue({ ...task, status: 'failed' });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('展示可直接粘贴的成品文本（标题 + 正文 + 话题），并保留 AI 显式标识', async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('manual-copy-preview').textContent ?? '').toContain('益生菌怎么吃'));

    const preview = screen.getByTestId('manual-copy-preview').textContent ?? '';
    expect(preview).toContain('益生菌怎么吃');
    expect(preview).toContain('本文由 AI 辅助生成');
    expect(preview).toContain('#益生菌');
    expect(preview).toContain('#肠道健康');
  });

  it('复制按钮把成品文本写进剪贴板', async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    // jsdom 里 navigator.clipboard 是 getter-only：必须用 defineProperty 才能真正替换
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('manual-copy-preview').textContent ?? '').toContain('益生菌怎么吃'));

    fireEvent.click(screen.getByRole('button', { name: '复制正文' }));

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0][0])).toContain('本文由 AI 辅助生成');
    await waitFor(() => expect(screen.getByRole('button', { name: '已复制 ✓' })).toBeTruthy());
  });

  it('标记已发布：带上链接与备注调用接口', async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('manual-copy-preview').textContent ?? '').toContain('益生菌怎么吃'));

    fireEvent.change(screen.getByLabelText('发布后的链接（可选）'), { target: { value: 'https://mp.weixin.qq.com/s/abc' } });
    fireEvent.change(screen.getByLabelText('备注（可选）'), { target: { value: '未群发' } });
    fireEvent.click(screen.getByRole('button', { name: '标记已发布' }));

    await waitFor(() => expect(markPublished).toHaveBeenCalledTimes(1));
    expect(markPublished.mock.calls[0][0]).toBe('task-1');
    expect(markPublished.mock.calls[0][1]).toEqual({ url: 'https://mp.weixin.qq.com/s/abc', note: '未群发' });
    await waitFor(() => expect(screen.getByText('已回填为「已发布」，数据与审计都已记录')).toBeTruthy());
  });

  it('标记失败：原因不足 2 字时禁用按钮，填了才提交', async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('manual-copy-preview').textContent ?? '').toContain('益生菌怎么吃'));

    const failButton = screen.getByRole('button', { name: '标记发布失败' }) as HTMLButtonElement;
    expect(failButton.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('失败原因（标记失败时必填）'), { target: { value: '图' } });
    expect((screen.getByRole('button', { name: '标记发布失败' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('失败原因（标记失败时必填）'), { target: { value: '平台提示图片尺寸不合规' } });
    fireEvent.click(screen.getByRole('button', { name: '标记发布失败' }));

    await waitFor(() => expect(markFailed).toHaveBeenCalledTimes(1));
    expect(markFailed.mock.calls[0][1]).toEqual({ reason: '平台提示图片尺寸不合规' });
  });

  it('接口报错时展示后端消息（不静默失败）', async () => {
    markPublished.mockRejectedValue(new Error('该任务已标记为已发布；如需更正链接请用「标记失败」重开后再回填'));
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('manual-copy-preview').textContent ?? '').toContain('益生菌怎么吃'));

    fireEvent.click(screen.getByRole('button', { name: '标记已发布' }));
    await waitFor(() => expect(screen.getByText('回填失败')).toBeTruthy());
  });
});
