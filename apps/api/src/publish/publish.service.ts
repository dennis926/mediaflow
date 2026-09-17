import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  AdapterCapabilities,
  AdapterCredentials,
  ChannelAdapter,
  ChannelAdapterRegistry,
  PublishPayload,
  PublishResult,
} from '@mediaflow/channel-adapters';
import {
  AiFlagType,
  PlatformCode,
  PLATFORM_LABELS,
  PUBLISH_RETRY,
  PublishMode,
  PublishTaskStatus,
  appendAiDisclosure,
} from '@mediaflow/shared';
import { IsNull, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { WorkspaceContextService } from '../common/workspace-context.service';
import { SettingsService } from '../modules/settings/settings.service';
import { ContentVariant } from '../modules/content/entities/content-variant.entity';
import { Content } from '../modules/content/entities/content.entity';
import { SocialAccount } from '../modules/platform/entities/social-account.entity';
import { SocialAccountService } from '../modules/platform/social-account.service';
import { PublishTask } from '../modules/publish/entities/publish-task.entity';
import { CHANNEL_REGISTRY } from './channel-registry.provider';
import { CreatePublishTaskDto } from './dto/create-publish-task.dto';
import { QueryPublishTaskDto } from './dto/query-publish-task.dto';
import { PublishQueueService } from './publish.queue';

export interface PublishActor {
  id?: string | null;
  name?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AdapterDescriptor {
  platform: PlatformCode;
  label: string;
  mode: PublishMode;
  capabilities: AdapterCapabilities;
}

export interface PublishTaskPage {
  items: PublishTask[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

@Injectable()
export class PublishService {
  private readonly logger = new Logger(PublishService.name);

  constructor(
    @InjectRepository(PublishTask) private readonly tasks: Repository<PublishTask>,
    @InjectRepository(Content) private readonly contents: Repository<Content>,
    @InjectRepository(ContentVariant) private readonly variants: Repository<ContentVariant>,
    @InjectRepository(SocialAccount) private readonly accounts: Repository<SocialAccount>,
    private readonly socialAccounts: SocialAccountService,
    @Inject(CHANNEL_REGISTRY) private readonly registry: ChannelAdapterRegistry,
    private readonly queue: PublishQueueService,
    private readonly audit: AuditService,
    private readonly workspaceContext: WorkspaceContextService,
    private readonly settings: SettingsService,
  ) {}

  /** Retry spacing is configurable at runtime so local verification does not wait five minutes. */
  async retryIntervalMs(): Promise<number> {
    return this.settings.getNumber('PUBLISH_RETRY_INTERVAL_MS', PUBLISH_RETRY.intervalMs);
  }

  listAdapters(): AdapterDescriptor[] {
    return this.registry.list().map((adapter) => ({
      platform: adapter.platform,
      label: PLATFORM_LABELS[adapter.platform],
      mode: adapter.capabilities.mode,
      capabilities: adapter.capabilities,
    }));
  }

  adapterFor(platform: PlatformCode): ChannelAdapter {
    if (!this.registry.has(platform)) {
      throw new BadRequestException(`平台 ${PLATFORM_LABELS[platform] ?? platform} 的适配器尚未实现`);
    }
    return this.registry.get(platform);
  }

  async createTasks(dto: CreatePublishTaskDto, actor: PublishActor): Promise<PublishTask[]> {
    const scope = await this.workspaceContext.current();
    const content = await this.contents.findOne({ where: { id: dto.contentId, workspaceId: scope.workspaceId } });
    if (!content) throw new NotFoundException('内容不存在或无权访问');

    if (content.aiGenerated && !content.aiFlagChecked) {
      throw new BadRequestException('AI 生成内容发布前必须通过 AI 标识校验（ai_flag_checked）');
    }

    const platforms = [...new Set(dto.platforms)];
    const scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : null;
    if (scheduledAt && Number.isNaN(scheduledAt.getTime())) throw new BadRequestException('scheduledAt 不是合法时间');

    const created: PublishTask[] = [];
    for (const platform of platforms) {
      const adapter = this.adapterFor(platform);
      if (dto.socialAccountId) await this.requireAccount(dto.socialAccountId, platform, scope.workspaceId);

      const isFuture = Boolean(scheduledAt && scheduledAt.getTime() > Date.now());
      const task = this.tasks.create({
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        contentId: content.id,
        platform,
        publishMode: adapter.capabilities.mode,
        socialAccountId: dto.socialAccountId ?? null,
        status: isFuture ? PublishTaskStatus.Scheduled : PublishTaskStatus.Pending,
        scheduledAt,
        maxAttempts: dto.maxAttempts ?? PUBLISH_RETRY.maxAttempts,
        attempts: 0,
        createdBy: actor.id ?? null,
        extra: {},
      });
      const saved = await this.tasks.save(task);

      if (!isFuture) await this.queue.enqueue(saved.id);
      await this.audit.record({
        action: 'publish_task.create',
        resourceType: 'publish_task',
        resourceId: saved.id,
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        actorId: actor.id ?? null,
        actorName: actor.name ?? null,
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
        payload: { platform, contentId: content.id, scheduledAt: saved.scheduledAt?.toISOString() ?? null },
      });
      created.push(saved);
    }

    this.logger.log(`已创建 ${created.length} 个发布任务（内容：${content.title}）`);
    return created;
  }

  async list(query: QueryPublishTaskDto, scopeWorkspaceId?: string): Promise<PublishTaskPage> {
    const scope = await this.workspaceContext.current();
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const builder = this.tasks
      .createQueryBuilder('task')
      .leftJoin('task.content', 'content')
      .addSelect(['content.id', 'content.title'])
      .where('task.workspaceId = :workspaceId', { workspaceId: scopeWorkspaceId ?? scope.workspaceId });

    if (query.status) builder.andWhere('task.status = :status', { status: query.status });
    if (query.platform) builder.andWhere('task.platform = :platform', { platform: query.platform });

    builder.orderBy('task.createdAt', 'DESC').skip((page - 1) * pageSize).take(pageSize);
    const [items, total] = await builder.getManyAndCount();

    return { items, meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) || 1 } };
  }

  async get(id: string): Promise<PublishTask> {
    const task = await this.tasks.findOne({ where: { id }, relations: { content: true, contentVariant: true } });
    if (!task) throw new NotFoundException('发布任务不存在');
    return task;
  }

  /**
   * Week view for the calendar page: tasks bucketed per day (by scheduled_at when set,
   * otherwise by creation time), padded so the UI always receives seven days.
   */
  async calendar(weekStartIso?: string): Promise<Array<{ date: string; tasks: PublishTask[] }>> {
    const scope = await this.workspaceContext.current();
    const base = weekStartIso ? new Date(`${weekStartIso}T00:00:00`) : this.startOfWeek(new Date());
    if (Number.isNaN(base.getTime())) throw new BadRequestException('weekStart 不是合法日期');

    const start = this.startOfWeek(base);
    const end = new Date(start.getTime() + 7 * 24 * 3600 * 1000);

    const tasks = await this.tasks
      .createQueryBuilder('task')
      .leftJoin('task.content', 'content')
      .addSelect(['content.id', 'content.title'])
      .where('task.workspaceId = :workspaceId', { workspaceId: scope.workspaceId })
      .andWhere(
        'COALESCE(task.scheduledAt, task.createdAt) >= :start AND COALESCE(task.scheduledAt, task.createdAt) < :end',
        { start, end },
      )
      .orderBy('task.createdAt', 'ASC')
      .getMany();

    const days: Array<{ date: string; tasks: PublishTask[] }> = [];
    for (let index = 0; index < 7; index += 1) {
      const day = new Date(start.getTime() + index * 24 * 3600 * 1000);
      const key = day.toISOString().slice(0, 10);
      days.push({
        date: key,
        tasks: tasks.filter((task) => (task.scheduledAt ?? task.createdAt).toISOString().slice(0, 10) === key),
      });
    }
    return days;
  }

  private startOfWeek(day: Date): Date {
    const local = new Date(day.getFullYear(), day.getMonth(), day.getDate());
    // Week starts on Monday.
    const weekday = (local.getDay() + 6) % 7;
    local.setDate(local.getDate() - weekday);
    return local;
  }

  async queueStats(): Promise<{ length: number; pending: number; consumers: number }> {
    return this.queue.stats();
  }

  /** Builds the platform payload, including the mandatory AI disclosure suffix. */
  async buildPayload(task: PublishTask): Promise<PublishPayload> {
    const content = await this.contents.findOne({ where: { id: task.contentId } });
    if (!content) throw new Error('内容不存在或已被删除');

    const variant = task.contentVariantId
      ? await this.variants.findOne({ where: { id: task.contentVariantId } })
      : null;

    const aiFlagType = variant?.aiFlagType ?? content.aiFlagType;
    return {
      taskId: task.id,
      title: variant?.title ?? content.title,
      body: appendAiDisclosure(variant?.body ?? content.body, aiFlagType),
      tags: variant?.tags ?? content.tags,
      mediaUrls: variant?.mediaUrls ?? content.mediaUrls,
      coverUrl: content.coverUrl ?? undefined,
      scheduledAt: task.scheduledAt?.toISOString(),
      aiGenerated: aiFlagType !== AiFlagType.None,
    };
  }

  async resolveCredentials(platform: PlatformCode, socialAccountId: string | null): Promise<AdapterCredentials> {
    const appId = await this.credential(platform, 'appId');
    const appSecret = await this.credential(platform, 'appSecret');
    if (!socialAccountId) return { appId, appSecret };

    // Tokens are stored encrypted, so decrypt before handing them to the adapter.
    const stored = await this.socialAccounts.credentialsOf(socialAccountId);
    const openId = typeof stored.extra?.openId === 'string' ? stored.extra.openId : undefined;
    return {
      appId,
      appSecret,
      accessToken: stored.accessToken ?? undefined,
      refreshToken: stored.refreshToken ?? undefined,
      expiresAt: stored.expiresAt?.toISOString(),
      openId,
    };
  }

  /** Conditional update that makes concurrent workers idempotent. */
  async claim(taskId: string, workerName: string): Promise<boolean> {
    const result = await this.tasks
      .createQueryBuilder()
      .update(PublishTask)
      .set({
        status: PublishTaskStatus.Publishing,
        startedAt: () => 'now()',
        lockedBy: workerName,
        lockedAt: () => 'now()',
        attempts: () => 'attempts + 1',
      })
      .where('id = :id AND status IN (:...statuses)', {
        id: taskId,
        statuses: [PublishTaskStatus.Pending, PublishTaskStatus.Scheduled],
      })
      .execute();
    return (result.affected ?? 0) > 0;
  }

  async markScheduled(task: PublishTask): Promise<void> {
    await this.tasks.update({ id: task.id, status: task.status }, { status: PublishTaskStatus.Scheduled });
  }

  async completePublished(task: PublishTask, result: PublishResult): Promise<void> {
    await this.tasks.update(
      { id: task.id },
      {
        status: PublishTaskStatus.Published,
        platformPostId: result.platformPostId ?? null,
        platformUrl: result.platformUrl ?? null,
        finishedAt: new Date(),
        errorMessage: null,
        lockedBy: null,
        lockedAt: null,
      },
    );
    await this.contents.update({ id: task.contentId, publishedAt: IsNull() }, { publishedAt: new Date() });
  }

  async markManualRequired(task: PublishTask, result: PublishResult): Promise<void> {
    await this.tasks.update(
      { id: task.id },
      {
        status: PublishTaskStatus.ManualRequired,
        finishedAt: new Date(),
        errorMessage: null,
        lockedBy: null,
        lockedAt: null,
        extra: { ...task.extra, manualMessage: result.message },
      },
    );
  }

  async markAwaitingHuman(task: PublishTask, result: PublishResult): Promise<void> {
    await this.tasks.update(
      { id: task.id },
      {
        status: PublishTaskStatus.Pending,
        scheduledAt: null,
        lockedBy: null,
        lockedAt: null,
        errorMessage: null,
        extra: { ...task.extra, awaitingConfirmation: true, pluginMessage: result.message },
      },
    );
  }

  async releaseWithRetry(task: PublishTask, errorMessage: string): Promise<void> {
    const attempts = task.attempts;
    if (attempts >= task.maxAttempts) {
      await this.tasks.update(
        { id: task.id },
        { status: PublishTaskStatus.Failed, finishedAt: new Date(), errorMessage, lockedBy: null, lockedAt: null },
      );
      return;
    }
    await this.tasks.update(
      { id: task.id },
      {
        status: PublishTaskStatus.Pending,
        scheduledAt: new Date(Date.now() + (await this.retryIntervalMs())),
        errorMessage,
        lockedBy: null,
        lockedAt: null,
      },
    );
  }

  /**
   * Manual retry: allowed for tasks that are not in flight. Clears the queue-confirmation
   * flag so plugin platforms can be pushed again as well.
   */
  async retry(id: string, actor: PublishActor): Promise<PublishTask> {
    const task = await this.tasks.findOne({ where: { id } });
    if (!task) throw new NotFoundException('发布任务不存在');

    const retryable: PublishTaskStatus[] = [
      PublishTaskStatus.Failed,
      PublishTaskStatus.ManualRequired,
      PublishTaskStatus.Canceled,
      PublishTaskStatus.Pending,
    ];
    if (!retryable.includes(task.status)) {
      throw new BadRequestException(`当前状态（${task.status}）不支持重试`);
    }

    const previousStatus = task.status;
    const extra = { ...task.extra };
    delete extra.awaitingConfirmation;
    delete extra.pluginMessage;
    delete extra.manualMessage;

    await this.tasks.save({
      ...task,
      status: PublishTaskStatus.Pending,
      attempts: 0,
      scheduledAt: null,
      startedAt: null,
      finishedAt: null,
      errorMessage: null,
      lockedBy: null,
      lockedAt: null,
      extra,
    });
    await this.queue.enqueue(task.id);

    await this.audit.record({
      action: 'publish_task.retry',
      resourceType: 'publish_task',
      resourceId: task.id,
      tenantId: task.tenantId,
      workspaceId: task.workspaceId,
      actorId: actor.id ?? null,
      actorName: actor.name ?? null,
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      payload: { platform: task.platform, previousStatus },
    });

    this.logger.log(`任务 ${task.id} 已重新入队（原状态 ${previousStatus}）`);
    return this.get(task.id);
  }

  /** Tasks the sweeper must re-enqueue: due scheduled tasks and pending tasks that are not waiting for a human. */
  async findDueTasks(limit = 20): Promise<PublishTask[]> {
    const now = new Date();
    return this.tasks
      .createQueryBuilder('task')
      .where('task.status = :scheduled AND task.scheduledAt <= :now', { scheduled: PublishTaskStatus.Scheduled, now })
      .orWhere(
        "task.status = :pending AND (task.extra->>'awaitingConfirmation') IS DISTINCT FROM 'true' AND (task.scheduledAt IS NULL OR task.scheduledAt <= :now)",
        { pending: PublishTaskStatus.Pending, now },
      )
      .orderBy('task.createdAt', 'ASC')
      .limit(limit)
      .getMany();
  }

  async enqueue(taskId: string): Promise<void> {
    await this.queue.enqueue(taskId);
  }

  private async requireAccount(accountId: string, platform: PlatformCode, workspaceId: string): Promise<SocialAccount> {
    const account = await this.accounts.findOne({ where: { id: accountId, workspaceId } });
    if (!account) throw new NotFoundException('绑定的平台账号不存在');
    if (account.platformCode !== platform) {
      throw new BadRequestException(`账号所属平台(${account.platformCode})与任务平台(${platform})不一致`);
    }
    return account;
  }

  /** Credentials come from the runtime settings (admin UI), falling back to .env. */
  private async credential(platform: PlatformCode, kind: 'appId' | 'appSecret'): Promise<string> {
    const keys = this.credentialKeys(platform);
    return (await this.settings.get(kind === 'appId' ? keys.appId : keys.appSecret)) ?? '';
  }

  private credentialKeys(platform: PlatformCode): { appId: string; appSecret: string } {
    switch (platform) {
      case PlatformCode.WechatMp:
      case PlatformCode.WechatVideo:
        return { appId: 'WECHAT_MP_APP_ID', appSecret: 'WECHAT_MP_APP_SECRET' };
      case PlatformCode.Douyin:
        return { appId: 'DOUYIN_CLIENT_KEY', appSecret: 'DOUYIN_CLIENT_SECRET' };
      case PlatformCode.Xiaohongshu:
        return { appId: 'XIAOHONGSHU_APP_ID', appSecret: 'XIAOHONGSHU_APP_SECRET' };
      default:
        return { appId: 'WECHAT_MP_APP_ID', appSecret: 'WECHAT_MP_APP_SECRET' };
    }
  }
}
