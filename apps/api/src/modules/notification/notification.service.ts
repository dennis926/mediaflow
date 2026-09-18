import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WorkspaceContextService } from '../../common/workspace-context.service';
import { runtime } from '../settings/runtime-config';
import { NotificationChannelService } from './notification-channel.service';
import { Notification, NotificationLevel } from './entities/notification.entity';

export interface NotifyInput {
  type: string;
  title: string;
  body: string;
  level?: NotificationLevel;
  resourceType?: string | null;
  resourceId?: string | null;
  payload?: Record<string, unknown>;
  /** 除了站内通知，是否也推到已配置的群机器人/邮件 */
  external?: boolean;
}

export interface NotificationPage {
  items: Notification[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
  unread: number;
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @InjectRepository(Notification) private readonly repository: Repository<Notification>,
    private readonly workspaceContext: WorkspaceContextService,
    private readonly channels: NotificationChannelService,
  ) {}

  async notify(input: NotifyInput): Promise<Notification> {
    const scope = await this.workspaceContext.current();
    const saved = await this.repository.save(
      this.repository.create({
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        type: input.type,
        level: input.level ?? 'info',
        title: input.title,
        body: input.body,
        channel: 'inbox',
        status: 'unread',
        resourceType: input.resourceType ?? null,
        resourceId: input.resourceId ?? null,
        readAt: null,
        payload: input.payload ?? {},
      }),
    );

    this.logger.log(`通知已写入：[${saved.level}] ${saved.title}`);

    // 已配置群机器人/邮件时同步推出去；级别过滤避免普通提示刷群，失败不影响业务（只记日志）
    const minLevel = runtime().notify.minLevel;
    const levelRank: Record<string, number> = { info: 0, warning: 1, error: 2 };
    const levelAllowed = (levelRank[saved.level] ?? 0) >= (levelRank[minLevel] ?? 1);

    if (input.external !== false && levelAllowed && this.channels.available().length > 0) {
      const results = await this.channels.dispatch({ title: saved.title, text: saved.body, context: saved.payload });
      for (const result of results) {
        if (!result.ok) this.logger.warn(`外部通知发送失败(${result.channel})：${result.error}`);
      }
    }
    return saved;
  }

  async list(query: { page?: number; pageSize?: number; status?: 'unread' | 'read' }): Promise<NotificationPage> {
    const scope = await this.workspaceContext.current();
    const page = query.page && query.page > 0 ? query.page : 1;
    const pageSize = query.pageSize && query.pageSize > 0 ? Math.min(query.pageSize, 50) : 10;

    const where: Record<string, unknown> = { workspaceId: scope.workspaceId };
    if (query.status) where.status = query.status;

    const [items, total] = await this.repository.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    const unread = await this.repository.count({ where: { workspaceId: scope.workspaceId, status: 'unread' } });
    return { items, meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) || 1 }, unread };
  }

  async markRead(id: string): Promise<Notification | null> {
    const scope = await this.workspaceContext.current();
    const notification = await this.repository.findOne({ where: { id, workspaceId: scope.workspaceId } });
    if (!notification) return null;
    if (notification.status === 'unread') {
      notification.status = 'read';
      notification.readAt = new Date();
      await this.repository.save(notification);
    }
    return notification;
  }

  async markAllRead(): Promise<{ updated: number }> {
    const scope = await this.workspaceContext.current();
    const result = await this.repository.update(
      { workspaceId: scope.workspaceId, status: 'unread' },
      { status: 'read', readAt: new Date() },
    );
    return { updated: result.affected ?? 0 };
  }
}
