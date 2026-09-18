import { BadGatewayException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { PlatformCode, PublishTaskStatus } from '@mediaflow/shared';
import {
  IsNull, Between, Repository } from 'typeorm';
import { ChannelAdapterRegistry } from '@mediaflow/channel-adapters';
import { WorkspaceContextService } from '../../common/workspace-context.service';
import { CHANNEL_REGISTRY } from '../../publish/channel-registry.provider';
import { PublishService } from '../../publish/publish.service';
import { Content } from '../content/entities/content.entity';
import { SocialAccount } from '../platform/entities/social-account.entity';
import { PublishTask } from '../publish/entities/publish-task.entity';
import { Analytics } from './entities/analytics.entity';
import { TrackEvent } from './entities/track-event.entity';
import { Inject } from '@nestjs/common';

export interface OverviewResult {
  contents: number;
  tasks: number;
  published: number;
  pending: number;
  manualRequired: number;
  failed: number;
  aiGenerated: number;
  publishedLast7Days: number;
  platformBreakdown: Array<{ platform: PlatformCode; total: number; published: number }>;
}

export interface TrendPoint {
  date: string;
  published: number;
  failed: number;
  views: number;
  likes: number;
}

export interface ContentMetrics {
  contentId: string;
  title: string;
  tasks: number;
  published: number;
  failed: number;
  latest: Array<{ platform: PlatformCode; capturedAt: string; views: number; likes: number; comments: number; shares: number; favorites: number }>;
}

export interface AccountRanking {
  socialAccountId: string;
  accountName: string;
  platform: PlatformCode;
  published: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
}

@Injectable()
export class AnalyticsService {
  constructor(
    @InjectRepository(Analytics) private readonly analytics: Repository<Analytics>,
    @InjectRepository(TrackEvent) private readonly events: Repository<TrackEvent>,
    @InjectRepository(Content) private readonly contents: Repository<Content>,
    @InjectRepository(PublishTask) private readonly tasks: Repository<PublishTask>,
    @InjectRepository(SocialAccount) private readonly accounts: Repository<SocialAccount>,
    private readonly workspaceContext: WorkspaceContextService,
    private readonly publishService: PublishService,
    @Inject(CHANNEL_REGISTRY) private readonly registry: ChannelAdapterRegistry,
  ) {}

  async overview(): Promise<OverviewResult> {
    const scope = await this.workspaceContext.current();
    const workspace = { workspaceId: scope.workspaceId };

    const contents = await this.contents.count({ where: workspace });
    const aiGenerated = await this.contents.count({ where: { ...workspace, aiGenerated: true } });
    const tasks = await this.tasks.find({ where: workspace, select: { id: true, platform: true, status: true, finishedAt: true } });

    const byStatus = (status: PublishTaskStatus): number => tasks.filter((task) => task.status === status).length;
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const publishedLast7Days = tasks.filter(
      (task) => task.status === PublishTaskStatus.Published && task.finishedAt && task.finishedAt >= sevenDaysAgo,
    ).length;

    const platforms = [...new Set(tasks.map((task) => task.platform))];
    const platformBreakdown = platforms.map((platform) => ({
      platform,
      total: tasks.filter((task) => task.platform === platform).length,
      published: tasks.filter((task) => task.platform === platform && task.status === PublishTaskStatus.Published).length,
    }));

    return {
      contents,
      tasks: tasks.length,
      published: byStatus(PublishTaskStatus.Published),
      pending: byStatus(PublishTaskStatus.Pending) + byStatus(PublishTaskStatus.Scheduled),
      manualRequired: byStatus(PublishTaskStatus.ManualRequired),
      failed: byStatus(PublishTaskStatus.Failed),
      aiGenerated,
      publishedLast7Days,
      platformBreakdown,
    };
  }

  /** Daily buckets for the last N days: publish outcomes plus aggregated platform metrics. */
  async trend(days = 14): Promise<TrendPoint[]> {
    const scope = await this.workspaceContext.current();
    const span = Math.min(Math.max(days, 3), 90);
    const since = new Date(Date.now() - (span - 1) * 24 * 3600 * 1000);
    since.setHours(0, 0, 0, 0);

    const tasks = await this.tasks
      .createQueryBuilder('task')
      .where('task.workspaceId = :workspaceId', { workspaceId: scope.workspaceId })
      .andWhere('COALESCE(task.finishedAt, task.createdAt) >= :since', { since })
      .getMany();

    const snapshots = await this.analytics.find({
      where: { workspaceId: scope.workspaceId, capturedAt: Between(since, new Date()) },
    });

    const buckets = new Map<string, TrendPoint>();
    for (let index = 0; index < span; index += 1) {
      const day = new Date(since.getTime() + index * 24 * 3600 * 1000);
      const key = this.dayKey(day);
      buckets.set(key, { date: key, published: 0, failed: 0, views: 0, likes: 0 });
    }

    for (const task of tasks) {
      const key = this.dayKey(task.finishedAt ?? task.createdAt);
      const bucket = buckets.get(key);
      if (!bucket) continue;
      if (task.status === PublishTaskStatus.Published) bucket.published += 1;
      if (task.status === PublishTaskStatus.Failed) bucket.failed += 1;
    }

    for (const snapshot of snapshots) {
      const bucket = buckets.get(this.dayKey(snapshot.capturedAt));
      if (!bucket) continue;
      bucket.views += snapshot.views;
      bucket.likes += snapshot.likes;
    }

    return [...buckets.values()];
  }

  async contentMetrics(contentId: string): Promise<ContentMetrics> {
    const scope = await this.workspaceContext.current();
    const content = await this.contents.findOne({ where: { id: contentId, workspaceId: scope.workspaceId } });
    if (!content) throw new NotFoundException('内容不存在');

    const tasks = await this.tasks.find({ where: { contentId, workspaceId: scope.workspaceId } });
    const snapshots = await this.analytics.find({
      where: { contentId, workspaceId: scope.workspaceId },
      order: { capturedAt: 'DESC' },
      take: 20,
    });
    const latestByPlatform = new Map<PlatformCode, Analytics>();
    for (const snapshot of snapshots) {
      if (!latestByPlatform.has(snapshot.platform)) latestByPlatform.set(snapshot.platform, snapshot);
    }

    return {
      contentId: content.id,
      title: content.title,
      tasks: tasks.length,
      published: tasks.filter((task) => task.status === PublishTaskStatus.Published).length,
      failed: tasks.filter((task) => task.status === PublishTaskStatus.Failed).length,
      latest: [...latestByPlatform.values()].map((snapshot) => ({
        platform: snapshot.platform,
        capturedAt: snapshot.capturedAt.toISOString(),
        views: snapshot.views,
        likes: snapshot.likes,
        comments: snapshot.comments,
        shares: snapshot.shares,
        favorites: snapshot.favorites,
      })),
    };
  }

  async accountRanking(): Promise<AccountRanking[]> {
    const scope = await this.workspaceContext.current();
    const accounts = await this.accounts.find({ where: { workspaceId: scope.workspaceId } });
    const tasks = await this.tasks.find({ where: { workspaceId: scope.workspaceId } });
    const snapshots = await this.analytics.find({ where: { workspaceId: scope.workspaceId } });

    return accounts
      .map((account) => {
        const related = snapshots.filter((snapshot) => snapshot.socialAccountId === account.id);
        return {
          socialAccountId: account.id,
          accountName: account.accountName,
          platform: account.platformCode,
          published: tasks.filter(
            (task) => task.socialAccountId === account.id && task.status === PublishTaskStatus.Published,
          ).length,
          views: related.reduce((sum, snapshot) => sum + snapshot.views, 0),
          likes: related.reduce((sum, snapshot) => sum + snapshot.likes, 0),
          comments: related.reduce((sum, snapshot) => sum + snapshot.comments, 0),
          shares: related.reduce((sum, snapshot) => sum + snapshot.shares, 0),
        };
      })
      .sort((left, right) => right.views - left.views || right.published - left.published);
  }

  /**
   * Pulls the latest platform metrics for published tasks.
   * Without platform credentials every call returns a clear per-task error instead of fake data.
   */
  async sync(input: { contentId?: string; limit?: number }): Promise<{
    synced: number;
    failed: number;
    results: Array<{ taskId: string; platform: PlatformCode; ok: boolean; message: string }>;
  }> {
    const scope = await this.workspaceContext.current();
    const tasks = await this.tasks.find({
      where: {
        workspaceId: scope.workspaceId,
        status: PublishTaskStatus.Published,
        ...(input.contentId ? { contentId: input.contentId } : {}),
      },
      take: Math.min(input.limit ?? 10, 50),
      order: { finishedAt: 'DESC' },
    });

    const results: Array<{ taskId: string; platform: PlatformCode; ok: boolean; message: string }> = [];
    let synced = 0;

    for (const task of tasks) {
      if (!task.platformPostId || !this.registry.has(task.platform)) {
        results.push({ taskId: task.id, platform: task.platform, ok: false, message: '缺少平台内容 ID 或平台不支持取数' });
        continue;
      }
      try {
        const credentials = await this.publishService.resolveCredentials(task.platform, task.socialAccountId);
        const snapshot = await this.registry.get(task.platform).fetchAnalytics(task.platformPostId, credentials);
        await this.upsertSnapshot({
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          contentId: task.contentId,
          contentVariantId: task.contentVariantId,
          publishTaskId: task.id,
          platform: task.platform,
          socialAccountId: task.socialAccountId,
          platformPostId: task.platformPostId,
          capturedAt: new Date(snapshot.capturedAt),
          views: snapshot.metrics.views,
          likes: snapshot.metrics.likes,
          comments: snapshot.metrics.comments,
          shares: snapshot.metrics.shares,
          favorites: snapshot.metrics.favorites,
          followers: snapshot.metrics.followers ?? 0,
          extra: {},
        });
        synced += 1;
        results.push({ taskId: task.id, platform: task.platform, ok: true, message: '已同步' });
      } catch (error) {
        results.push({
          taskId: task.id,
          platform: task.platform,
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (tasks.length === 0) {
      throw new BadGatewayException('没有可同步的已发布任务（需要先在平台发布成功并绑定账号）');
    }
    return { synced, failed: results.length - synced, results };
  }

  /**
   * 写入一份指标快照：**同一平台 + 同一作品（postId）只保留最新一条**。
   *
   * 背景：浏览器插件每轮回收抓到的都是"累计总量"，而排行/总览是把快照求和展示的。
   * 早期实现每次上报都插新行，结果同一作品被反复上报时数字会无限膨胀（实测 23180 → 46360）。
   * 没有 postId 时按"账号级快照"去重（同一账号同一平台一条）。
   */
  private async upsertSnapshot(input: {
    tenantId: string;
    workspaceId: string;
    platform: PlatformCode;
    socialAccountId: string | null;
    platformPostId: string | null;
    contentId?: string | null;
    contentVariantId?: string | null;
    publishTaskId?: string | null;
    capturedAt: Date;
    views: number;
    likes: number;
    comments: number;
    shares: number;
    favorites: number;
    followers?: number;
    extra?: Record<string, unknown>;
  }): Promise<{ id: string; created: boolean }> {
    const existing = await this.analytics.findOne({
      where: {
        workspaceId: input.workspaceId,
        platform: input.platform,
        socialAccountId: input.socialAccountId ?? IsNull(),
        platformPostId: input.platformPostId ?? IsNull(),
      },
    });

    const values = {
      contentId: input.contentId ?? existing?.contentId ?? null,
      contentVariantId: input.contentVariantId ?? existing?.contentVariantId ?? null,
      publishTaskId: input.publishTaskId ?? existing?.publishTaskId ?? null,
      capturedAt: input.capturedAt,
      views: input.views,
      likes: input.likes,
      comments: input.comments,
      shares: input.shares,
      favorites: input.favorites,
      followers: input.followers ?? 0,
      extra: { ...(existing?.extra ?? {}), ...(input.extra ?? {}) },
    };

    if (existing) {
      await this.analytics.update({ id: existing.id }, values as never);
      return { id: existing.id, created: false };
    }

    const saved = await this.analytics.save(
      this.analytics.create({
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        platform: input.platform,
        socialAccountId: input.socialAccountId,
        platformPostId: input.platformPostId,
        ...values,
      }),
    );
    return { id: saved.id, created: true };
  }

  /** Stores metrics reported by the browser extension (scraped from platform pages). */
  async savePluginMetrics(input: {
    platform: PlatformCode;
    socialAccountId?: string;
    contentId?: string;
    postId?: string;
    views?: number;
    likes?: number;
    comments?: number;
    shares?: number;
    favorites?: number;
  }): Promise<{ id: string }> {
    const scope = await this.workspaceContext.current();
    const saved = await this.upsertSnapshot({
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      platform: input.platform,
      socialAccountId: input.socialAccountId ?? null,
      platformPostId: input.postId ?? null,
      contentId: input.contentId ?? null,
      capturedAt: new Date(),
      views: input.views ?? 0,
      likes: input.likes ?? 0,
      comments: input.comments ?? 0,
      shares: input.shares ?? 0,
      favorites: input.favorites ?? 0,
      extra: { source: 'browser-extension' },
    });
    return { id: saved.id };
  }

  /** Front-end beacons (page views, button clicks) land here. */
  async track(input: {
    eventName: string;
    platform?: PlatformCode;
    contentId?: string;
    sessionId?: string;
    properties?: Record<string, unknown>;
  }): Promise<{ id: string }> {
    const scope = await this.workspaceContext.current();
    const saved = await this.events.save(
      this.events.create({
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        eventName: input.eventName,
        platform: input.platform ?? null,
        contentId: input.contentId ?? null,
        contentVariantId: null,
        socialAccountId: null,
        sessionId: input.sessionId ?? null,
        occurredAt: new Date(),
        properties: input.properties ?? {},
      }),
    );
    return { id: saved.id };
  }

  private dayKey(date: Date): string {
    // Local day, matching what operators see in the UI.
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }
}
