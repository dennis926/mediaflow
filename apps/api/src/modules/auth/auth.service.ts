import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';
import { ForbiddenException, Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import Redis from 'ioredis';
import { AuditService } from '../../audit/audit.service';
import { REDIS_CLIENT } from '../../redis/redis.constants';
import { WorkspaceContextService } from '../../common/workspace-context.service';
import { DEFAULT_TENANT_ID, DEFAULT_WORKSPACE_ID } from '../../database/seeds/defaults';
import { RoleCode } from '../workspace/entities/role.entity';
import { User } from '../workspace/entities/user.entity';
import { runtime } from '../settings/runtime-config';
import { WorkspaceService } from '../workspace/workspace.service';
import { AuthSessionService } from './auth-session.service';
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
    private readonly sessions: AuthSessionService,
    private readonly workspaceContext: WorkspaceContextService,
  ) {}

  private static readonly MAX_FAILURES = 5;
  private static readonly LOCK_SECONDS = 15 * 60;

  private failureKey(email: string): string {
    return `auth:fail:${email.toLowerCase()}`;
  }

  /**
   * 全局登录失败窗口计数（跨账号），供运行监控判断「是否有人在爆破」。
   * 窗口长度可配置（默认 5 分钟），用固定 TTL 近似滚动窗口——足够发现激增，成本却只是一个 INCR。
   */
  private static readonly FAILURE_WINDOW_KEY = 'auth:fail:window';

  private async recordFailureWindow(): Promise<void> {
    const windowSeconds = Math.max(60, runtime().monitor.loginFailWindowMinutes * 60);
    await this.redis.multi().incr(AuthService.FAILURE_WINDOW_KEY).expire(AuthService.FAILURE_WINDOW_KEY, windowSeconds).exec().catch(() => undefined);
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
      // jti 让访问令牌也可被追踪（黑名单目前只用于刷新令牌）
      { expiresIn: accessExpires as unknown as number, jwtid: randomUUID() },
    );
    const refreshToken = await this.jwtService.signAsync(
      // 带上 workspaceId：刷新时据此保持在同一个工作区，而不是被切回"默认工作区"
      { sub: user.id, type: 'refresh', workspaceId: user.workspaceId } satisfies RefreshTokenPayload,
      { expiresIn: refreshExpires as unknown as number, jwtid: randomUUID() },
    );
    return { accessToken, refreshToken, expiresIn: accessExpires };
  }

  /** 刷新令牌黑名单 key（登出、轮换后的旧令牌都会进来）。 */
  private refreshBlockKey(jti: string): string {
    return `auth:refresh:block:${jti}`;
  }

  /** 把某个刷新令牌加入黑名单，TTL = 该令牌剩余有效期（过期即自动清理）。 */
  private async blockRefreshToken(payload: RefreshTokenPayload): Promise<void> {
    if (!payload.jti) return;
    const ttl = payload.exp ? Math.max(1, payload.exp - Math.floor(Date.now() / 1000)) : 7 * 24 * 3600;
    await this.redis.set(this.refreshBlockKey(payload.jti), '1', 'EX', ttl).catch(() => undefined);
  }

  /**
   * 用刷新令牌换新令牌：用户在这段时间内打开系统不必重新登录。
   * 每次都重新读库，账号被禁用/角色被改会立即生效，避免旧令牌无限续命。
   *
   * 任务 6 起：**一次性使用** —— 每次刷新都会作废旧刷新令牌（加入黑名单），
   * 旧令牌被再次使用会返回 401（检测令牌泄露/重放的常见手段）。
   */
  async logout(refreshToken?: string, meta: { ip?: string | null; userAgent?: string | null } = {}): Promise<{ ok: true }> {
    if (refreshToken) {
      try {
        // 允许已过期的令牌也走一遍（幂等）：能解出 jti 就加入黑名单
        const payload = await this.jwtService.verifyAsync<RefreshTokenPayload>(refreshToken, { ignoreExpiration: true });
        if (payload.type === 'refresh' && payload.sub) {
          await this.blockRefreshToken(payload);
          // 审计要带真实作用域；用户已被删除时退化为占位（不能为空）
          const owner = await this.users.findOne({ where: { id: payload.sub } });
          await this.audit.record({
            action: 'auth.logout',
            resourceType: 'user',
            resourceId: payload.sub,
            tenantId: owner?.tenantId ?? payload.tenantId ?? DEFAULT_TENANT_ID,
            // 用令牌里的工作区：owner.workspaceId 在 M8 之后可能为空，且假 UUID 会写出一条指向不存在工作区的审计
            workspaceId: payload.workspaceId ?? owner?.workspaceId ?? DEFAULT_WORKSPACE_ID,
            actorId: payload.sub,
            actorName: null,
            ip: meta.ip ?? null,
            userAgent: meta.userAgent ?? null,
            payload: { jti: payload.jti ?? null, reason: '用户主动登出' },
          });
        }
      } catch {
        // 令牌非法/被篡改：无需黑名单，直接返回成功（登出必须幂等）
      }
    }
    return { ok: true };
  }

  
  async refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string; expiresIn: string }> {
    let payload: RefreshTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<RefreshTokenPayload>(refreshToken);
    } catch {
      throw new UnauthorizedException('登录状态已过期，请重新登录');
    }
    if (payload.type !== 'refresh') throw new UnauthorizedException('令牌类型不正确，请重新登录');

    // 已经被登出/轮换过的刷新令牌不能再换新令牌（一次性使用）
    if (payload.jti) {
      const blocked = await this.redis.get(this.refreshBlockKey(payload.jti)).catch(() => null);
      if (blocked) throw new UnauthorizedException('登录状态已失效（该令牌已登出或被轮换），请重新登录');
    }

    const user = await this.users.findOne({ where: { id: payload.sub } });
    if (!user) throw new UnauthorizedException('账号不存在，请重新登录');
    if (user.status !== 'active') throw new UnauthorizedException('账号已被禁用，请联系管理员');

    // 保持令牌里的工作区（若仍可用），否则按成员关系重新解析；两者都没有则拒绝刷新
    const resolution = await this.workspaces.resolveLoginWorkspace(user.id, payload.workspaceId ?? null);
    if (!resolution) throw new ForbiddenException('该账号当前没有可用的工作区，请联系管理员');
    const roles = resolution.roleCodes.length > 0 ? resolution.roleCodes : await this.roleCodesOf(user.id);
    const authUser: AuthUser = {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      tenantId: resolution.workspace.tenantId,
      workspaceId: resolution.workspace.id,
      roles,
      isSuperAdmin: user.isSuperAdmin,
      mustChangePassword: user.mustChangePassword,
    };
    // 刷新时按数据库现状重算（含角色），并让旧缓存作废
    await this.sessions.invalidate(user.id);
    // 轮换：旧刷新令牌立即作废
    await this.blockRefreshToken(payload);
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
      await this.recordFailureWindow();
      this.logger.warn(`登录失败：${email}`);
      // 失败登录必须留痕：既是「是否有人在爆破」的唯一可靠来源，也是事后追溯的证据
      // 邮箱不存在时也要能落审计：先取当前作用域，再退回默认工作区
      const scope = await this.workspaceContext
        .current()
        .then((value) => value)
        .catch(() => ({ tenantId: DEFAULT_TENANT_ID, workspaceId: DEFAULT_WORKSPACE_ID }));
      await this.audit
        .record({
          action: 'auth.login_failed',
          resourceType: 'user',
          resourceId: user?.id ?? null,
          tenantId: user?.tenantId ?? scope.tenantId,
          workspaceId: user?.workspaceId ?? scope.workspaceId,
          actorName: user?.displayName ?? null,
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
          payload: { email },
        })
        .catch((error: unknown) => {
          this.logger.warn(`记录登录失败审计出错：${error instanceof Error ? error.message : String(error)}`);
        });
      throw new UnauthorizedException('邮箱或密码不正确');
    }
    await this.redis.del(this.failureKey(email)).catch(() => undefined);
    if (user.status !== 'active') throw new UnauthorizedException('账号已被禁用，请联系管理员');

    await this.users.update({ id: user.id }, { lastLoginAt: new Date() });
    /**
     * 登录进入哪个工作区由成员关系决定（M8 之后 users.workspace_id 可能为空）：
     * 优先用户的默认工作区（若仍可用），否则第一个可用工作区；一个都没有则明确拒绝。
     */
    const resolution = await this.workspaces.resolveLoginWorkspace(user.id, user.workspaceId);
    if (!resolution) throw new ForbiddenException('该账号未被加入任何可用工作区，请联系管理员');
    const roles = resolution.roleCodes.length > 0 ? resolution.roleCodes : await this.roleCodesOf(user.id);
    const authUser: AuthUser = {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      tenantId: resolution.workspace.tenantId,
      workspaceId: resolution.workspace.id,
      roles,
      isSuperAdmin: user.isSuperAdmin,
      mustChangePassword: user.mustChangePassword,
    };

    const { accessToken, refreshToken, expiresIn } = await this.issueTokens(authUser);

    await this.audit.record({
      action: 'auth.login',
      resourceType: 'user',
      resourceId: user.id,
      tenantId: authUser.tenantId,
      workspaceId: authUser.workspaceId,
      actorId: user.id,
      actorName: user.displayName,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      payload: { email: user.email },
    });

    this.logger.log(`登录成功：${user.email}`);
    // 登录时重建：避免旧缓存里的停用/角色信息影响刚签发的令牌
    await this.sessions.invalidate(user.id);
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
    await this.sessions.invalidate(user.id);
    return { ...tokens, user: authUser };
  }

  async profile(userId: string): Promise<AuthUser> {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('账号不存在');
    // 当前工作区取自请求作用域（令牌），不再依赖 users.workspace_id（M8 后可能为空）
    const scope = await this.workspaceContext.current();
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
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
