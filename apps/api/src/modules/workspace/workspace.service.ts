import { BadRequestException, ConflictException, ForbiddenException, GoneException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { AuditService } from '../../audit/audit.service';
import { WorkspaceContextService } from '../../common/workspace-context.service';
import { RoleCode } from './entities/role.entity';
import { WorkspaceMember } from './entities/workspace-member.entity';
import { User } from './entities/user.entity';
import { AuthSessionService } from '../auth/auth-session.service';
import { Workspace, WorkspaceStatus } from './entities/workspace.entity';
import { WorkspaceExportJob } from './entities/workspace-export-job.entity';
import { DataDeletionRequest, DataDeletionRequestStatus } from './entities/data-deletion-request.entity';
import { PublishTask } from '../publish/entities/publish-task.entity';
import { NotificationService } from '../notification/notification.service';
import { runtime } from '../settings/runtime-config';

/** 合规删除请求的状态视图（B0.6）：前端/合规人员据此看"承诺何时前清除、是否已完成"。 */
export interface DeletionRequestView {
  id: string;
  status: DataDeletionRequestStatus;
  requestedAt: string;
  dueAt: string;
  /** 距离承诺期限还有几天（负数表示已逾期） */
  daysUntilDue: number;
  completedAt: string | null;
  purgeBatchId: string | null;
  reason: string | null;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  status: WorkspaceStatus;
  roleCodes: RoleCode[];
  isCurrent: boolean;
}

export interface WorkspaceStatusView {
  id: string;
  name: string;
  slug: string;
  status: WorkspaceStatus;
  archivedAt: string | null;
  deletedAt: string | null;
  purgeAfter: string | null;
  /** 距离永久清除还有几天（仅软删态有值），前端用来显示倒计时 */
  daysUntilPurge: number | null;
}

export interface WorkspaceActor {
  id?: string | null;
  name?: string | null;
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
  /** 合规删除承诺期限（天）：收到请求后必须在此期限内完成永久清除 */
  private static readonly COMPLIANCE_DELETION_DAYS = 30;

  constructor(
    @InjectRepository(Workspace) private readonly workspaces: Repository<Workspace>,
    @InjectRepository(WorkspaceMember) private readonly members: Repository<WorkspaceMember>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(PublishTask) private readonly tasks: Repository<PublishTask>,
    @InjectRepository(WorkspaceExportJob) private readonly exportJobs: Repository<WorkspaceExportJob>,
    @InjectRepository(DataDeletionRequest) private readonly deletionRequests: Repository<DataDeletionRequest>,
    private readonly notifications: NotificationService,
    private readonly workspaceContext: WorkspaceContextService,
    private readonly audit: AuditService,
    private readonly sessions: AuthSessionService,
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

  /**
   * 解析"这个用户现在应该进入哪个工作区"（B0.4 / M8）。
   *
   * `users.workspace_id` 改为可为空之后，用户归属完全由 `workspace_members` 表达，登录不能直接读它。
   * 选择顺序：
   *   1) 首选工作区（登录时传用户的默认工作区；刷新时传令牌里的工作区）——只要仍是成员、且工作区可用就用它，
   *      这样"刷新令牌不会把用户从他正在用的工作区悄悄切走"；
   *   2) 最早加入的 active 工作区；
   *   3) 没有 active 的：返回"我是 owner 的已软删工作区"——否则删掉唯一工作区的人将永远无法登录去恢复；
   *   4) 都没有 → null（调用方给出明确提示，而不是签发一个没有工作区的令牌）。
   */
  async resolveLoginWorkspace(
    userId: string,
    preferredWorkspaceId?: string | null,
  ): Promise<{ workspace: Workspace; roleCodes: RoleCode[] } | null> {
    const memberships = await this.members.find({ where: { userId }, order: { createdAt: 'ASC' } });
    if (memberships.length === 0) return null;

    const workspaces = await this.workspaces.find({ where: { id: In(memberships.map((row) => row.workspaceId)) } });
    const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));

    const usable = (workspaceId: string, roleCodes: RoleCode[]): boolean => {
      const workspace = byId.get(workspaceId);
      if (!workspace) return false;
      if (workspace.status === 'active' || workspace.status === 'archived') return true;
      // 已软删：仅当调用者是 owner 时才允许进入（用于恢复），其余人视为不可用
      return workspace.status === 'soft_deleted' && roleCodes.includes('owner');
    };

    const preferred = preferredWorkspaceId
      ? memberships.find((row) => row.workspaceId === preferredWorkspaceId && usable(row.workspaceId, (row.roleCodes ?? []) as RoleCode[]))
      : undefined;
    const fallback = preferred ?? memberships.find((row) => usable(row.workspaceId, (row.roleCodes ?? []) as RoleCode[]));
    if (!fallback) return null;

    const workspace = byId.get(fallback.workspaceId);
    if (!workspace) return null;
    return { workspace, roleCodes: (fallback.roleCodes ?? []) as RoleCode[] };
  }

  /**
   * 生命周期接口的权限判定（B0.4）：按**目标工作区**查成员关系，而不是"当前令牌所在工作区"。
   *
   * 为什么必须这样：
   *   1) 否则 A 租户的 owner 可以删掉 B 租户的工作区（越权）；
   *   2) 否则用户把当前工作区软删之后，每个请求都 404，**永远无法恢复自己的工作区**。
   *
   * 约定：工作区不存在、或调用者不是其成员 → 404（不泄露"这个工作区存在"）；
   *       是成员但不是 owner → 403（权限不足，语义清晰）。
   */
  async requireWorkspaceRole(
    workspaceId: string,
    userId: string,
    allowed: RoleCode[] = ['owner'],
  ): Promise<{ workspace: Workspace; roleCodes: RoleCode[] }> {
    const workspace = await this.workspaces.findOne({ where: { id: workspaceId } });
    if (!workspace) throw new NotFoundException('工作区不存在');
    const member = await this.members.findOne({ where: { userId, workspaceId } });
    if (!member) throw new NotFoundException('工作区不存在');
    const roleCodes = (member.roleCodes ?? []) as RoleCode[];
    if (!roleCodes.some((role) => allowed.includes(role))) {
      throw new ForbiddenException('只有该工作区的所有者可以执行此操作');
    }
    return { workspace, roleCodes };
  }

  /** 归档：只读态，可随时取消归档。 */
  async archiveWorkspace(workspaceId: string, userId: string, actor: WorkspaceActor): Promise<WorkspaceStatusView> {
    const { workspace } = await this.requireWorkspaceRole(workspaceId, userId);
    if (workspace.status === 'archived') throw new ConflictException('该工作区已处于归档状态');
    if (workspace.status === 'soft_deleted') throw new ConflictException('该工作区已被删除，请先恢复再归档');

    await this.workspaces.update({ id: workspace.id }, { status: 'archived', archivedAt: new Date() });
    await this.sessions.invalidateWorkspace(workspace.id);
    await this.recordLifecycle('workspace.archive', workspace, actor, { previousStatus: workspace.status });
    this.logger.log(`工作区已归档：${workspace.name}`);
    return this.statusView(await this.workspaces.findOneOrFail({ where: { id: workspace.id } }));
  }

  /** 取消归档：回到可写状态。 */
  async unarchiveWorkspace(workspaceId: string, userId: string, actor: WorkspaceActor): Promise<WorkspaceStatusView> {
    const { workspace } = await this.requireWorkspaceRole(workspaceId, userId);
    if (workspace.status !== 'archived') throw new ConflictException('该工作区当前不是归档状态');

    await this.workspaces.update({ id: workspace.id }, { status: 'active', archivedAt: null });
    await this.sessions.invalidateWorkspace(workspace.id);
    await this.recordLifecycle('workspace.unarchive', workspace, actor, {});
    this.logger.log(`工作区已取消归档：${workspace.name}`);
    return this.statusView(await this.workspaces.findOneOrFail({ where: { id: workspace.id } }));
  }

  /**
   * 软删：进入保留期（默认 30 天，可配置），期间可恢复；到期后由定时任务永久清除。
   * 前置校验：无未完成发布任务、无进行中的导出。
   */
  async softDeleteWorkspace(
    workspaceId: string,
    userId: string,
    confirmName: string,
    actor: WorkspaceActor,
    reason?: string,
    confirmLastWorkspace = false,
  ): Promise<WorkspaceStatusView> {
    const { workspace } = await this.requireWorkspaceRole(workspaceId, userId);
    if (workspace.status === 'soft_deleted') throw new ConflictException('该工作区已被删除');
    if (confirmName.trim() !== workspace.name) {
      throw new BadRequestException('工作区名称不匹配：请输入完整名称以确认删除');
    }

    const activeTasks = await this.tasks.count({
      where: {
        workspaceId: workspace.id,
        status: In(['pending', 'scheduled', 'publishing'] as never[]),
      },
    });
    if (activeTasks > 0) {
      throw new ConflictException(`该工作区还有 ${activeTasks} 个未完成的发布任务，请先取消或等待完成`);
    }
    const runningExports = await this.exportJobs.count({
      where: { workspaceId: workspace.id, status: In(['queued', 'running'] as never[]) },
    });
    if (runningExports > 0) throw new ConflictException('该工作区有正在进行的导出任务，请等待其完成');

    /**
     * 最后一个工作区的**软保护**（B0.4 决策 2）：
     * 不做硬阻止（用户可能确实要关停），但必须让他在知情的前提下确认，并留下审计与通知。
     * 判断范围是"同一租户内其它仍处于 active/archived 的工作区"。
     */
    const remaining = await this.workspaces.count({
      where: { tenantId: workspace.tenantId, id: Not(workspace.id), status: In(['active', 'archived'] as never[]) },
    });
    const isLastWorkspace = remaining === 0;
    if (isLastWorkspace && !confirmLastWorkspace) {
      throw new BadRequestException(
        '这是你的最后一个工作区，删除后将无法登录平台。如确认，请在请求中带 confirmLastWorkspace: true',
      );
    }

    const retentionDays = runtime().workspace.softDeleteRetentionDays;
    const deletedAt = new Date();
    const purgeAfter = new Date(deletedAt.getTime() + retentionDays * 24 * 60 * 60 * 1000);
    await this.workspaces.update(
      { id: workspace.id },
      { status: 'soft_deleted', deletedAt, purgeAfter, archivedAt: null },
    );
    await this.sessions.invalidateWorkspace(workspace.id);
    await this.recordLifecycle('workspace.soft_delete', workspace, actor, {
      confirmName: confirmName.trim(),
      retentionDays,
      purgeAfter: purgeAfter.toISOString(),
      reason: reason ?? null,
      wasLast: isLastWorkspace,
    });
    if (isLastWorkspace) {
      // 单独的动作名，便于审计检索"谁关停了自己的最后一个工作区"
      await this.recordLifecycle('workspace.soft_delete.last_workspace', workspace, actor, {
        wasLast: true,
        purgeAfter: purgeAfter.toISOString(),
        retentionDays,
      });
      await this.notifications
        .notify({
          type: 'workspace.soft_delete.last_workspace',
          level: 'warning',
          title: '你已删除最后一个工作区',
          body:
            `工作区「${workspace.name}」已进入保留期，${retentionDays} 天内可恢复（到期时间 ${purgeAfter.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}）。` +
            `恢复方式：POST /api/workspaces/${workspace.id}/restore（或到「工作区」页面点恢复）。到期后将不可恢复。`,
          resourceType: 'workspace',
          resourceId: workspace.id,
          payload: { wasLast: true, purgeAfter: purgeAfter.toISOString(), restoreEndpoint: `/api/workspaces/${workspace.id}/restore` },
          // 平台可能已无法使用（没有其它工作区），尽量通过外部渠道也发一份
          external: true,
        })
        .catch((error: unknown) => {
          this.logger.warn(`最后一个工作区告警通知失败：${error instanceof Error ? error.message : String(error)}`);
        });
    }
    this.logger.warn(`工作区已软删（${retentionDays} 天内可恢复）：${workspace.name}${isLastWorkspace ? '｜注意：这是该租户最后一个工作区' : ''}`);
    return this.statusView(await this.workspaces.findOneOrFail({ where: { id: workspace.id } }));
  }

  /** 恢复：仅在保留期内可恢复；过期返回 410（明确告知不可恢复，而不是含糊的 400）。 */
  /**
   * B0.6：登记一条**合规删除请求**，并把它变成"30 天内必然完成清除"的承诺。
   *
   * 做法：① 建请求行（due_at = 现在 + 30 天）；② 走既有的软删（可恢复、有审计、有通知）；
   * ③ 把工作区的 `purge_after` **收紧**到 `min(现在 + 保留期, due_at)`——这样 04:00 的到期清除任务
   * 一定会在承诺期限内把它清掉；④ 写审计 `compliance.deletion_requested`。
   *
   * 清除本身仍是 B0.4 那条路（独立备份 + 单事务 + 账本 + 审计），本接口不新增不可逆动作。
   */
  async requestComplianceDeletion(
    workspaceId: string,
    userId: string,
    actor: WorkspaceActor,
    dto: { confirmName: string; reason?: string },
  ): Promise<{ request: DeletionRequestView; workspace: WorkspaceStatusView }> {
    const { workspace } = await this.requireWorkspaceRole(workspaceId, userId, ['owner']);
    if (dto.confirmName.trim() !== workspace.name) {
      throw new BadRequestException('工作区名称不匹配：请输入完整名称以确认删除');
    }

    const requestedAt = new Date();
    const dueAt = new Date(requestedAt.getTime() + WorkspaceService.COMPLIANCE_DELETION_DAYS * 24 * 60 * 60 * 1000);

    // 已有未完成的请求：不重复建，但同样保证期限承诺生效
    const existing = await this.deletionRequests.findOne({
      where: { tenantId: workspace.tenantId, workspaceId, status: 'pending' },
    });
    const request =
      existing ??
      (await this.deletionRequests.save(
        this.deletionRequests.create({
          tenantId: workspace.tenantId,
          workspaceId,
          requestedBy: actor.id ?? null,
          requestedByName: actor.name ?? null,
          reason: dto.reason?.trim() || null,
          status: 'pending',
          requestedAt,
          dueAt,
        }),
      ));

    // 软删（若已软删则跳过），随后收紧 purge_after
    let status: WorkspaceStatusView;
    if (workspace.status === 'soft_deleted') {
      status = this.statusView(workspace);
    } else {
      status = await this.softDeleteWorkspace(workspace.id, userId, dto.confirmName, actor, dto.reason);
    }

    const retentionDays = runtime().workspace.softDeleteRetentionDays;
    const capped = new Date(Math.min(Date.now() + retentionDays * 24 * 60 * 60 * 1000, request.dueAt.getTime()));
    await this.workspaces.update({ id: workspaceId }, { purgeAfter: capped });
    await this.sessions.invalidateWorkspace(workspaceId);

    await this.audit.record({
      action: 'compliance.deletion_requested',
      resourceType: 'workspace',
      resourceId: workspaceId,
      tenantId: workspace.tenantId,
      workspaceId,
      actorId: actor.id ?? null,
      actorName: actor.name ?? null,
      payload: {
        requestId: request.id,
        dueAt: request.dueAt.toISOString(),
        retentionDays,
        purgeAfter: capped.toISOString(),
        reason: request.reason,
        note: `${WorkspaceService.COMPLIANCE_DELETION_DAYS} 天内完成永久清除（走 purge：备份 + 审计 + 账本）`,
      },
    });

    this.logger.warn(
      `合规删除请求已登记：${workspace.name}｜承诺清除期限 ${request.dueAt.toISOString()}｜purge_after 收紧为 ${capped.toISOString()}`,
    );
    return { request: this.deletionRequestView(request), workspace: status };
  }

  /** 查询当前生效的合规删除请求（无则返回 null）。 */
  async deletionRequestStatus(workspaceId: string, userId: string): Promise<DeletionRequestView | null> {
    const { workspace } = await this.requireWorkspaceRole(workspaceId, userId);
    const request = await this.deletionRequests.findOne({
      where: { tenantId: workspace.tenantId, workspaceId, status: 'pending' },
    });
    return request ? this.deletionRequestView(request) : null;
  }

  /** 工作区被永久清除后调用：把请求标记为已完成并关联 purge 账本。 */
  async completeDeletionRequest(workspaceId: string, purgeBatchId: string): Promise<void> {
    const pending = await this.deletionRequests.find({ where: { workspaceId, status: 'pending' } });
    for (const request of pending) {
      await this.deletionRequests.update(
        { id: request.id },
        { status: 'completed', completedAt: new Date(), purgeBatchId },
      );
    }
  }

  /** 工作区被恢复时调用：合规请求随之作废（并留痕，避免"请求了却悄悄恢复"）。 */
  async cancelDeletionRequest(workspaceId: string, actor: WorkspaceActor): Promise<number> {
    const pending = await this.deletionRequests.find({ where: { workspaceId, status: 'pending' } });
    for (const request of pending) {
      await this.deletionRequests.update({ id: request.id }, { status: 'cancelled' });
    }
    if (pending.length > 0) {
      const workspace = await this.workspaces.findOne({ where: { id: workspaceId } });
      await this.audit.record({
        action: 'compliance.deletion_cancelled',
        resourceType: 'workspace',
        resourceId: workspaceId,
        tenantId: workspace?.tenantId ?? '',
        workspaceId,
        actorId: actor.id ?? null,
        actorName: actor.name ?? null,
        payload: { count: pending.length },
      });
    }
    return pending.length;
  }

  private deletionRequestView(request: DataDeletionRequest): DeletionRequestView {
    const daysUntilDue = Math.ceil((request.dueAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
    return {
      id: request.id,
      status: request.status,
      requestedAt: request.requestedAt.toISOString(),
      dueAt: request.dueAt.toISOString(),
      daysUntilDue,
      completedAt: request.completedAt?.toISOString() ?? null,
      purgeBatchId: request.purgeBatchId,
      reason: request.reason,
    };
  }

  async restoreWorkspace(workspaceId: string, userId: string, actor: WorkspaceActor): Promise<WorkspaceStatusView> {
    const { workspace } = await this.requireWorkspaceRole(workspaceId, userId);
    if (workspace.status !== 'soft_deleted') throw new ConflictException('该工作区当前不需要恢复');

    const deadline = workspace.purgeAfter ?? workspace.deletedAt;
    if (deadline && Date.now() > deadline.getTime()) {
      throw new GoneException('该工作区已超过保留期，数据不可恢复');
    }

    await this.workspaces.update({ id: workspace.id }, { status: 'active', deletedAt: null, purgeAfter: null });
    await this.sessions.invalidateWorkspace(workspace.id);
    await this.recordLifecycle('workspace.restore', workspace, actor, { deletedAt: workspace.deletedAt?.toISOString() ?? null });
    // 若此前登记过合规删除请求，恢复即视为撤回请求（并留痕）
    await this.cancelDeletionRequest(workspaceId, actor);
    this.logger.log(`工作区已恢复：${workspace.name}`);
    return this.statusView(await this.workspaces.findOneOrFail({ where: { id: workspace.id } }));
  }

  /** 只读状态视图（前端据此显示倒计时与可执行操作）。 */
  async workspaceStatus(workspaceId: string, userId: string): Promise<WorkspaceStatusView> {
    await this.requireWorkspaceRole(workspaceId, userId, ['owner', 'admin', 'editor', 'reviewer', 'viewer']);
    const workspace = await this.workspaces.findOneOrFail({ where: { id: workspaceId } });
    return this.statusView(workspace);
  }

  private statusView(workspace: Workspace): WorkspaceStatusView {
    const daysUntilPurge =
      workspace.status === 'soft_deleted' && workspace.purgeAfter
        ? Math.max(0, Math.ceil((workspace.purgeAfter.getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
        : null;
    return {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      status: workspace.status,
      archivedAt: workspace.archivedAt?.toISOString() ?? null,
      deletedAt: workspace.deletedAt?.toISOString() ?? null,
      purgeAfter: workspace.purgeAfter?.toISOString() ?? null,
      daysUntilPurge,
    };
  }

  private async recordLifecycle(
    action: string,
    workspace: Workspace,
    actor: WorkspaceActor,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.audit
      .record({
        action,
        resourceType: 'workspace',
        resourceId: workspace.id,
        tenantId: workspace.tenantId,
        workspaceId: workspace.id,
        actorId: actor.id ?? null,
        actorName: actor.name ?? null,
        payload: { workspaceName: workspace.name, ...payload },
      })
      .catch((error: unknown) => {
        this.logger.warn(`工作区生命周期审计写入失败（${action}）：${error instanceof Error ? error.message : String(error)}`);
      });
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
    /**
     * 用户被软删除后成员关系行会残留，TypeORM 查不到该用户，列表里就出现"（已删除用户）"幽灵成员。
     * 这里只返回仍然存在的用户；删除用户时会一并清掉成员关系（见 UserService.remove）。
     */
    return rows
      .filter((row) => users.has(row.userId))
      .map((row) => {
        const user = users.get(row.userId)!;
        return {
          userId: row.userId,
          displayName: user.displayName,
          email: user.email,
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
    // 成员角色变更立即生效（否则旧令牌按旧角色放行）
    await this.sessions.invalidate(input.userId);
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
    // 移出成员后，其未过期令牌必须立即失去该工作区的访问权
    await this.sessions.invalidate(userId);
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
