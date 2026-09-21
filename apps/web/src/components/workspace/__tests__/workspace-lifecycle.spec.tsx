// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeLifecycleError } from '../../../lib/workspace-lifecycle';
import { ApiError } from '../../../lib/api/client';
import { ArchiveWorkspaceDialog } from '../ArchiveWorkspaceDialog';
import { DeleteWorkspaceDialog } from '../DeleteWorkspaceDialog';
import { WorkspaceExportPanel, formatBytes, isExportExpired } from '../WorkspaceExportPanel';
import { WorkspaceLifecycleCard, purgeCountdownText, type WorkspaceLifecycleInfo } from '../WorkspaceLifecycleCard';

// jsdom + vitest 下 testing-library 不会自动清理，必须显式 cleanup，否则同一文件内多个用例会看到彼此的 DOM。
afterEach(() => cleanup());

const OWNER_CAPS = ['workspace.archive', 'workspace.delete', 'workspace.restore', 'workspace.export'];
const VIEWER_CAPS: string[] = ['content.review'];

const baseInfo: WorkspaceLifecycleInfo = {
  id: '22222222-2222-2222-2222-222222222222',
  name: '默认工作区',
  status: 'active',
  archivedAt: null,
  deletedAt: null,
  purgeAfter: null,
  daysUntilPurge: null,
};

const noop = (): void => undefined;

function renderCard(overrides: Partial<WorkspaceLifecycleInfo>, capabilities: string[]) {
  return render(
    <WorkspaceLifecycleCard
      info={{ ...baseInfo, ...overrides }}
      capabilities={capabilities}
      onArchive={noop}
      onUnarchive={noop}
      onDelete={noop}
      onRestore={noop}
    />,
  );
}

describe('工作区生命周期卡片', () => {
  it('三种状态各自显示对应标签与说明', () => {
    const { rerender } = renderCard({}, OWNER_CAPS);
    expect(screen.getByText('正常')).toBeTruthy();

    rerender(
      <WorkspaceLifecycleCard info={{ ...baseInfo, status: 'archived', archivedAt: '2026-09-20T02:00:00.000Z' }} capabilities={OWNER_CAPS} onArchive={noop} onUnarchive={noop} onDelete={noop} onRestore={noop} />,
    );
    expect(screen.getByText('已归档（只读）')).toBeTruthy();

    rerender(
      <WorkspaceLifecycleCard info={{ ...baseInfo, status: 'soft_deleted', deletedAt: '2026-09-20T02:00:00.000Z', purgeAfter: '2026-10-20T02:00:00.000Z', daysUntilPurge: 29 }} capabilities={OWNER_CAPS} onArchive={noop} onUnarchive={noop} onDelete={noop} onRestore={noop} />,
    );
    expect(screen.getByText('已删除（保留期内可恢复）')).toBeTruthy();
    expect(screen.getByTestId('purge-countdown').textContent).toContain('还剩 29 天可恢复');
  });

  it('倒计时文案：正数天与"今天到期"', () => {
    expect(purgeCountdownText(7)).toBe('还剩 7 天可恢复，到期后数据将被永久清除');
    expect(purgeCountdownText(0)).toContain('今天到期');
    expect(purgeCountdownText(null)).toBe('');
  });

  it('按钮显隐由能力点决定（不写死角色）', () => {
    // 只读账号：看不到任何生命周期按钮
    const { unmount } = renderCard({}, VIEWER_CAPS);
    expect(screen.queryByRole('button', { name: '归档工作区（只读）' })).toBeNull();
    expect(screen.queryByRole('button', { name: '删除工作区' })).toBeNull();
    unmount();

    // 所有者：能归档、能删除
    renderCard({}, OWNER_CAPS);
    expect(screen.getByRole('button', { name: '归档工作区（只读）' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '删除工作区' })).toBeTruthy();
  });

  it('软删态：有恢复能力点显示"恢复"，没有时给出提示', () => {
    const softDeleted = { status: 'soft_deleted' as const, deletedAt: '2026-09-20T02:00:00.000Z', daysUntilPurge: 3 };
    const { unmount } = renderCard(softDeleted, OWNER_CAPS);
    expect(screen.getByRole('button', { name: '恢复工作区' })).toBeTruthy();
    // 软删态下不再显示"删除"按钮（避免重复删除）
    expect(screen.queryByRole('button', { name: '删除工作区' })).toBeNull();
    unmount();

    renderCard(softDeleted, VIEWER_CAPS);
    expect(screen.queryByRole('button', { name: '恢复工作区' })).toBeNull();
    expect(screen.getByTestId('restore-permission-note').textContent).toContain('只有工作区所有者可以恢复');
  });

  it('归档态显示取消归档按钮，并保留归档时间', () => {
    renderCard({ status: 'archived', archivedAt: '2026-09-20T02:00:00.000Z' }, OWNER_CAPS);
    expect(screen.getByRole('button', { name: '取消归档' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '归档工作区（只读）' })).toBeNull();
  });
});

describe('归档/删除确认框', () => {
  it('归档确认框说明"可逆、不删数据"', () => {
    render(<ArchiveWorkspaceDialog open workspaceName="卿尔美" mode="archive" onCancel={noop} onConfirm={noop} />);
    expect(screen.getByTestId('archive-reversible-note').textContent).toContain('不会删除任何数据');
    expect(screen.getByRole('button', { name: '确认归档' })).toBeTruthy();
  });

  it('删除确认框：名称不匹配时不能提交，匹配后才可提交', () => {
    render(<DeleteWorkspaceDialog open workspaceName="默认工作区" isLastWorkspace={false} onCancel={noop} onConfirm={noop} />);
    const confirm = screen.getByRole('button', { name: '确认删除' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/请输入工作区完整名称/), { target: { value: '默认工作' } });
    expect((screen.getByRole('button', { name: '确认删除' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/请输入工作区完整名称/), { target: { value: '默认工作区' } });
    expect((screen.getByRole('button', { name: '确认删除' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('最后一个工作区：红字警告 + 必须勾选确认才能提交，并把标记传给后端', () => {
    const onConfirm = vi.fn();
    render(<DeleteWorkspaceDialog open workspaceName="默认工作区" isLastWorkspace onCancel={noop} onConfirm={onConfirm} />);
    expect(screen.getByTestId('last-workspace-warning').textContent).toContain('最后一个可用的工作区');

    fireEvent.change(screen.getByLabelText(/请输入工作区完整名称/), { target: { value: '默认工作区' } });
    expect((screen.getByRole('button', { name: '确认删除' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    expect(onConfirm).toHaveBeenCalledWith({ confirmName: '默认工作区', confirmLastWorkspace: true });
  });

  it('删除确认框底部写明"永久清除"的出口（联系管理员）', () => {
    render(<DeleteWorkspaceDialog open workspaceName="默认工作区" isLastWorkspace={false} onCancel={noop} onConfirm={noop} />);
    expect(screen.getByTestId('purge-exit-note').textContent).toContain('如需永久清除（不可恢复），请联系管理员按运维手册操作');
  });
});

describe('数据导出面板', () => {
  it('显示 7 天保留期与 15 分钟一次性链接提示', () => {
    render(
      <WorkspaceExportPanel
        capabilities={OWNER_CAPS}
        job={{ id: 'j1', status: 'completed', progress: 100, sizeBytes: 5233, checksum: '4d30822eb62c1f', expiresAt: '2099-01-01T00:00:00.000Z', error: null, createdAt: '2026-09-21T00:00:00.000Z' }}
        link={{ url: 'https://auto.example/api/workspaces/w1/export/j1/download?token=abc', expiresAt: '2099-01-01T00:10:00.000Z' }}
        onStart={noop}
        onRefresh={noop}
        onGetLink={noop}
      />,
    );
    expect(screen.getByText(/导出产物将在 7 天后自动删除，请及时下载/)).toBeTruthy();
    expect(screen.getByTestId('export-link').textContent).toContain('此链接 15 分钟内有效且仅能使用一次');
    expect(screen.getByTestId('export-size').textContent).toBe('5.1 KB');
    expect(screen.getByTestId('export-checksum').textContent).toBe('4d30822eb62c');
  });

  it('产物过期时提示已过期并隐藏下载按钮', () => {
    render(
      <WorkspaceExportPanel
        capabilities={OWNER_CAPS}
        job={{ id: 'j1', status: 'completed', progress: 100, sizeBytes: 5233, checksum: 'abc123', expiresAt: '2000-01-01T00:00:00.000Z', error: null, createdAt: '2026-09-21T00:00:00.000Z' }}
        onStart={noop}
        onRefresh={noop}
        onGetLink={noop}
      />,
    );
    expect(screen.getByTestId('export-expired').textContent).toContain('产物已过期');
    expect(screen.queryByRole('button', { name: '获取下载链接' })).toBeNull();
  });

  it('生成中显示进度且不能重复申请；失败时显示原因', () => {
    const { rerender } = render(
      <WorkspaceExportPanel
        capabilities={OWNER_CAPS}
        job={{ id: 'j1', status: 'running', progress: 60, sizeBytes: null, checksum: null, expiresAt: null, error: null, createdAt: '2026-09-21T00:00:00.000Z' }}
        onStart={noop}
        onRefresh={noop}
        onGetLink={noop}
      />,
    );
    expect(screen.getByTestId('export-progress').textContent).toContain('60%');
    expect((screen.getByRole('button', { name: '重新申请导出' }) as HTMLButtonElement).disabled).toBe(true);

    rerender(
      <WorkspaceExportPanel
        capabilities={OWNER_CAPS}
        job={{ id: 'j1', status: 'failed', progress: 0, sizeBytes: null, checksum: null, expiresAt: null, error: '磁盘写入失败', createdAt: '2026-09-21T00:00:00.000Z' }}
        onStart={noop}
        onRefresh={noop}
        onGetLink={noop}
      />,
    );
    expect(screen.getByText('磁盘写入失败')).toBeTruthy();
  });

  it('没有导出能力点时整个面板不渲染', () => {
    render(
      <WorkspaceExportPanel capabilities={VIEWER_CAPS} job={null} onStart={noop} onRefresh={noop} onGetLink={noop} />,
    );
    expect(screen.queryByTestId('workspace-export-panel')).toBeNull();
  });

  it('formatBytes / isExportExpired 工具函数', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(5233)).toBe('5.1 KB');
    expect(formatBytes(1024 * 1024 * 3)).toBe('3 MB');
    expect(formatBytes(null)).toBe('未知');
    expect(isExportExpired('2000-01-01T00:00:00.000Z')).toBe(true);
    expect(isExportExpired('2099-01-01T00:00:00.000Z')).toBe(false);
    expect(isExportExpired(null)).toBe(false);
  });
});

describe('错误文案映射', () => {
  const cases: Array<[number, Parameters<typeof describeLifecycleError>[1], string]> = [
    [409, 'delete', '发布队列'],
    [409, 'export', '已有导出任务在进行中'],
    [410, 'restore', '已超过保留期'],
    [413, 'export', '5GB'],
    [403, 'delete', '权限'],
  ];

  it.each(cases)('HTTP %s（%s）给出可照做的提示', (status, action, expected) => {
    // 403 用"空消息"验证回退文案；其余用后端原始消息验证被保留下来
    const message = describeLifecycleError(new ApiError(status, status === 403 ? '' : '后端原始信息', status), action);
    expect(message).toContain(expected);
  });

  it('非 ApiError（网络异常等）回退到通用文案', () => {
    expect(describeLifecycleError(new Error('boom'), 'archive')).toBe('归档失败');
  });
});
