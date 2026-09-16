import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Workspace } from '../modules/workspace/entities/workspace.entity';

export interface WorkspaceScope {
  tenantId: string;
  workspaceId: string;
}

/**
 * Resolves the workspace scope for requests. Until the auth layer exists every request
 * runs inside the default (first created) workspace.
 */
@Injectable()
export class WorkspaceContextService {
  private readonly logger = new Logger(WorkspaceContextService.name);
  private cached: WorkspaceScope | null = null;

  constructor(@InjectRepository(Workspace) private readonly workspaces: Repository<Workspace>) {}

  async current(): Promise<WorkspaceScope> {
    if (this.cached) return this.cached;
    const workspace = await this.workspaces.find({ order: { createdAt: 'ASC' }, take: 1 });
    const first = workspace[0];
    if (!first) {
      throw new NotFoundException('系统尚未初始化工作区，请先执行 pnpm seed');
    }
    this.cached = { tenantId: first.tenantId, workspaceId: first.id };
    this.logger.log(`当前工作区：${first.name}（${first.slug}）`);
    return this.cached;
  }
}
