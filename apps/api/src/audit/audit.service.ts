import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLog } from '../modules/audit/entities/audit-log.entity';

export interface AuditInput {
  action: string;
  resourceType: string;
  resourceId?: string | null;
  tenantId: string;
  workspaceId: string;
  actorId?: string | null;
  actorName?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  payload?: Record<string, unknown>;
}

export interface AuditQuery {
  /** 必填：审计日志必须按工作区隔离，避免跨租户可读 */
  workspaceId: string;
  resourceType?: string;
  resourceId?: string;
  /** 精确匹配动作；也可用 actionPrefix 例如 "knowledge." 查一类 */
  action?: string;
  actionPrefix?: string;
  actorKeyword?: string;
  keyword?: string;
  from?: Date;
  to?: Date;
  page?: number;
  pageSize?: number;
}

export interface AuditPage {
  items: AuditLog[];
  total: number;
  page: number;
  pageSize: number;
}

/** Auditing must never break the business flow, so failures are logged and swallowed. */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@InjectRepository(AuditLog) private readonly repository: Repository<AuditLog>) {}

  async record(input: AuditInput): Promise<void> {
    try {
      const entry = this.repository.create({
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        actorId: input.actorId ?? null,
        actorName: input.actorName ?? null,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        payload: input.payload ?? {},
      });
      await this.repository.save(entry);
    } catch (error) {
      this.logger.warn(`写入审计日志失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async list(query: AuditQuery): Promise<AuditPage> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const pageSize = query.pageSize && query.pageSize > 0 ? Math.min(query.pageSize, 100) : 20;

    const builder = this.repository
      .createQueryBuilder('audit')
      .where('audit.workspaceId = :workspaceId', { workspaceId: query.workspaceId });

    if (query.resourceType) builder.andWhere('audit.resourceType = :resourceType', { resourceType: query.resourceType });
    if (query.resourceId) builder.andWhere('audit.resourceId = :resourceId', { resourceId: query.resourceId });
    if (query.action) builder.andWhere('audit.action = :action', { action: query.action });
    if (query.actionPrefix) builder.andWhere('audit.action ILIKE :actionPrefix', { actionPrefix: `${query.actionPrefix}%` });
    if (query.actorKeyword) builder.andWhere('audit.actorName ILIKE :actorKeyword', { actorKeyword: `%${query.actorKeyword}%` });
    if (query.keyword) {
      builder.andWhere('(audit.action ILIKE :kw OR audit.actorName ILIKE :kw OR audit.resourceType ILIKE :kw OR audit.payload::text ILIKE :kw)', {
        kw: `%${query.keyword}%`,
      });
    }
    // 只给一端也支持：从某天起 / 到某天止
    if (query.from && query.to) builder.andWhere('audit.createdAt BETWEEN :from AND :to', { from: query.from, to: query.to });
    else if (query.from) builder.andWhere('audit.createdAt >= :from', { from: query.from });
    else if (query.to) builder.andWhere('audit.createdAt <= :to', { to: query.to });

    const [items, total] = await builder
      .orderBy('audit.createdAt', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();
    return { items, total, page, pageSize };
  }

  /** 动作清单与出现次数：给审计页的筛选下拉用。 */
  async actionStats(workspaceId: string, days = 90): Promise<Array<{ action: string; count: number }>> {
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await this.repository
      .createQueryBuilder('audit')
      .select('audit.action', 'action')
      .addSelect('COUNT(*)', 'count')
      .where('audit.workspaceId = :workspaceId AND audit.createdAt >= :since', { workspaceId, since })
      .groupBy('audit.action')
      .orderBy('count', 'DESC')
      .limit(100)
      .getRawMany<{ action: string; count: string }>();
    return rows.map((row) => ({ action: row.action, count: Number(row.count) }));
  }
}
