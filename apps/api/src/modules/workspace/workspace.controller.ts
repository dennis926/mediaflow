import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { Capability } from '../auth/capabilities';
import { AuthUser } from '../auth/auth.types';
import { toActor } from '../auth/actor.util';
import { CurrentUser } from '../auth/current-user.decorator';
import { ROLE_CODES } from './entities/role.entity';
import { WorkspaceMemberView, WorkspaceService, WorkspaceSummary } from './workspace.service';

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
  constructor(private readonly workspacesService: WorkspaceService) {}

  @Get()
  mine(@CurrentUser() user?: AuthUser): Promise<WorkspaceSummary[]> {
    return this.workspacesService.listMine(user?.id ?? '');
  }

  @Capability('workspace.manage')
  @Post()
  create(@Body() dto: CreateWorkspaceDto, @CurrentUser() user?: AuthUser): Promise<WorkspaceSummary> {
    return this.workspacesService.create(dto, toActor(user));
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
