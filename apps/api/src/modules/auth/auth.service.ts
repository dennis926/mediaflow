import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';
import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import Redis from 'ioredis';
import { AuditService } from '../../audit/audit.service';
import { REDIS_CLIENT } from '../../redis/redis.constants';
import { RoleCode } from '../workspace/entities/role.entity';
import { User } from '../workspace/entities/user.entity';
import { runtime } from '../settings/runtime-config';
import { WorkspaceService } from '../workspace/workspace.service';
import { AuthUser, LoginResult, RefreshTokenPayload } from './auth.types';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly jwtService: JwtService,
    private readonly audit: AuditService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly workspaces: WorkspaceService,
  ) {}

  private static readonly MAX_FAILURES = 5;
  private static readonly LOCK_SECONDS = 15 * 60;

  private failureKey(email: string): string {
    return `auth:fail:${email.toLowerCase()}`;
  }

  /** 连续失败锁定，避免密码被暴力破解（此前无任何限流）。 */
  private async assertNotLocked(email: string): Promise<void> {
    const raw = await this.redis.get(this.failureKey(email)).catch(() => null);
    const failures = Number(raw ?? 0);
    if (failures >= AuthService.MAX_FAILURES) {
      const ttl = await this.redis.ttl(this.failureKey(email)).catch(() => 0);
      throw new UnauthorizedException(`连续登录失败次数过多，请 ${Math.max(Math.ceil(ttl / 60), 1)} 分钟后再试`);
    }
  }

  private async recordFailure(email: string): Promise<void> {
    const key = this.failureKey(email);
    await this.redis
      .multi()
      .incr(key)
      .expire(key, AuthService.LOCK_SECONDS)
      .exec()
      .catch(() => undefined);
  }

  /** 签发访问令牌与刷新令牌；有效期都来自配置（设置 → 角色与权限）。 */
  private async issueTokens(user: AuthUser): Promise<{ accessToken: string; refreshToken: string; expiresIn: string }> {
    const { accessExpires, refreshExpires } = runtime().auth;
    const accessToken = await this.jwtService.signAsync(
      {
        sub: user.id,
        email: user.email,
        displayName: user.displayName,
        tenantId: user.tenantId,
        workspaceId: user.workspaceId,
        roles: user.roles,
        isSuperAdmin: user.isSuperAdmin,
      },
      { expiresIn: accessExpires as unknown as number },
    );
    const refreshToken = await this.jwtService.signAsync(
      { sub: user.id, type: 'refresh' } satisfies RefreshTokenPayload,
      { expiresIn: refreshExpires as unknown as number },
    );
    return { accessToken, refreshToken, expiresIn: accessExpires };
  }

  /**
   * 用刷新令牌换新令牌：用户在这段时间内打开系统不必重新登录。
   * 每次都重新读库，账号被禁用/角色被改会立即生效，避免旧令牌无限续命。
   */
  async refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string; expiresIn: string }> {
    let payload: RefreshTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<RefreshTokenPayload>(refreshToken);
    } catch {
      throw new UnauthorizedException('登录状态已过期，请重新登录');
    }
    if (payload.type !== 'refresh') throw new UnauthorizedException('令牌类型不正确，请重新登录');

    const user = await this.users.findOne({ where: { id: payload.sub } });
    if (!user) throw new UnauthorizedException('账号不存在，请重新登录');
    if (user.status !== 'active') throw new UnauthorizedException('账号已被禁用，请联系管理员');

    const roles = await this.roleCodesOf(user.id);
    const authUser: AuthUser = {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      tenantId: user.tenantId,
      workspaceId: user.workspaceId,
      roles,
      isSuperAdmin: user.isSuperAdmin,
      mustChangePassword: user.mustChangePassword,
    };
    return this.issueTokens(authUser);
  }

  async login(email: string, password: string, meta: { ip?: string | null; userAgent?: string | null }): Promise<LoginResult> {
    await this.assertNotLocked(email);
    const user = await this.users
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('LOWER(user.email) = LOWER(:email)', { email })
      .getOne();

    // Same error for unknown account and wrong password: no account enumeration.
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      await this.recordFailure(email);
      this.logger.warn(`登录失败：${email}`);
      throw new UnauthorizedException('邮箱或密码不正确');
    }
    await this.redis.del(this.failureKey(email)).catch(() => undefined);
    if (user.status !== 'active') throw new UnauthorizedException('账号已被禁用，请联系管理员');

    await this.users.update({ id: user.id }, { lastLoginAt: new Date() });
    const roles = await this.roleCodesOf(user.id);
    const authUser: AuthUser = {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      tenantId: user.tenantId,
      workspaceId: user.workspaceId,
      roles,
      isSuperAdmin: user.isSuperAdmin,
      mustChangePassword: user.mustChangePassword,
    };

    const { accessToken, refreshToken, expiresIn } = await this.issueTokens(authUser);

    await this.audit.record({
      action: 'auth.login',
      resourceType: 'user',
      resourceId: user.id,
      tenantId: user.tenantId,
      workspaceId: user.workspaceId,
      actorId: user.id,
      actorName: user.displayName,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      payload: { email: user.email },
    });

    this.logger.log(`登录成功：${user.email}`);
    return { accessToken, refreshToken, expiresIn, user: authUser };
  }

  /**
   * 切换工作区：校验成员身份后重新签发令牌（工作区与角色都写进令牌）。
   * 前端拿到新令牌后刷新页面即可，不需要重新登录。
   */
  async switchWorkspace(
    userId: string,
    workspaceId: string,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: string; user: AuthUser }> {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('账号不存在');
    if (user.status !== 'active') throw new UnauthorizedException('账号已被禁用，请联系管理员');

    const membership = await this.workspaces.membership(userId, workspaceId);
    const roles = (membership.roleCodes.length > 0 ? membership.roleCodes : await this.roleCodesOf(userId)) as RoleCode[];

    const authUser: AuthUser = {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      tenantId: membership.workspace.tenantId,
      workspaceId: membership.workspace.id,
      roles,
      isSuperAdmin: user.isSuperAdmin,
      mustChangePassword: user.mustChangePassword,
    };
    const tokens = await this.issueTokens(authUser);

    await this.audit.record({
      action: 'auth.switch_workspace',
      resourceType: 'workspace',
      resourceId: workspaceId,
      tenantId: membership.workspace.tenantId,
      workspaceId,
      actorId: user.id,
      actorName: user.displayName,
      payload: { workspaceName: membership.workspace.name, roles },
    });
    return { ...tokens, user: authUser };
  }

  async profile(userId: string): Promise<AuthUser> {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('账号不存在');
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      tenantId: user.tenantId,
      workspaceId: user.workspaceId,
      roles: await this.roleCodesOf(user.id),
      isSuperAdmin: user.isSuperAdmin,
      mustChangePassword: user.mustChangePassword,
    };
  }

  private async roleCodesOf(userId: string): Promise<RoleCode[]> {
    const rows = await this.users
      .createQueryBuilder('user')
      .leftJoin('user.roles', 'role')
      .select('role.code', 'code')
      .where('user.id = :userId', { userId })
      .getRawMany<{ code: RoleCode | null }>();
    return rows.map((row) => row.code).filter((code): code is RoleCode => Boolean(code));
  }
}
