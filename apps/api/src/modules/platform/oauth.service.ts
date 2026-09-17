import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelAdapterRegistry, AdapterProfile } from '@mediaflow/channel-adapters';
import { PLATFORM_LABELS, PlatformCode, PublishMode } from '@mediaflow/shared';
import Redis from 'ioredis';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../../audit/audit.service';
import { CryptoService } from '../../common/crypto.service';
import { WorkspaceContextService } from '../../common/workspace-context.service';
import { CHANNEL_REGISTRY } from '../../publish/channel-registry.provider';
import { REDIS_CLIENT } from '../../redis/redis.constants';
import { SettingsService } from '../settings/settings.service';
import { SocialAccountService } from './social-account.service';

export interface AuthorizeResult {
  platform: PlatformCode;
  authorizeUrl: string;
  state: string;
  /** Domains to register in the platform console. */
  redirectUri: string;
}

export interface CallbackResult {
  platform: PlatformCode;
  accountId: string;
  accountName: string;
  ok: boolean;
}

const STATE_PREFIX = 'oauth:state:';
const STATE_TTL_SECONDS = 600;

/** Which env setting holds the platform app id. */
const APP_ID_SETTING: Record<string, string> = {
  [PlatformCode.WechatMp]: 'WECHAT_MP_APP_ID',
  [PlatformCode.WechatVideo]: 'WECHAT_MP_APP_ID',
  [PlatformCode.Douyin]: 'DOUYIN_CLIENT_KEY',
  [PlatformCode.Xiaohongshu]: 'XIAOHONGSHU_APP_ID',
};

const APP_SECRET_SETTING: Record<string, string> = {
  [PlatformCode.WechatMp]: 'WECHAT_MP_APP_SECRET',
  [PlatformCode.WechatVideo]: 'WECHAT_MP_APP_SECRET',
  [PlatformCode.Douyin]: 'DOUYIN_CLIENT_SECRET',
  [PlatformCode.Xiaohongshu]: 'XIAOHONGSHU_APP_SECRET',
};

/**
 * OAuth binding flow: the operator authorizes on the platform, we exchange the code for a token
 * and store it encrypted. The authorize step is protected by a one-off state value kept in Redis.
 */
@Injectable()
export class OAuthService {
  private readonly logger = new Logger(OAuthService.name);

  constructor(
    @Inject(CHANNEL_REGISTRY) private readonly registry: ChannelAdapterRegistry,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly settings: SettingsService,
    private readonly accounts: SocialAccountService,
    private readonly crypto: CryptoService,
    private readonly workspaceContext: WorkspaceContextService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  /** Public base URL used to build the callback address; must match what is registered on the platform. */
  get callbackBase(): string {
    return (this.config.get<string>('OAUTH_CALLBACK_BASE') ?? 'http://127.0.0.1:4000').replace(/\/$/, '');
  }

  redirectUriFor(platform: PlatformCode): string {
    return `${this.callbackBase}/api/accounts/oauth/${platform}/callback`;
  }

  /** Front-end page to send the operator back to after the callback finishes. */
  private get webReturnUrl(): string {
    return (this.config.get<string>('WEB_URL') ?? 'http://localhost:3000').replace(/\/$/, '');
  }

  async authorize(platform: PlatformCode, actorId?: string | null): Promise<AuthorizeResult> {
    const adapter = this.registry.get(platform);
    if (!adapter.buildAuthorizeUrl) {
      throw new BadRequestException(
        `${PLATFORM_LABELS[platform] ?? platform} 不支持网页授权绑定（请使用插件或手动填写令牌）`,
      );
    }
    const appId = await this.settings.get(APP_ID_SETTING[platform] ?? '');
    if (!appId) {
      throw new BadRequestException(
        `尚未配置 ${PLATFORM_LABELS[platform] ?? platform} 的 AppID，请先到「系统设置 → 平台密钥」填写`,
      );
    }

    const state = randomBytes(16).toString('hex');
    await this.redis.set(
      `${STATE_PREFIX}${state}`,
      JSON.stringify({ platform, actorId: actorId ?? null, createdAt: new Date().toISOString() }),
      'EX',
      STATE_TTL_SECONDS,
    );

    const redirectUri = this.redirectUriFor(platform);
    return { platform, authorizeUrl: adapter.buildAuthorizeUrl(appId, redirectUri, state), state, redirectUri };
  }

  async callback(platform: PlatformCode, code: string, state: string): Promise<CallbackResult> {
    if (!code) throw new BadRequestException('缺少授权 code');
    const key = `${STATE_PREFIX}${state}`;
    const raw = await this.redis.get(key);
    if (!raw) throw new BadRequestException('授权状态已过期或无效，请重新发起授权');
    await this.redis.del(key);

    const stored = JSON.parse(raw) as { platform: PlatformCode; actorId: string | null };
    if (stored.platform !== platform) throw new BadRequestException('授权平台不匹配');

    const adapter = this.registry.get(platform);
    const appId = (await this.settings.get(APP_ID_SETTING[platform] ?? '')) ?? '';
    const appSecret = (await this.settings.get(APP_SECRET_SETTING[platform] ?? '')) ?? '';
    const credentials = await adapter.auth({ appId, appSecret, code });

    let profile: AdapterProfile;
    try {
      profile = adapter.fetchProfile
        ? await adapter.fetchProfile(credentials)
        : { platformAccountId: credentials.openId ?? appId, accountName: PLATFORM_LABELS[platform] ?? platform };
    } catch (error) {
      // Token exchange succeeded but the profile call failed: still bind with a placeholder name.
      this.logger.warn(`获取账号资料失败：${error instanceof Error ? error.message : String(error)}`);
      profile = { platformAccountId: credentials.openId ?? `${platform}-${Date.now()}`, accountName: PLATFORM_LABELS[platform] ?? platform };
    }

    const account = await this.accounts.bindFromOAuth(
      {
        platform,
        accountName: profile.accountName,
        platformAccountId: profile.platformAccountId,
        avatarUrl: profile.avatarUrl,
        accessToken: credentials.accessToken ?? null,
        refreshToken: credentials.refreshToken ?? null,
        tokenExpiresAt: credentials.expiresAt ? new Date(credentials.expiresAt) : null,
        publishMode: adapter.capabilities.mode ?? PublishMode.Plugin,
      },
      { id: stored.actorId, name: 'oauth' },
    );

    const scope = await this.workspaceContext.current();
    await this.audit.record({
      action: 'account.oauth_bind',
      resourceType: 'social_account',
      resourceId: account.id,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      actorId: stored.actorId,
      payload: { platform, accountName: profile.accountName },
    });

    this.logger.log(`授权绑定成功：${profile.accountName}（${platform}）`);
    return { platform, accountId: account.id, accountName: profile.accountName, ok: true };
  }

  /** The browser is redirected here; errors are reported back to the UI as query parameters. */
  buildReturnUrl(result: { ok: boolean; platform?: string; message?: string }): string {
    const params = new URLSearchParams({
      oauth: result.ok ? 'ok' : 'error',
      platform: result.platform ?? '',
      message: result.message ?? '',
    });
    return `${this.webReturnUrl}/accounts?${params.toString()}`;
  }

  /** Encrypts tokens at rest; the account list never returns them. */
  encryptToken(token: string | null): string | null {
    return token ? this.crypto.encrypt(token) : null;
  }

  decryptToken(token: string | null): string | null {
    return this.crypto.decrypt(token);
  }
}
