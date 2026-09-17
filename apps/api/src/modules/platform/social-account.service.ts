import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { PlatformCode, PLATFORM_LABELS, PublishMode } from '@mediaflow/shared';
import { Repository } from 'typeorm';
import { AuditService } from '../../audit/audit.service';
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
        accessToken: input.accessToken ?? null,
        refreshToken: input.refreshToken ?? null,
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
