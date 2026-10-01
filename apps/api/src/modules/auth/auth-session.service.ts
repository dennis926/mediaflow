import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import Redis from 'ioredis';
import { Repository } from 'typeorm';
import { REDIS_CLIENT } from '../../redis/redis.constants';
import { AuditService } from '../../audit/audit.service';
import { RoleCode } from '../workspace/entities/role.entity';
import { User } from '../workspace/entities/user.entity';
import { WorkspaceMember } from '../workspace/entities/workspace-member.entity';
import { Workspace, WorkspaceStatus } from '../workspace/entities/workspace.entity';

export interface AuthSessionSnapshot {
  /** 用户当前是否 active（停用后其未过期令牌必须立即失效） */
  active: boolean;
  /** 是否仍是该工作区成员（被移出后其令牌不得再读写该工作区） */
  member: boolean;
  /** 数据库里的权威角色（与令牌不一致时以它为准） */
  roles: RoleCode[];
  /** 用户行是否还存在（软删除后为 false） */
  exists: boolean;
  /**
   * 工作区生命周期状态（B0.4）。工作区行已不存在（被永久清除）时按 soft_deleted 处理，
   * 守卫据此对非生命周期接口返回 404。
   */
  workspaceStatus: WorkspaceStatus;
  /**
   * 是否持有未修改的临时密码（管理员重置/邀请生成）。守卫据此强制先改密（P1-4）。
   * 老缓存条目没有该字段 → 按 false 处理，最坏情况只是这一轮不拦截，30 秒后自动纠正。
   */
  mustChangePassword?: boolean;
}

/**
 * 把"令牌声明"与"数据库现状"对齐。
 *
 * 背景（审计 P1-2）：JWT 只校验签名，停用/降权/移出工作区后旧令牌在有效期内（默认 2h）
 * 仍然可用。这里在每次请求时校验用户状态、成员关系与角色，并用 Redis 缓存 30 秒降低开销；
 * 任何权限变更路径都会主动删除缓存，使变更"下一个请求即生效"。
 *
 * 缓存 key：`auth:user:{userId}:{workspaceId}`（同一用户在不同工作区的角色不同，必须分开）
 */
@Injectable()
export class AuthSessionService {
  private readonly logger = new Logger(AuthSessionService.name);
  private static readonly TTL_SECONDS = 30;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(WorkspaceMember) private readonly members: Repository<WorkspaceMember>,
    @InjectRepository(Workspace) private readonly workspaces: Repository<Workspace>,
    private readonly audit: AuditService,
  ) {}

  private cacheKey(userId: string, workspaceId: string): string {
    return `auth:user:${userId}:${workspaceId}`;
  }

  /** 读取会话快照（缓存优先）。用户不存在返回 null。 */
  async resolve(userId: string, workspaceId: string): Promise<AuthSessionSnapshot | null> {
    const key = this.cacheKey(userId, workspaceId);
    const cached = await this.redis.get(key).catch(() => null);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as AuthSessionSnapshot;
        return parsed.exists ? parsed : null;
      } catch {
        await this.redis.del(key).catch(() => undefined);
      }
    }

    const snapshot = await this.load(userId, workspaceId);
    await this.redis
      .set(key, JSON.stringify(snapshot), 'EX', AuthSessionService.TTL_SECONDS)
      .catch(() => undefined);
    return snapshot.exists ? snapshot : null;
  }

  private async load(userId: string, workspaceId: string): Promise<AuthSessionSnapshot> {
    const user = await this.users.findOne({ where: { id: userId }, relations: { roles: true } });  // tenant-scope-ok: 会话快照按 userId 读用户，登录阶段尚无工作区作用域
    if (!user) {
      this.logger.warn(`令牌指向的用户不存在（可能已被删除）：${userId}`);
      return { active: false, member: false, roles: [], exists: false, workspaceStatus: 'soft_deleted' };
    }
    const member = await this.members.findOne({ where: { userId, workspaceId } });
    const workspace = await this.workspaces.findOne({ where: { id: workspaceId } });
    const memberRoles = (member?.roleCodes ?? []) as RoleCode[];
    return {
      active: user.status === 'active',
      member: Boolean(member),
      roles: memberRoles.length > 0 ? memberRoles : (user.roles?.map((role) => role.code) ?? []),
      exists: true,
      // 工作区行不存在 = 已被永久清除：对业务接口等同"已软删"（404）
      workspaceStatus: (workspace?.status ?? 'soft_deleted') as WorkspaceStatus,
      mustChangePassword: user.mustChangePassword,
    };
  }

  /**
   * 使某用户的全部会话快照缓存失效（所有工作区）。
   * 必须在停用/启用/改角色/删除用户/成员增删改之后调用。
   */
  async invalidate(userId: string): Promise<number> {
    const removed = await this.deleteByPattern(`auth:user:${userId}:*`);
    if (removed > 0) this.logger.debug(`已失效 ${removed} 条会话缓存：${userId}`);
    return removed;
  }

  /**
   * 使某个工作区的**全部成员**会话缓存失效（B0.4：归档/软删/恢复/永久清除时必须调用）。
   * 与按用户失效同一模式，用 SCAN 而不是 KEYS，避免在缓存量大时阻塞 Redis。
   */
  async invalidateWorkspace(workspaceId: string): Promise<number> {
    const removed = await this.deleteByPattern(`auth:user:*:${workspaceId}`);
    if (removed > 0) this.logger.debug(`已失效 ${removed} 条工作区会话缓存：${workspaceId}`);
    return removed;
  }

  private async deleteByPattern(pattern: string): Promise<number> {
    let removed = 0;
    try {
      let cursor = '0';
      do {
        const [next, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = next;
        if (keys.length > 0) {
          removed += await this.redis.del(...keys);
        }
      } while (cursor !== '0');
    } catch (error) {
      this.logger.warn(`清理会话缓存失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return removed;
  }

  /** 记录"令牌角色与数据库不一致"（降权后仍持旧令牌的情况）。 */
  async recordRoleDrift(
    user: { id: string; name?: string | null },
    tenantId: string,
    workspaceId: string,
    tokenRoles: RoleCode[],
    dbRoles: RoleCode[],
  ): Promise<void> {
    await this.audit.record({
      action: 'auth.role_drift',
      resourceType: 'user',
      resourceId: user.id,
      tenantId,
      workspaceId,
      actorId: user.id,
      actorName: user.name ?? null,
      payload: { tokenRoles, dbRoles },
    });
  }
}
