import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  AdapterCapabilities,
  AdapterCredentials,
  ChannelAdapter,
  ChannelAdapterRegistry,
  PublishPayload,
  PublishResult,
} from '@mediaflow/channel-adapters';
import { AiFlagType, ContentStatus, PLATFORM_LABELS, PUBLISH_RETRY, PlatformCode, PublishMode, PublishTaskStatus, appendAiDisclosure, buildAiMetadata } from '@mediaflow/shared';
import { In, IsNull, Repository } from 'typeorm';
import { QuotaService } from '../modules/billing/quota.service';
import { NotificationService } from '../modules/notification/notification.service';
import { AuditService } from '../audit/audit.service';
import { runtime } from '../modules/settings/runtime-config';
import { WorkspaceContextService } from '../common/workspace-context.service';
import { SettingsService } from '../modules/settings/settings.service';
import { ContentVariant } from '../modules/content/entities/content-variant.entity';
import { Content } from '../modules/content/entities/content.entity';
import { SocialAccount } from '../modules/platform/entities/social-account.entity';
import { ContentReview } from '../modules/content/entities/content-review.entity';
import { SocialAccountService } from '../modules/platform/social-account.service';
import { PublishTask } from '../modules/publish/entities/publish-task.entity';
import { CHANNEL_REGISTRY } from './channel-registry.provider';
import { CreatePublishTaskDto } from './dto/create-publish-task.dto';
import { QueryPublishTaskDto } from './dto/query-publish-task.dto';
import { AiGeneration } from '../modules/ai/entities/ai-generation.entity';
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
    @InjectRepository(AiGeneration) private readonly aiGenerations: Repository<AiGeneration>,
    @InjectRepository(ContentReview) private readonly reviews: Repository<ContentReview>,
    private readonly socialAccounts: SocialAccountService,
    @Inject(CHANNEL_REGISTRY) private readonly registry: ChannelAdapterRegistry,
    private readonly queue: PublishQueueService,
    private readonly audit: AuditService,
    private readonly workspaceContext: WorkspaceContextService,
    private readonly settings: SettingsService,
    private readonly quota: QuotaService,
    private readonly notifications: NotificationService,
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

  /** 「该内容在该平台已有未完成任务」的统一文案（平台名用中文标签，便于运营理解）。 */
  private duplicateMessage(platforms: string[]): string {
    const labels = platforms.map((platform) => PLATFORM_LABELS[platform as PlatformCode] ?? platform).join('、');
    return `该内容在以下平台已有未完成任务：${labels}（同一内容同一平台不重复排期；如需重新发布，请先取消该任务或等待其完成）`;
  }

  async createTasks(dto: CreatePublishTaskDto, actor: PublishActor): Promise<PublishTask[]> {
    // B0.7：发布次数配额（计划里为 0 表示不限制）
    await this.quota.assertQuota('publish', 1);
    const scope = await this.workspaceContext.current();
    const content = await this.contents.findOne({ where: { id: dto.contentId, workspaceId: scope.workspaceId } });
    if (!content) throw new NotFoundException('内容不存在或无权访问');

    /**
     * 标识不再是发布闸门（用户要求：默认就是没有，不强制）。
     * 只在内容确实由 AI 参与且尚未复核时留一条日志，方便事后追溯，不影响发布。
     */
    if (content.aiGenerated && !content.aiFlagChecked) {
      this.logger.log(`内容 ${content.id} 由 AI 参与生成但标识未复核，按配置继续发布`);
    }

    /**
     * 审核闸门（审计 P1-1 加固）：
     * 不只看 content.status —— 状态字段可能被历史数据/直接改库影响，必须回到审核记录本身：
     * 1. 最新一轮审核结论必须是 approved；
     * 2. 审批之后内容不得再被修改（updatedAt <= decidedAt），否则视为"结论过期"。
     */
    if (await this.settings.getBoolean('REQUIRE_CONTENT_APPROVAL', false)) {
      const latestReview = await this.reviews.findOne({
        where: { contentId: content.id, workspaceId: scope.workspaceId },
        order: { round: 'DESC' },
      });
      const approved = latestReview?.status === 'approved';
      // 用审批时记录的内容版本比较，避免"审批自身刷新 updatedAt"造成误判
      const approvedVersion = latestReview?.contentUpdatedAt ?? null;
      const editedAfterApproval = Boolean(
        approved && approvedVersion && content.updatedAt && content.updatedAt.getTime() > approvedVersion.getTime() + 1000,
      );
      if (content.status !== ContentStatus.Approved || !approved) {
        throw new BadRequestException('该内容尚未通过最新一轮审核，不能创建发布任务（可在系统设置中关闭「发布前必须审核通过」）');
      }
      if (editedAfterApproval) {
        throw new BadRequestException('该内容在审核通过后又被修改，请重新提交审核');
      }
    }

    const platforms = [...new Set(dto.platforms)];
    const scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : null;
    if (scheduledAt && Number.isNaN(scheduledAt.getTime())) throw new BadRequestException('scheduledAt 不是合法时间');

    /**
     * 幂等闸门（审计 P2-2）：同一内容在同一平台已有「未完成任务」时不再重复建单。
     * 否则一次误点就会把同一篇内容推给平台两次——这是真实的内容事故，不是重复劳动。
     * 数据库侧另有部分唯一索引兜底（并发下后到的请求会命中唯一冲突，转成同样的 409）。
     */
    const activeStatuses = [PublishTaskStatus.Pending, PublishTaskStatus.Scheduled, PublishTaskStatus.Publishing];
    const existingActive = await this.tasks.find({
      where: { contentId: content.id, platform: In(platforms), status: In(activeStatuses) },
    });
    if (existingActive.length > 0) {
      throw new ConflictException(this.duplicateMessage([...new Set(existingActive.map((task) => task.platform))]));
    }

    const created: PublishTask[] = [];
    for (const platform of platforms) {
      const adapter = this.adapterFor(platform);
      const boundAccount = dto.socialAccountId
        ? await this.requireAccount(dto.socialAccountId, platform, scope.workspaceId)
        : null;
      /**
       * 无 API 凭证的账号（手动登记，或授权未完成）：不能走 API 发布，**自动落到人工/插件模式**，
       * 否则任务会在适配器里因"没有凭据"失败，用户还得自己猜原因。
       * 这里把模式改掉并在 extra 里写清下一步（插件填充 → 人工确认 → 回填结果）。
       */
      const lacksCredential = Boolean(boundAccount) && !boundAccount?.accessToken;
      const publishMode = lacksCredential ? PublishMode.Manual : adapter.capabilities.mode;

      // 优先使用该平台的 AI 适配版本（没有则回落到主内容），否则多平台适配等于白做。
      const variant = await this.variants.findOne({
        where: { contentId: content.id, platform, workspaceId: scope.workspaceId },
      });

      const isFuture = Boolean(scheduledAt && scheduledAt.getTime() > Date.now());
      const task = this.tasks.create({
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        contentId: content.id,
        contentVariantId: variant?.id ?? null,
        platform,
        publishMode,
        socialAccountId: dto.socialAccountId ?? null,
        status: isFuture ? PublishTaskStatus.Scheduled : PublishTaskStatus.Pending,
        scheduledAt,
        maxAttempts: dto.maxAttempts ?? PUBLISH_RETRY.maxAttempts,
        attempts: 0,
        createdBy: actor.id ?? null,
        extra: lacksCredential
          ? {
              manualMessage:
                '该账号未配置 API 凭证（手动登记或授权未完成）：请用浏览器插件填充内容后人工确认发布，再回到队列回填结果。',
              manualReason: 'no_credential',
            }
          : {},
      });
      let saved: PublishTask;
      try {
        saved = await this.tasks.save(task);
      } catch (error) {
        // 部分唯一索引（UQ_publish_tasks_active_content_platform）命中：并发下两个请求同时建单
        if ((error as { code?: string }).code === '23505') throw new ConflictException(this.duplicateMessage([platform]));
        throw error;
      }

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
        payload: {
          platform,
          contentId: content.id,
          variantId: variant?.id ?? null,
          scheduledAt: saved.scheduledAt?.toISOString() ?? null,
        },
      });
      created.push(saved);
    }

    // B0.7：用量流水（每个任务记一次；计数器同月累加）
    for (const task of created) {
      await this.quota.recordUsage('publish', 1, { sourceType: 'publish_task', sourceId: task.id });
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

  /**
   * Load one task inside the current workspace scope.
   *
   * The workspace filter is mandatory: without it any workspace could read (and then
   * mutate) another workspace's tasks by guessing an id — the cross-tenant leak that
   * test/cross-workspace.e2e.spec.ts now pins down. Background callers are safe because
   * the worker wraps every message in runInWorkspaceScope() before calling in.
   */
  async get(id: string): Promise<PublishTask> {
    const scope = await this.workspaceContext.current();
    const task = await this.tasks.findOne({
      where: { id, workspaceId: scope.workspaceId },
      relations: { content: true, contentVariant: true },
    });
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

  /**
   * 队列运维视图：卡住的任务、死信（重试次数用尽）以及队列本身的状态。
   * 运维界面据此可以直接把卡住的任务重排，不用登服务器看日志。
   */
  async queueHealth(): Promise<{
    stream: string;
    group: string;
    length: number;
    pending: number;
    consumers: number;
    workerEnabled: boolean;
    stuckMinutes: number;
    stuckTasks: Array<{
      id: string;
      title: string | null;
      platform: PlatformCode;
      status: PublishTaskStatus;
      attempts: number;
      maxAttempts: number;
      lockedBy: string | null;
      lockedAt: string | null;
      lockedMinutes: number;
    }>;
    deadLetters: Array<{
      id: string;
      title: string | null;
      platform: PlatformCode;
      attempts: number;
      maxAttempts: number;
      errorMessage: string | null;
      finishedAt: string | null;
    }>;
  }> {
    const scope = await this.workspaceContext.current();
    const stuckMinutes = runtime().publish.stuckMinutes;
    const deadline = new Date(Date.now() - stuckMinutes * 60_000);
    const stats = await this.queue.stats();

    const stuck = await this.tasks
      .createQueryBuilder('task')
      .where('task.workspaceId = :workspaceId', { workspaceId: scope.workspaceId })
      .andWhere('task.lockedAt IS NOT NULL AND task.lockedAt < :deadline', { deadline })
      .andWhere('task.status IN (:...statuses)', {
        statuses: [PublishTaskStatus.Pending, PublishTaskStatus.Publishing, PublishTaskStatus.Scheduled],
      })
      .orderBy('task.lockedAt', 'ASC')
      .limit(50)
      .getMany();

    const dead = await this.tasks.find({
      where: { workspaceId: scope.workspaceId, status: PublishTaskStatus.Failed },
      order: { finishedAt: 'DESC' },
      take: 50,
    });

    const titles = new Map<string, string>();
    const contentIds = [...new Set([...stuck, ...dead].map((task) => task.contentId))];
    if (contentIds.length > 0) {
      const contents = await this.contents.find({ where: { id: In(contentIds) }, select: ['id', 'title'] });  // tenant-scope-ok: 任务行先按 workspaceId 取到，此处按 task.id 跟进
      for (const content of contents) titles.set(content.id, content.title);
    }

    return {
      stream: runtime().publish.streamName,
      group: runtime().publish.groupName,
      length: stats.length,
      pending: stats.pending,
      consumers: stats.consumers,
      workerEnabled: runtime().publish.workerEnabled,
      stuckMinutes,
      stuckTasks: stuck.map((task) => ({
        id: task.id,
        title: titles.get(task.contentId) ?? null,
        platform: task.platform,
        status: task.status,
        attempts: task.attempts,
        maxAttempts: task.maxAttempts,
        lockedBy: task.lockedBy,
        lockedAt: task.lockedAt?.toISOString() ?? null,
        lockedMinutes: task.lockedAt ? Math.round((Date.now() - new Date(task.lockedAt).getTime()) / 60_000) : 0,
      })),
      deadLetters: dead.map((task) => ({
        id: task.id,
        title: titles.get(task.contentId) ?? null,
        platform: task.platform,
        attempts: task.attempts,
        maxAttempts: task.maxAttempts,
        errorMessage: task.errorMessage,
        finishedAt: task.finishedAt?.toISOString() ?? null,
      })),
    };
  }

  /**
   * 强制重排：清掉锁与重试计数后重新入队。
   * 与 retry() 的区别是**无视锁定状态**——卡住的任务锁还在，普通 retry 会拒绝。
   */
  /**
   * 人工发布完成回填（无平台密钥时的主要出山路径）。
   *
   * 允许从 `manual_required` / `pending` / `failed` 等"未发布"状态回填：
   * 真实场景里用户可能先在公众号后台发完，再回来点这个按钮（那时任务可能还停在待人工发布或已失败）。
   * 已发布/已取消的任务不允许再回填（前者避免重复记账，后者是终态）。
   */
  async markManualPublished(
    id: string,
    dto: { url?: string; postId?: string; note?: string },
    actor: PublishActor,
  ): Promise<PublishTask> {
    const scope = await this.workspaceContext.current();
    const task = await this.tasks.findOne({ where: { id, workspaceId: scope.workspaceId } });
    if (!task) throw new NotFoundException('发布任务不存在');
    if (task.status === PublishTaskStatus.Published) {
      throw new ConflictException('该任务已标记为已发布；如需更正链接请用「标记失败」重开后再回填');
    }
    if (task.status === PublishTaskStatus.Canceled) {
      throw new BadRequestException('已取消的任务不能标记为已发布：如需发布请新建任务');
    }

    const publishedAt = new Date();
    const extra = {
      ...task.extra,
      manualPublish: {
        by: actor.id ?? null,
        byName: actor.name ?? null,
        at: publishedAt.toISOString(),
        note: dto.note?.trim() || null,
        /** 标明这是人工回填而不是适配器自动发布，数据中心据此区分口径 */
        source: 'manual',
      },
    };

    await this.tasks.update(
      { id: task.id },
      {
        status: PublishTaskStatus.Published,
        finishedAt: publishedAt,
        errorMessage: null,
        lockedBy: null,
        lockedAt: null,
        platformUrl: dto.url?.trim() || task.platformUrl || null,
        platformPostId: dto.postId?.trim() || task.platformPostId || null,
        extra,
      } as never,
    );

    await this.audit.record({
      action: 'publish_task.manual_published',
      resourceType: 'publish_task',
      resourceId: task.id,
      tenantId: task.tenantId,
      workspaceId: task.workspaceId,
      actorId: actor.id ?? null,
      actorName: actor.name ?? null,
      payload: {
        platform: task.platform,
        url: dto.url?.trim() || null,
        postId: dto.postId?.trim() || null,
        note: dto.note?.trim() || null,
        previousStatus: task.status,
      },
    });

    await this.notifyManualOutcome(task, true, dto.note ?? null);
    const updated = await this.tasks.findOneOrFail({ where: { id: task.id } });  // tenant-scope-ok: 任务行先按 workspaceId 取到，此处按 task.id 跟进
    this.logger.log(`发布任务已人工回填为已发布：${task.id}（${task.platform}）`);
    return updated;
  }

  /** 人工发布失败回填：写明原因，任务转为 failed 并留痕（可再重试或重排）。 */
  async markManualFailed(id: string, dto: { reason: string }, actor: PublishActor): Promise<PublishTask> {
    const scope = await this.workspaceContext.current();
    const task = await this.tasks.findOne({ where: { id, workspaceId: scope.workspaceId } });
    if (!task) throw new NotFoundException('发布任务不存在');
    if (task.status === PublishTaskStatus.Published) {
      throw new ConflictException('已发布的任务不能标记为失败');
    }
    if (task.status === PublishTaskStatus.Canceled) {
      throw new BadRequestException('已取消的任务不能再标记失败');
    }

    const reason = dto.reason.trim();
    const extra = {
      ...task.extra,
      manualPublish: {
        by: actor.id ?? null,
        byName: actor.name ?? null,
        at: new Date().toISOString(),
        reason,
        source: 'manual',
      },
    };

    await this.tasks.update(
      { id: task.id },
      { status: PublishTaskStatus.Failed, errorMessage: reason, finishedAt: new Date(), extra } as never,
    );
    await this.audit.record({
      action: 'publish_task.manual_failed',
      resourceType: 'publish_task',
      resourceId: task.id,
      tenantId: task.tenantId,
      workspaceId: task.workspaceId,
      actorId: actor.id ?? null,
      actorName: actor.name ?? null,
      payload: { platform: task.platform, reason, previousStatus: task.status },
    });
    await this.notifyManualOutcome(task, false, reason);
    const updated = await this.tasks.findOneOrFail({ where: { id: task.id } });  // tenant-scope-ok: 任务行先按 workspaceId 取到，此处按 task.id 跟进
    this.logger.warn(`发布任务被人工标记为失败：${task.id}（${task.platform}）｜${reason}`);
    return updated;
  }

  /** 人工发布结果通报（站内通知；失败时用 warning 级，便于队列页顶部提示）。 */
  private async notifyManualOutcome(task: PublishTask, ok: boolean, detail: string | null): Promise<void> {
    try {
      const content = await this.contents.findOne({ where: { id: task.contentId, workspaceId: task.workspaceId } });
      await this.notifications.notify({
        title: ok ? `人工发布已回填：${content?.title ?? '内容'}` : `人工发布失败：${content?.title ?? '内容'}`,
        body: ok
          ? `${PLATFORM_LABELS[task.platform] ?? task.platform} 已由成员手动发布并回填${detail ? `（${detail}）` : ''}。`
          : `${PLATFORM_LABELS[task.platform] ?? task.platform} 人工发布未完成：${detail ?? '未填写原因'}`,
        type: ok ? 'publish.manual_completed' : 'publish.manual_failed',
        level: ok ? 'info' : 'warning',
        resourceType: 'publish_task',
        resourceId: task.id,
      });
    } catch (error) {
      this.logger.warn(`人工发布通报失败（不影响主流程）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async requeue(id: string, actor: PublishActor): Promise<PublishTask> {
    const scope = await this.workspaceContext.current();
    const task = await this.tasks.findOne({ where: { id, workspaceId: scope.workspaceId } });
    if (!task) throw new NotFoundException('发布任务不存在');
    if (task.status === PublishTaskStatus.Published) {
      throw new BadRequestException('已发布的任务不能重排');
    }
    if (task.status === PublishTaskStatus.Canceled) {
      throw new BadRequestException('已取消的任务不能重排：如需重新发布请新建任务');
    }

    const previousStatus = task.status;
    const extra = { ...task.extra };
    delete extra.awaitingConfirmation;
    delete extra.manualMessage;
    delete extra.pluginMessage;

    await this.tasks.update(
      { id: task.id },
      {
        status: PublishTaskStatus.Pending,
        attempts: 0,
        scheduledAt: null,
        startedAt: null,
        finishedAt: null,
        errorMessage: null,
        lockedBy: null,
        lockedAt: null,
        extra,
      } as never,
    );
    await this.queue.enqueue(task.id);

    await this.audit.record({
      action: 'publish_task.requeue',
      resourceType: 'publish_task',
      resourceId: task.id,
      tenantId: task.tenantId,
      workspaceId: task.workspaceId,
      actorId: actor.id ?? null,
      actorName: actor.name ?? null,
      payload: { platform: task.platform, previousStatus, forced: Boolean(task.lockedBy) },
    });
    this.logger.log(`任务 ${task.id} 已强制重排（原状态 ${previousStatus}）`);
    return this.get(task.id);
  }

  /** Builds the platform payload, including the mandatory AI disclosure suffix. */
  async buildPayload(task: PublishTask): Promise<PublishPayload> {
    /**
     * Read the content/variant inside the task's own workspace. The worker already runs
     * under the task's scope, but tying the lookup to task.workspaceId keeps this method
     * correct no matter which scope the caller is in.
     */
    const content = await this.contents.findOne({ where: { id: task.contentId, workspaceId: task.workspaceId } });
    if (!content) throw new Error('内容不存在或已被删除');

    const variant = task.contentVariantId
      ? await this.variants.findOne({ where: { id: task.contentVariantId, contentId: task.contentId } })  // tenant-scope-ok: 任务行先按 workspaceId 取到，此处按 task.id 跟进
      : null;

    const aiFlagType = variant?.aiFlagType ?? content.aiFlagType;
    const aiGenerated = aiFlagType !== AiFlagType.None;

    // 隐式标识：AI 生成内容带图片/视频时，按法规要求附上元数据（可在设置里关闭）。
    const aiMetadata =
      aiGenerated && runtime().publish.aiMetadataEnabled
        ? buildAiMetadata(aiFlagType, await this.resolveAiModel(task.contentId))
        : undefined;
    if (aiMetadata) {
      await this.mergeExtra(task.id, { aiMetadata });
    }

    return {
      taskId: task.id,
      title: variant?.title ?? content.title,
      body: appendAiDisclosure(variant?.body ?? content.body, aiFlagType, runtime().site.aiDisclosureSuffix),
      tags: variant?.tags ?? content.tags,
      mediaUrls: variant?.mediaUrls ?? content.mediaUrls,
      coverUrl: content.coverUrl ?? undefined,
      scheduledAt: task.scheduledAt?.toISOString(),
      aiGenerated,
      ...(aiMetadata ? { aiMetadata } : {}),
    };
  }

  /** 取该内容最近一次 AI 调用用的模型名，用于元数据可追溯；查不到就用当前配置的模型。 */
  private async resolveAiModel(contentId: string): Promise<string> {
    try {
      const latest = await this.aiGenerations.findOne({ where: { contentId }, order: { createdAt: 'DESC' } });
      return latest?.model ?? (await this.settings.get('AI_MODEL')) ?? 'unknown';
    } catch {
      return 'unknown';
    }
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
  /** 读取任务所属的租户/工作区（后台 worker 建立作用域用，不能受当前作用域过滤影响）。 */
  async scopeOf(taskId: string): Promise<{ tenantId: string; workspaceId: string } | null> {
    /**
     * 队列消息里的 taskId 来自 Redis，可能是人工写入或历史脏数据：
     * 非 uuid 直接当作"任务不存在"，避免 Postgres 抛 invalid input syntax for type uuid
     * 把 worker 的消费循环打成错误日志。
     */
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId)) {
      this.logger.warn(`队列消息里的 taskId 不是合法 UUID，已忽略：${taskId.slice(0, 40)}`);
      return null;
    }
    const task = await this.tasks.findOne({ where: { id: taskId }, select: ['id', 'tenantId', 'workspaceId'] });
    if (!task) return null;
    return { tenantId: task.tenantId, workspaceId: task.workspaceId };
  }

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

  /**
   * 合并式更新任务 extra（JSONB）。
   *
   * 之前直接用内存里的 task.extra 覆盖，会把并发写入（例如 buildPayload 刚写入的
   * AI 标识元数据）冲掉 —— 实测确实丢过。这里先读最新行再合并，保证不丢字段。
   */
  private async mergeExtra(
    taskId: string,
    patch: Record<string, unknown>,
    rest: Record<string, unknown> = {},
  ): Promise<void> {
    const scope = await this.workspaceContext.current();
    const current = await this.tasks.findOne({
      where: { id: taskId, workspaceId: scope.workspaceId },
      select: ['id', 'extra'],
    });
    const merged: Record<string, unknown> = { ...(current?.extra ?? {}), ...patch };
    await this.tasks.update({ id: taskId, workspaceId: scope.workspaceId }, { ...rest, extra: merged } as never);
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
    await this.mergeExtra(task.id, { manualMessage: result.message }, {
      status: PublishTaskStatus.ManualRequired,
      finishedAt: new Date(),
      errorMessage: null,
      lockedBy: null,
      lockedAt: null,
    });
  }

  async markAwaitingHuman(task: PublishTask, result: PublishResult): Promise<void> {
    await this.mergeExtra(task.id, { awaitingConfirmation: true, pluginMessage: result.message }, {
      status: PublishTaskStatus.Pending,
      scheduledAt: null,
      lockedBy: null,
      lockedAt: null,
      errorMessage: null,
    });
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
    const scope = await this.workspaceContext.current();
    const task = await this.tasks.findOne({ where: { id, workspaceId: scope.workspaceId } });
    if (!task) throw new NotFoundException('发布任务不存在');

    /**
     * 取消是用户的明确决定，不能被 retry 悄悄复活（P2-4）：否则一次误点就会把
     * 已放弃的内容重新推给平台。取消态请改用「新建任务」。
     */
    if (task.status === PublishTaskStatus.Canceled) {
      throw new BadRequestException('已取消的任务不能重试：取消是明确决定，如需重新发布请新建任务');
    }

    const retryable: PublishTaskStatus[] = [
      PublishTaskStatus.Failed,
      PublishTaskStatus.ManualRequired,
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

  /** 批量取消/重试：逐条执行并返回失败原因，一条失败不影响其它。 */
  async batch(
    ids: string[],
    action: 'cancel' | 'retry',
    actor: PublishActor,
  ): Promise<{ affected: number; failed: Array<{ id: string; reason: string }> }> {
    const failed: Array<{ id: string; reason: string }> = [];
    let affected = 0;
    for (const id of ids) {
      try {
        if (action === 'cancel') await this.cancel(id, actor);
        else await this.retry(id, actor);
        affected += 1;
      } catch (error) {
        failed.push({ id, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    const scope = await this.workspaceContext.current();
    await this.audit.record({
      action: `publish_task.batch_${action}`,
      resourceType: 'publish_task',
      resourceId: ids[0] ?? null,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      actorId: actor.id ?? null,
      actorName: actor.name ?? null,
      payload: { total: ids.length, affected, failed: failed.length },
    });
    return { affected, failed };
  }

  /**
   * Cancel a task that has not been published yet. Tasks in flight must not be cancelled
   * (the worker may already have called the platform) and published ones are final.
   */
  async cancel(id: string, actor: PublishActor): Promise<PublishTask> {
    const scope = await this.workspaceContext.current();
    const task = await this.tasks.findOne({ where: { id, workspaceId: scope.workspaceId } });
    if (!task) throw new NotFoundException('发布任务不存在');

    const cancelable: PublishTaskStatus[] = [
      PublishTaskStatus.Pending,
      PublishTaskStatus.Scheduled,
      PublishTaskStatus.Failed,
      PublishTaskStatus.ManualRequired,
    ];
    if (!cancelable.includes(task.status)) {
      throw new BadRequestException(`当前状态（${task.status}）不能取消：发布中或已发布的任务无法取消`);
    }

    const previousStatus = task.status;
    await this.tasks.save({
      ...task,
      status: PublishTaskStatus.Canceled,
      finishedAt: new Date(),
      lockedBy: null,
      lockedAt: null,
      errorMessage: null,
    });

    await this.audit.record({
      action: 'publish_task.cancel',
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

    this.logger.log(`任务 ${task.id} 已取消（原状态 ${previousStatus}）`);
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
      case PlatformCode.Baijiahao:
        return { appId: 'BAIJIAHAO_APP_ID', appSecret: 'BAIJIAHAO_APP_TOKEN' };
      default:
        return { appId: 'WECHAT_MP_APP_ID', appSecret: 'WECHAT_MP_APP_SECRET' };
    }
  }
}
