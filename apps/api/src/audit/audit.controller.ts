import { Controller, Get, Query } from '@nestjs/common';
import { Capability } from '../modules/auth/capabilities';
import { WorkspaceContextService } from '../common/workspace-context.service';
import { AuditService } from './audit.service';
import { AuditLog } from '../modules/audit/entities/audit-log.entity';

interface AuditQueryDto {
  action?: string;
  actionPrefix?: string;
  actor?: string;
  keyword?: string;
  resourceType?: string;
  from?: string;
  to?: string;
  page?: string;
  pageSize?: string;
}

/**
 * 审计日志查询。写操作（谁改了什么）此前只能查数据库，出事时无法自助追溯。
 * 权限走可配置的 audit.read 能力点（默认 owner/admin）。
 */
@Capability('audit.read')
@Controller('audit-logs')
export class AuditController {
  constructor(
    private readonly audit: AuditService,
    private readonly workspaceContext: WorkspaceContextService,
  ) {}

  @Get()
  async list(@Query() query: AuditQueryDto): Promise<{
    items: AuditLog[];
    meta: { page: number; pageSize: number; total: number; totalPages: number };
  }> {
    const scope = await this.workspaceContext.current();
    const result = await this.audit.list({
      workspaceId: scope.workspaceId,
      action: query.action || undefined,
      actionPrefix: query.actionPrefix || undefined,
      actorKeyword: query.actor || undefined,
      keyword: query.keyword || undefined,
      resourceType: query.resourceType || undefined,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      page: query.page ? Number(query.page) : 1,
      pageSize: query.pageSize ? Number(query.pageSize) : 20,
    });
    return {
      items: result.items,
      meta: {
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
        totalPages: Math.ceil(result.total / result.pageSize) || 1,
      },
    };
  }

  @Get('actions')
  async actions(@Query('days') days?: string): Promise<Array<{ action: string; count: number }>> {
    const scope = await this.workspaceContext.current();
    return this.audit.actionStats(scope.workspaceId, days ? Number(days) : 90);
  }
}
