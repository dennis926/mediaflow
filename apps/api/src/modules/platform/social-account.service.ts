import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { PlatformCode, PLATFORM_LABELS, PublishMode } from '@mediaflow/shared';
import { Repository } from 'typeorm';
import { AuditService } from '../../audit/audit.service';
import { CryptoService } from '../../common/crypto.service';
import { WorkspaceContextService } from '../../common/workspace-context.service';
import { Platform } from './entities/platform.entity';
import { SocialAccount } from './entities/social-account.entity';

export interface BindAccountInput {
  platform: PlatformCode;
  accountName: string;
  platformAccountId: string;
  avatarUrl?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: string;
  extra?: Record<string, unknown>;
}

export interface AccountView {
  id: string;
  platform: PlatformCode;
  platformName: string;
  publishMode: PublishMode;
  accountName: string;
  platformAccountId: string;
  avatarUrl: string | null;
  status: string;
  hasToken: boolean;
  tokenExpiresAt: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
}

@Injectable()
export class SocialAccountService {
  private readonly logger = new Logger(SocialAccountService.name);

  constructor(
    @InjectRepository(SocialAccount) private readonly accounts: Repository<SocialAccount>,
    @InjectRepository(Platform) private readonly platforms: Repository<Platform>,
    private readonly workspaceContext: WorkspaceContextService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
  ) {}

  async list(platform?: PlatformCode): Promise<AccountView[]> {
    const scope = await this.workspaceContext.current();
    const rows = await this.accounts
      .createQueryBuilder('account')
      .addSelect(['account.accessToken'])
      .where('account.workspaceId = :workspaceId', { workspaceId: scope.workspaceId })
      .andWhere(platform ? 'account.platformCode = :platform' : '1=1', platform ? { platform } : {})
      .orderBy('account.createdAt', 'DESC')
      .getMany();
    const platformRows = await this.platforms.find();
    return rows.map((row) => this.toView(row, platformRows));
  }

  async bind(input: BindAccountInput, actor: { id?: string | null; name?: string | null }): Promise<AccountView> {
    const scope = await this.workspaceContext.current();
    const platform = await this.platforms.findOne({ where: { code: input.platform, workspaceId: scope.workspaceId } });
    if (!platform) throw new BadRequestException(`未知平台：${input.platform}（请先执行种子数据）`);

    const existing = await this.accounts.findOne({
      where: {
        workspaceId: scope.workspaceId,
        platformId: platform.id,
        platformAccountId: input.platformAccountId,
      },
    });

    if (existing) throw new ConflictException('该平台账号已绑定，请勿重复添加');

    // Built inline: TypeORM's deep-partial helper chokes on a pre-typed jsonb variable.
    const saved = await this.accounts.save(
      this.accounts.create({
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        platformId: platform.id,
        platformCode: input.platform,
        accountName: input.accountName,
        platformAccountId: input.platformAccountId,
        avatarUrl: input.avatarUrl ?? null,
        // Tokens are encrypted at rest; the API never returns them to the browser.
        accessToken: input.accessToken ? this.crypto.encrypt(input.accessToken) : null,
        refreshToken: input.refreshToken ? this.crypto.encrypt(input.refreshToken) : null,
        tokenExpiresAt: input.tokenExpiresAt ? new Date(input.tokenExpiresAt) : null,
        status: 'active',
        boundBy: actor.id ?? null,
        extra: input.extra ?? {},
      }),
    );
    await this.audit.record({
      action: 'account.bind',
      resourceType: 'social_account',
      resourceId: saved.id,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      actorId: actor.id ?? null,
      actorName: actor.name ?? null,
      payload: { platform: input.platform, accountName: input.accountName },
    });
    this.logger.log(`已绑定账号：${input.accountName}（${input.platform}）`);
    return this.toView(saved, [platform]);
  }

  /** Used by the OAuth callback: creates or refreshes the account row for the authorized identity. */
  async bindFromOAuth(
    input: {
      platform: PlatformCode;
      accountName: string;
      platformAccountId: string;
      avatarUrl?: string;
      accessToken: string | null;
      refreshToken: string | null;
      tokenExpiresAt: Date | null;
      publishMode: PublishMode;
    },
    actor: { id?: string | null; name?: string | null },
  ): Promise<AccountView> {
    const scope = await this.workspaceContext.current();
    const platform = await this.platforms.findOne({ where: { code: input.platform, workspaceId: scope.workspaceId } });
    if (!platform) throw new BadRequestException(`未知平台：${input.platform}（请先执行种子数据）`);

    const existing = await this.accounts.findOne({
      where: { workspaceId: scope.workspaceId, platformId: platform.id, platformAccountId: input.platformAccountId },
    });

    const encryptedAccess = input.accessToken ? this.crypto.encrypt(input.accessToken) : null;
    const encryptedRefresh = input.refreshToken ? this.crypto.encrypt(input.refreshToken) : null;

    if (existing) {
      await this.accounts.update(
        { id: existing.id },
        {
          accountName: input.accountName,
          avatarUrl: input.avatarUrl ?? existing.avatarUrl,
          accessToken: encryptedAccess ?? existing.accessToken,
          refreshToken: encryptedRefresh ?? existing.refreshToken,
          tokenExpiresAt: input.tokenExpiresAt ?? existing.tokenExpiresAt,
          status: 'active',
          lastSyncedAt: new Date(),
        },
      );
      const refreshed = await this.accounts.findOne({ where: { id: existing.id } });
      this.logger.log(`已更新授权账号：${input.accountName}（${input.platform}）`);
      return this.toView(refreshed ?? existing, [platform]);
    }

    const saved = await this.accounts.save(
      this.accounts.create({
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        platformId: platform.id,
        platformCode: input.platform,
        accountName: input.accountName,
        platformAccountId: input.platformAccountId,
        avatarUrl: input.avatarUrl ?? null,
        accessToken: encryptedAccess,
        refreshToken: encryptedRefresh,
        tokenExpiresAt: input.tokenExpiresAt,
        status: 'active',
        boundBy: actor.id ?? null,
        extra: {},
      }),
    );
    return this.toView(saved, [platform]);
  }

  /** Decrypted credentials for the runtime (publish / analytics / refresh). Never exposed via API. */
  async credentialsOf(accountId: string): Promise<{ accessToken: string | null; refreshToken: string | null; expiresAt: Date | null; extra: Record<string, unknown> }> {
    const account = await this.accounts
      .createQueryBuilder('account')
      .addSelect(['account.accessToken', 'account.refreshToken'])
      .where('account.id = :id', { id: accountId })
      .getOne();
    if (!account) throw new NotFoundException('平台账号不存在');
    return {
      accessToken: this.crypto.decrypt(account.accessToken),
      refreshToken: this.crypto.decrypt(account.refreshToken),
      expiresAt: account.tokenExpiresAt,
      extra: account.extra ?? {},
    };
  }

  /** Accounts whose token expires soon, used by the refresh scheduler. */
  async expiringAccounts(
    withinMinutes = 30,
  ): Promise<
    Array<{ id: string; platform: PlatformCode; accountName: string; tokenExpiresAt: Date | null; extra: Record<string, unknown> }>
  > {
    const scope = await this.workspaceContext.current();
    const threshold = new Date(Date.now() + withinMinutes * 60 * 1000);
    const rows = await this.accounts
      .createQueryBuilder('account')
      .addSelect(['account.refreshToken'])
      .where('account.workspaceId = :workspaceId', { workspaceId: scope.workspaceId })
      .andWhere('account.refreshToken IS NOT NULL')
      .andWhere('account.tokenExpiresAt IS NOT NULL')
      .andWhere('account.tokenExpiresAt <= :threshold', { threshold })
      .getMany();
    return rows.map((row) => ({
      id: row.id,
      platform: row.platformCode,
      accountName: row.accountName,
      tokenExpiresAt: row.tokenExpiresAt,
      extra: row.extra ?? {},
    }));
  }

  /** 标记"令牌刷新失败"：状态置为 expired 并在 extra 记时间，供列表中警示与去重提醒。 */
  async markTokenProblem(accountId: string, reason: string): Promise<void> {
    const account = await this.accounts.findOne({ where: { id: accountId } });
    if (!account) return;
    await this.accounts.update(
      { id: accountId },
      {
        status: 'expired',
        extra: { ...(account.extra ?? {}), refreshFailedAt: new Date().toISOString(), refreshFailedReason: reason },
      },
    );
  }

  /** 记录"即将到期"提醒时间（不改状态，仅用于去重）。 */
  async markTokenWarning(accountId: string, note: string): Promise<void> {
    const account = await this.accounts.findOne({ where: { id: accountId } });
    if (!account) return;
    await this.accounts.update(
      { id: accountId },
      { extra: { ...(account.extra ?? {}), expiryNotifiedAt: new Date().toISOString(), expiryNote: note } },
    );
  }

  async saveRefreshedTokens(accountId: string, tokens: { accessToken?: string; refreshToken?: string; expiresAt?: string }): Promise<void> {
    await this.accounts.update(
      { id: accountId },
      {
        accessToken: tokens.accessToken ? this.crypto.encrypt(tokens.accessToken) : undefined,
        refreshToken: tokens.refreshToken ? this.crypto.encrypt(tokens.refreshToken) : undefined,
        tokenExpiresAt: tokens.expiresAt ? new Date(tokens.expiresAt) : undefined,
        lastSyncedAt: new Date(),
      },
    );
  }

  async unbind(id: string, actor: { id?: string | null; name?: string | null }): Promise<{ id: string }> {
    const scope = await this.workspaceContext.current();
    const account = await this.accounts.findOne({ where: { id, workspaceId: scope.workspaceId } });
    if (!account) throw new NotFoundException('账号不存在');
    await this.accounts.delete({ id: account.id });
    await this.audit.record({
      action: 'account.unbind',
      resourceType: 'social_account',
      resourceId: account.id,
      tenantId: account.tenantId,
      workspaceId: account.workspaceId,
      actorId: actor.id ?? null,
      actorName: actor.name ?? null,
      payload: { platform: account.platformCode, accountName: account.accountName },
    });
    return { id: account.id };
  }

  private toView(account: SocialAccount, platforms: Platform[]): AccountView {
    const platform = platforms.find((item) => item.id === account.platformId);
    return {
      id: account.id,
      platform: account.platformCode,
      platformName: platform?.name ?? PLATFORM_LABELS[account.platformCode] ?? account.platformCode,
      publishMode: platform?.publishMode ?? PublishMode.Plugin,
      accountName: account.accountName,
      platformAccountId: account.platformAccountId,
      avatarUrl: account.avatarUrl,
      status: account.status,
      hasToken: Boolean(account.accessToken),
      tokenExpiresAt: account.tokenExpiresAt ? account.tokenExpiresAt.toISOString() : null,
      lastSyncedAt: account.lastSyncedAt ? account.lastSyncedAt.toISOString() : null,
      createdAt: account.createdAt.toISOString(),
    };
  }
}
