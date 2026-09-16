import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, FindOptionsWhere, Repository } from 'typeorm';
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
  resourceType?: string;
  resourceId?: string;
  action?: string;
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

    const where: FindOptionsWhere<AuditLog> = {};
    if (query.resourceType) where.resourceType = query.resourceType;
    if (query.resourceId) where.resourceId = query.resourceId;
    if (query.action) where.action = query.action;
    if (query.from && query.to) where.createdAt = Between(query.from, query.to);

    const [items, total] = await this.repository.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { items, total, page, pageSize };
  }
}
