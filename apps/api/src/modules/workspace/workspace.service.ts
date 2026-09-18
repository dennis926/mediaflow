import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AuditService } from '../../audit/audit.service';
import { WorkspaceContextService } from '../../common/workspace-context.service';
import { RoleCode } from './entities/role.entity';
import { WorkspaceMember } from './entities/workspace-member.entity';
import { User } from './entities/user.entity';
import { Workspace, WorkspaceStatus } from './entities/workspace.entity';

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  status: WorkspaceStatus;
  roleCodes: RoleCode[];
  isCurrent: boolean;
}

export interface WorkspaceMemberView {
  userId: string;
  displayName: string;
  email: string;
  roleCodes: RoleCode[];
  joinedAt: string;
}

/**
 * 工作区（租户内的业务空间）管理与成员维护。
 *
 * 同一实例里可以放多个工作区（例如同时运营两家公司/两个品牌矩阵），
 * 数据全部按 workspace_id 隔离；用户在哪个工作区、以什么角色，由 workspace_members 决定。
 */
@Injectable()
export class WorkspaceService {
  private readonly logger = new Logger(WorkspaceService.name);

  constructor(
    @InjectRepository(Workspace) private readonly workspaces: Repository<Workspace>,
    @InjectRepository(WorkspaceMember) private readonly members: Repository<WorkspaceMember>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly workspaceContext: WorkspaceContextService,
    private readonly audit: AuditService,
  ) {}

  /** 当前用户能看到/切换的工作区列表。 */
  async listMine(userId: string): Promise<WorkspaceSummary[]> {
    const scope = await this.workspaceContext.current();
    const rows = await this.members.find({ where: { userId } });
    if (rows.length === 0) return [];

    const workspaces = await this.workspaces.find({ where: { id: In(rows.map((row) => row.workspaceId)) } });
    const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));

    const summaries: WorkspaceSummary[] = [];
    for (const row of rows) {
      const workspace = byId.get(row.workspaceId);
      if (!workspace) continue;
      summaries.push({
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        status: workspace.status,
        roleCodes: row.roleCodes ?? [],
        isCurrent: workspace.id === scope.workspaceId,
      });
    }

    return summaries.sort(
      (left, right) => Number(right.isCurrent) - Number(left.isCurrent) || left.name.localeCompare(right.name),
    );
  }

  /** 校验用户是否属于某工作区，并返回其在该工作区的角色。 */
  async membership(userId: string, workspaceId: string): Promise<{ workspace: Workspace; roleCodes: RoleCode[] }> {
    const member = await this.members.findOne({ where: { userId, workspaceId } });
    if (!member) throw new NotFoundException('你不是该工作区的成员');
    const workspace = await this.workspaces.findOne({ where: { id: workspaceId } });
    if (!workspace) throw new NotFoundException('工作区不存在');
    if (workspace.status !== 'active') throw new BadRequestException('该工作区已停用');
    return { workspace, roleCodes: member.roleCodes ?? [] };
  }

  /** 创建工作区：创建者自动成为该工作区的所有者。 */
  async create(input: { name: string; slug?: string }, actor: { id?: string | null; name?: string | null }): Promise<WorkspaceSummary> {
    const scope = await this.workspaceContext.current();
    const name = input.name.trim();
    if (!name) throw new BadRequestException('工作区名称不能为空');

    const slug = (input.slug?.trim() || this.slugify(name)).slice(0, 50);
    const existing = await this.workspaces.findOne({ where: { slug } });
    if (existing) throw new BadRequestException(`标识「${slug}」已被占用，请换一个`);

    const workspace = await this.workspaces.save(
      this.workspaces.create({
        tenantId: scope.tenantId,
        // workspaces 表自身也带 workspace_id（与其他表保持一致），这里指向自己
        workspaceId: '00000000-0000-0000-0000-000000000000',
        name,
        slug,
        status: 'active',
        settings: {},
      }),
    );
    await this.workspaces.update({ id: workspace.id }, { workspaceId: workspace.id });

    if (actor.id) {
      await this.members.save(
        this.members.create({
          tenantId: scope.tenantId,
          workspaceId: workspace.id,
          userId: actor.id,
          roleCodes: ['owner'],
          invitedBy: null,
        }),
      );
    }

    await this.audit.record({
      action: 'workspace.create',
      resourceType: 'workspace',
      resourceId: workspace.id,
      tenantId: scope.tenantId,
      workspaceId: workspace.id,
      actorId: actor.id ?? null,
      actorName: actor.name ?? null,
      payload: { name, slug },
    });
    this.logger.log(`工作区已创建：${name}（${slug}）`);
    return { id: workspace.id, name, slug, status: 'active', roleCodes: ['owner'], isCurrent: false };
  }

  async members_(workspaceId: string): Promise<WorkspaceMemberView[]> {
    const rows = await this.members.find({ where: { workspaceId } });
    const users = new Map<string, User>();
    const ids = [...new Set(rows.map((row) => row.userId))];
    if (ids.length > 0) {
      for (const user of await this.users.find({ where: { id: In(ids) }, select: ['id', 'displayName', 'email'] })) {
        users.set(user.id, user);
      }
    }
    return rows.map((row) => {
      const user = users.get(row.userId);
      return {
        userId: row.userId,
        displayName: user?.displayName ?? '（已删除用户）',
        email: user?.email ?? '',
        roleCodes: row.roleCodes ?? [],
        joinedAt: row.createdAt.toISOString(),
      };
    });
  }

  /** 添加或调整成员角色（同一工作区内幂等）。 */
  async upsertMember(
    workspaceId: string,
    input: { userId: string; roleCodes: RoleCode[] },
    actor: { id?: string | null; name?: string | null },
  ): Promise<WorkspaceMemberView> {
    if (input.roleCodes.length === 0) throw new BadRequestException('至少选择一个角色');
    const scope = await this.workspaceContext.current();
    const existing = await this.members.findOne({ where: { workspaceId, userId: input.userId } });
    if (existing) {
      await this.members.update({ id: existing.id }, { roleCodes: input.roleCodes });
    } else {
      await this.members.save(
        this.members.create({
          tenantId: scope.tenantId,
          workspaceId,
          userId: input.userId,
          roleCodes: input.roleCodes,
          invitedBy: actor.id ?? null,
        }),
      );
    }
    await this.audit.record({
      action: existing ? 'workspace.member_update' : 'workspace.member_add',
      resourceType: 'workspace_member',
      resourceId: input.userId,
      tenantId: scope.tenantId,
      workspaceId,
      actorId: actor.id ?? null,
      actorName: actor.name ?? null,
      payload: { roleCodes: input.roleCodes },
    });
    const list = await this.members_(workspaceId);
    return list.find((item) => item.userId === input.userId) as WorkspaceMemberView;
  }

  /** 移除成员；不允许把工作区最后一个所有者移除。 */
  async removeMember(workspaceId: string, userId: string, actor: { id?: string | null; name?: string | null }): Promise<{ userId: string }> {
    const scope = await this.workspaceContext.current();
    const member = await this.members.findOne({ where: { workspaceId, userId } });
    if (!member) throw new NotFoundException('该成员不在这个工作区');

    if ((member.roleCodes ?? []).includes('owner')) {
      const owners = (await this.members.find({ where: { workspaceId } })).filter((row) => (row.roleCodes ?? []).includes('owner'));
      if (owners.length <= 1) throw new BadRequestException('至少要保留一名工作区所有者');
    }

    await this.members.delete({ id: member.id });
    await this.audit.record({
      action: 'workspace.member_remove',
      resourceType: 'workspace_member',
      resourceId: userId,
      tenantId: scope.tenantId,
      workspaceId,
      actorId: actor.id ?? null,
      actorName: actor.name ?? null,
      payload: { removedUserId: userId },
    });
    return { userId };
  }

  private slugify(name: string): string {
    const ascii = name
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return ascii.length > 0 ? ascii : `workspace-${Date.now().toString(36)}`;
  }
}
