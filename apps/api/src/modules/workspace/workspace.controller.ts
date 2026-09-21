import { WorkspaceLifecycle } from '../auth/workspace-lifecycle.decorator';
import { Public } from '../auth/public.decorator';
import { DeleteWorkspaceDto } from './dto/workspace-lifecycle.dto';
import { RequestWorkspaceExportDto } from './dto/workspace-export.dto';
import { Body, Controller, Delete, Get, HttpCode, Ip, Headers, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { createReadStream } from 'node:fs';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { Capability } from '../auth/capabilities';
import { AuthUser } from '../auth/auth.types';
import { toActor } from '../auth/actor.util';
import { CurrentUser } from '../auth/current-user.decorator';
import { ROLE_CODES } from './entities/role.entity';
import { WorkspaceMemberView, WorkspaceService, WorkspaceStatusView, WorkspaceSummary } from './workspace.service';
import { ExportJobView, WorkspaceExportService } from './workspace-export.service';
import { PurgeResult, WorkspacePurgeService } from './workspace-purge.service';
import { PurgeWorkspaceDto } from './dto/workspace-purge.dto';

class CreateWorkspaceDto {
  @IsString()
  @Length(1, 100)
  name!: string;

  @IsOptional()
  @IsString()
  @Length(1, 50)
  slug?: string;
}

class UpsertMemberDto {
  @IsUUID('4')
  userId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @IsIn(ROLE_CODES, { each: true })
  roleCodes!: string[];
}

/**
 * 工作区与成员管理：
 * - GET /workspaces：我能切换的工作区（侧边栏切换器用）
 * - POST /workspaces：新建工作区（创建者成为所有者）
 * - 成员增删改需要 workspace.manage 能力点（默认 owner/admin）
 */
@Controller('workspaces')
export class WorkspaceController {
  constructor(
    private readonly workspacesService: WorkspaceService,
    private readonly exportService: WorkspaceExportService,
    private readonly purgeService: WorkspacePurgeService,
  ) {}

  /**
   * 我能切换的工作区列表。
   *
   * 为什么必须豁免状态闸门：用户删掉"当前工作区"之后，令牌仍指向那个已软删的工作区，
   * 若这里也按状态返回 404，界面上连"我参与的其他工作区"都读不到，用户就再也切不走了
   * ——只剩"恢复"这一条路（非 owner 成员甚至没有这条路）。只返回调用者自己是成员的工作区，不泄露任何信息。
   */
  @WorkspaceLifecycle()
  @Get()
  mine(@CurrentUser() user?: AuthUser): Promise<WorkspaceSummary[]> {
    return this.workspacesService.listMine(user?.id ?? '');
  }

  @Capability('workspace.manage')
  @Post()
  create(@Body() dto: CreateWorkspaceDto, @CurrentUser() user?: AuthUser): Promise<WorkspaceSummary> {
    return this.workspacesService.create(dto, toActor(user));
  }


  /**
   * 工作区生命周期（B0.4）。这些接口一律标注 @WorkspaceLifecycle()：
   * 目标工作区可能正处于归档/软删态，若被状态闸门拦下，用户将永远无法恢复自己的工作区。
   * 权限在服务层按**目标工作区**判定（requireWorkspaceRole）。
   */
  @Capability('workspace.archive')
  @WorkspaceLifecycle()
  @HttpCode(200)
  @Post(':id/archive')
  archive(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user?: AuthUser): Promise<WorkspaceStatusView> {
    return this.workspacesService.archiveWorkspace(id, user?.id ?? '', toActor(user));
  }

  @Capability('workspace.archive')
  @WorkspaceLifecycle()
  @HttpCode(200)
  @Post(':id/unarchive')
  unarchive(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user?: AuthUser): Promise<WorkspaceStatusView> {
    return this.workspacesService.unarchiveWorkspace(id, user?.id ?? '', toActor(user));
  }

  @Capability('workspace.delete')
  @WorkspaceLifecycle()
  @Delete(':id')
  softDelete(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeleteWorkspaceDto,
    @CurrentUser() user?: AuthUser,
  ): Promise<WorkspaceStatusView> {
    return this.workspacesService.softDeleteWorkspace(
      id,
      user?.id ?? '',
      dto.confirmName,
      toActor(user),
      dto.reason,
      dto.confirmLastWorkspace ?? false,
    );
  }

  @Capability('workspace.restore')
  @WorkspaceLifecycle()
  @HttpCode(200)
  @Post(':id/restore')
  restore(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user?: AuthUser): Promise<WorkspaceStatusView> {
    return this.workspacesService.restoreWorkspace(id, user?.id ?? '', toActor(user));
  }

  // ---------- 永久清除（B0.4 第 4 步，不可逆） ----------

  /** 清除前的预估影响面（逐表行数 + 文件数），确认框里可展示。 */
  // ---------- 合规删除请求（B0.6：收到请求后 30 天内完成清除） ----------

  /**
   * 登记合规删除请求：建台账（due_at = 现在 + 30 天）→ 软删 → 把 purge_after 收紧到不晚于 due_at。
   * 实际清除仍走 purge（备份 + 审计 + 账本），本接口只是"承诺 + 留痕"。
   */
  @Capability('workspace.delete')
  @WorkspaceLifecycle()
  @HttpCode(200)
  @Post(':id/deletion-request')
  requestDeletion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeleteWorkspaceDto,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.workspacesService.requestComplianceDeletion(id, user?.id ?? '', toActor(user), {
      confirmName: dto.confirmName,
      reason: dto.reason,
    });
  }

  /** 查询当前生效的合规删除请求（无则返回 null）。 */
  @Capability('workspace.manage')
  @WorkspaceLifecycle()
  @Get(':id/deletion-request')
  deletionRequest(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user?: AuthUser) {
    return this.workspacesService.deletionRequestStatus(id, user?.id ?? '');
  }

  @Capability('workspace.purge')
  @WorkspaceLifecycle()
  @Get(':id/purge-preview')
  purgePreview(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: AuthUser,
  ): Promise<{ rows: Record<string, number>; files: number }> {
    return this.purgeService.preview(id, user?.id ?? '');
  }

  /**
   * 永久清除工作区数据（不可逆）：要求已软删且保留期已过、名称 + 固定串二次确认、无进行中的导出；
   * 执行前先做独立备份，**备份失败即中止且不删除任何数据**；审计与成本账本永久保留。
   */
  @Capability('workspace.purge')
  @WorkspaceLifecycle()
  @HttpCode(200)
  @Delete(':id/data')
  purge(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PurgeWorkspaceDto,
    @CurrentUser() user?: AuthUser,
  ): Promise<PurgeResult> {
    return this.purgeService.purgeWorkspace(id, user?.id ?? '', dto, toActor(user));
  }

  @Capability('workspace.manage')
  @WorkspaceLifecycle()
  @Get(':id/status')
  status(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user?: AuthUser): Promise<WorkspaceStatusView> {
    return this.workspacesService.workspaceStatus(id, user?.id ?? '');
  }


  // ---------- 租户数据导出（B0.4 第 3 步） ----------

  /** 申请导出：立即返回 jobId，后台流式生成 ZIP（同一工作区同时只允许 1 个任务）。 */
  @Capability('workspace.export')
  @WorkspaceLifecycle()
  @Post(':id/export')
  requestExport(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RequestWorkspaceExportDto,
    @CurrentUser() user?: AuthUser,
  ): Promise<ExportJobView> {
    return this.exportService.requestExport(id, user?.id ?? '', toActor(user), dto);
  }

  /** 查询导出进度与结果。 */
  @Capability('workspace.export')
  @WorkspaceLifecycle()
  @Get(':id/export/:jobId')
  exportJob(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @CurrentUser() user?: AuthUser,
  ): Promise<ExportJobView> {
    return this.exportService.getJob(id, jobId, user?.id ?? '');
  }

  /** 申请一次性下载链接（15 分钟有效，用过即失效）。 */
  @Capability('workspace.export')
  @WorkspaceLifecycle()
  @HttpCode(200)
  @Post(':id/export/:jobId/link')
  exportLink(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @CurrentUser() user?: AuthUser,
  ): Promise<{ url: string; expiresAt: string }> {
    return this.exportService.createDownloadLink(id, jobId, user?.id ?? '');
  }

  /**
   * 凭令牌下载产物。令牌本身即鉴权（HMAC + 15 分钟 + 一次性），因此是公开路由：
   * 这样即使工作区已被软删/清除，产物仍能在有效期内被取走。
   */
  @Public()
  @Get(':id/export/:jobId/download')
  async exportDownload(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Query('token') token: string,
    @Res() response: Response,
    @Ip() ip?: string,
    @Headers('user-agent') userAgent?: string,
  ): Promise<void> {
    const file = await this.exportService.resolveDownload(id, jobId, token ?? '', { ip: ip ?? null, userAgent: userAgent ?? null });
    response.setHeader('Content-Type', 'application/zip');
    response.setHeader('Content-Length', String(file.sizeBytes));
    response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
    createReadStream(file.path).pipe(response);
  }

  @Capability('workspace.manage')
  @Get(':id/members')
  members(@Param('id', ParseUUIDPipe) id: string): Promise<WorkspaceMemberView[]> {
    return this.workspacesService.members_(id);
  }

  @Capability('workspace.manage')
  @Put(':id/members')
  upsertMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpsertMemberDto,
    @CurrentUser() user?: AuthUser,
  ): Promise<WorkspaceMemberView> {
    return this.workspacesService.upsertMember(id, { userId: dto.userId, roleCodes: dto.roleCodes as never }, toActor(user));
  }

  @Capability('workspace.manage')
  @Delete(':id/members/:userId')
  removeMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser() user?: AuthUser,
  ): Promise<{ userId: string }> {
    return this.workspacesService.removeMember(id, userId, toActor(user));
  }
}
