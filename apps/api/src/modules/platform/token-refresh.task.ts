import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ChannelAdapterRegistry } from '@mediaflow/channel-adapters';
import { CHANNEL_REGISTRY } from '../../publish/channel-registry.provider';
import { runtime } from '../settings/runtime-config';
import { NotificationService } from '../notification/notification.service';
import { SettingsService } from '../settings/settings.service';
import { SocialAccountService } from './social-account.service';

/** Refreshes platform tokens before they expire (小红书 2h / refresh 7d, 抖音同类机制). */
@Injectable()
export class TokenRefreshTask {
  private readonly logger = new Logger(TokenRefreshTask.name);

  constructor(
    private readonly accounts: SocialAccountService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationService,
    @Inject(CHANNEL_REGISTRY) private readonly registry: ChannelAdapterRegistry,
  ) {}

  /** 授权即将到期（可配置提前天数）时提醒一次。 */
  private async warnExpiringAccounts(): Promise<void> {
    const warnDays = runtime().notify.accountExpiryWarnDays;
    if (warnDays <= 0) return;
    const soon = await this.accounts.expiringAccounts(warnDays * 24 * 60).catch(() => []);
    for (const account of soon) {
      if (!account.tokenExpiresAt) continue;
      if (!this.shouldNotify(account.extra as Record<string, unknown>, 'expiry')) continue;
      const days = Math.max(0, Math.round((new Date(account.tokenExpiresAt).getTime() - Date.now()) / 86_400_000));
      await this.accounts.markTokenWarning(account.id, `授权将在 ${days} 天后到期`).catch(() => undefined);
      await this.notifications.notify({
        type: 'account.expiring',
        level: 'warning',
        title: `平台账号授权即将到期：${account.accountName}`,
        body: `账号「${account.accountName}」（${account.platform}）的授权将在约 ${days} 天后到期，请提前重新授权，避免发布中断。`,
        resourceType: 'social_account',
        resourceId: account.id,
        payload: { platform: account.platform, days },
      });
    }
  }

  /** 每天最多提醒一次，避免 30 分钟一次的任务把通知刷屏。 */
  private shouldNotify(extra: Record<string, unknown> | undefined, key: string): boolean {
    const last = extra?.[`${key}NotifiedAt`];
    if (typeof last !== 'string') return true;
    return Date.now() - new Date(last).getTime() > 86_400_000;
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  async refreshExpiringTokens(): Promise<void> {
    await this.warnExpiringAccounts();

    const candidates = await this.accounts.expiringAccounts(30).catch(() => []);
    if (candidates.length === 0) return;

    for (const candidate of candidates) {
      try {
        const stored = await this.accounts.credentialsOf(candidate.id);
        if (!stored.refreshToken) continue;
        const adapter = this.registry.get(candidate.platform);
        const refreshed = await adapter.refreshToken({
          appId: (await this.settings.get('DOUYIN_CLIENT_KEY')) ?? '',
          appSecret: (await this.settings.get('DOUYIN_CLIENT_SECRET')) ?? '',
          accessToken: stored.accessToken ?? undefined,
          refreshToken: stored.refreshToken,
        });
        await this.accounts.saveRefreshedTokens(candidate.id, {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          expiresAt: refreshed.expiresAt,
        });
        this.logger.log(`已刷新账号令牌：${candidate.id}（${candidate.platform}）`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`刷新令牌失败：${candidate.id}（${candidate.platform}）— ${message}`);
        // 掉线要让人知道：站内通知 + 已配置的群机器人/邮件
        if (this.shouldNotify(candidate.extra as Record<string, unknown>, 'refreshFailed')) {
          await this.accounts.markTokenProblem(candidate.id, message).catch(() => undefined);
          await this.notifications.notify({
            type: 'account.token_failed',
            level: 'error',
            title: `平台账号授权失效：${candidate.accountName}`,
            body: `账号「${candidate.accountName}」（${candidate.platform}）的令牌刷新失败：${message}。请到「账号管理」重新授权绑定，否则该平台的发布任务会一直失败。`,
            resourceType: 'social_account',
            resourceId: candidate.id,
            payload: { platform: candidate.platform, accountName: candidate.accountName },
          });
        }
      }
    }
  }
}
