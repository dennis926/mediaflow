import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Workspace } from '../modules/workspace/entities/workspace.entity';
import { WorkspaceScope, currentWorkspaceScope } from './workspace-context.store';

export type { WorkspaceScope } from './workspace-context.store';

/**
 * 解析当前请求的工作区作用域：
 * 1. 优先用请求作用域（由 WorkspaceScopeInterceptor 从令牌写入，见 workspace-context.store.ts）；
 * 2. 后台任务（cron / 队列 worker）没有请求，回退到默认工作区（第一个创建的工作区）。
 *
 * 注意：**不要**在这里缓存成字段给所有请求复用——多工作区场景会串数据（历史缺陷）。
 */
@Injectable()
export class WorkspaceContextService {
  private readonly logger = new Logger(WorkspaceContextService.name);
  private cached: WorkspaceScope | null = null;

  constructor(@InjectRepository(Workspace) private readonly workspaces: Repository<Workspace>) {}

  async current(): Promise<WorkspaceScope> {
    const scoped = currentWorkspaceScope();
    if (scoped) return scoped;

    if (this.cached) return this.cached;
    const workspace = await this.workspaces.find({ order: { createdAt: 'ASC' }, take: 1 });
    const first = workspace[0];
    if (!first) {
      throw new NotFoundException('系统尚未初始化工作区，请先执行 pnpm seed');
    }
    this.cached = { tenantId: first.tenantId, workspaceId: first.id };
    this.logger.log(`后台任务使用默认工作区：${first.name}（${first.slug}）`);
    return this.cached;
  }
}
