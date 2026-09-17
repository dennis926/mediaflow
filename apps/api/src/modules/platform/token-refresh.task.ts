import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ChannelAdapterRegistry } from '@mediaflow/channel-adapters';
import { CHANNEL_REGISTRY } from '../../publish/channel-registry.provider';
import { SettingsService } from '../settings/settings.service';
import { SocialAccountService } from './social-account.service';

/** Refreshes platform tokens before they expire (小红书 2h / refresh 7d, 抖音同类机制). */
@Injectable()
export class TokenRefreshTask {
  private readonly logger = new Logger(TokenRefreshTask.name);

  constructor(
    private readonly accounts: SocialAccountService,
    private readonly settings: SettingsService,
    @Inject(CHANNEL_REGISTRY) private readonly registry: ChannelAdapterRegistry,
  ) {}

  @Cron(CronExpression.EVERY_30_MINUTES)
  async refreshExpiringTokens(): Promise<void> {
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
        this.logger.warn(
          `刷新令牌失败：${candidate.id}（${candidate.platform}）— ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
