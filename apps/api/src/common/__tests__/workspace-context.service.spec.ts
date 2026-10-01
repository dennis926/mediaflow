import { Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceContextService } from '../workspace-context.service';
import { runInWorkspaceScope } from '../workspace-context.store';
import { Workspace } from '../../modules/workspace/entities/workspace.entity';

const DEFAULT_WORKSPACE = {
  id: '11111111-1111-1111-1111-111111111111',
  tenantId: '99999999-9999-9999-9999-999999999999',
  name: '默认工作区',
  slug: 'default',
  createdAt: new Date('2026-01-01'),
} as unknown as Workspace;

function buildService(): { service: WorkspaceContextService; workspaces: Repository<Workspace> } {
  const workspaces = { find: vi.fn(async () => [DEFAULT_WORKSPACE]) } as unknown as Repository<Workspace>;
  return { service: new WorkspaceContextService(workspaces), workspaces };
}

describe('工作区作用域（多工作区隔离）', () => {
  it('请求作用域优先：令牌里的工作区覆盖默认工作区', async () => {
    const { service } = buildService();
    const scope = { tenantId: 'tenant-a', workspaceId: 'workspace-a' };

    const resolved = await runInWorkspaceScope(scope, () => service.current());

    expect(resolved).toEqual(scope);
  });

  it('没有请求作用域时回退默认工作区（后台任务场景）', async () => {
    const { service, workspaces } = buildService();

    const resolved = await service.current();

    expect(resolved.workspaceId).toBe(DEFAULT_WORKSPACE.id);
    expect(workspaces.find).toHaveBeenCalled();
  });

  it('作用域不会泄漏到外部上下文（请求之间互不影响）', async () => {
    const { service } = buildService();

    await runInWorkspaceScope({ tenantId: 'tenant-a', workspaceId: 'workspace-a' }, () => service.current());
    const outside = await service.current();

    expect(outside.workspaceId).toBe(DEFAULT_WORKSPACE.id);
  });

  it('默认工作区每次回退都重新读取（不缓存，避免工作区被删除/改名后作用域陈旧）', async () => {
    const { service, workspaces } = buildService();

    await service.current();
    await service.current();

    // 每次调用各查一次：后台任务频率很低（分钟级），一次索引查询远比"作用域指向已删除工作区"划算
    expect(workspaces.find).toHaveBeenCalledTimes(2);
  });
});
