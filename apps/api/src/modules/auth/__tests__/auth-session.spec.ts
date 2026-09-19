import { Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis';
import { AuditService } from '../../../audit/audit.service';
import { User } from '../../workspace/entities/user.entity';
import { WorkspaceMember } from '../../workspace/entities/workspace-member.entity';
import { Workspace } from '../../workspace/entities/workspace.entity';
import { AuthSessionService } from '../auth-session.service';

const USER_ID = 'u-1';
const WORKSPACE_ID = 'w-1';

function build(options: {
  cached?: string | null;
  user?: Record<string, unknown> | null;
  member?: Record<string, unknown> | null;
  workspace?: Record<string, unknown> | null;
  scanKeys?: string[];
} = {}): { service: AuthSessionService; redis: Record<string, ReturnType<typeof vi.fn>>; users: Repository<User>; members: Repository<WorkspaceMember> } {
  const redis = {
    get: vi.fn(async () => options.cached ?? null),
    set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1),
    scan: vi.fn(async () => ['0', options.scanKeys ?? [`auth:user:${USER_ID}:${WORKSPACE_ID}`]]),
  };
  const users = {
    findOne: vi.fn(async () =>
      options.user === undefined ? { id: USER_ID, status: 'active', roles: [{ code: 'editor' }] } : options.user,
    ),
  } as unknown as Repository<User>;
  const members = {
    findOne: vi.fn(async () => (options.member === undefined ? { roleCodes: ['owner'] } : options.member)),
  } as unknown as Repository<WorkspaceMember>;
  // B0.4：快照要带工作区状态，因此多注入一个 workspaces 仓库
  const workspaces = {
    findOne: vi.fn(async () => (options.workspace === undefined ? { id: WORKSPACE_ID, status: 'active' } : options.workspace)),
  } as unknown as Repository<Workspace>;
  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
  const service = new AuthSessionService(redis as unknown as Redis, users, members, workspaces, audit);
  return { service, redis, users, members };
}

describe('AuthSessionService 会话快照与失效（任务 2）', () => {
  it('缓存命中时不查库', async () => {
    const snapshot = { active: true, member: true, roles: ['owner'], exists: true };
    const { service, users, members } = build({ cached: JSON.stringify(snapshot) });

    await expect(service.resolve(USER_ID, WORKSPACE_ID)).resolves.toEqual(snapshot);
    expect(users.findOne).not.toHaveBeenCalled();
    expect(members.findOne).not.toHaveBeenCalled();
  });

  it('缓存未命中时查库并以 30 秒 TTL 写入', async () => {
    const { service, redis, users } = build();

    const snapshot = await service.resolve(USER_ID, WORKSPACE_ID);

    expect(users.findOne).toHaveBeenCalledTimes(1);
    expect(snapshot).toEqual({ active: true, member: true, roles: ['owner'], exists: true, workspaceStatus: 'active' });
    expect(redis.set).toHaveBeenCalledWith(`auth:user:${USER_ID}:${WORKSPACE_ID}`, JSON.stringify(snapshot), 'EX', 30);
  });

  it('用户被停用时快照标记 active=false（守卫据此 401）', async () => {
    const { service } = build({ user: { id: USER_ID, status: 'disabled', roles: [{ code: 'editor' }] } });

    const snapshot = await service.resolve(USER_ID, WORKSPACE_ID);

    expect(snapshot?.active).toBe(false);
  });

  it('被移出工作区时 member=false（守卫据此 404）', async () => {
    const { service } = build({ member: null });

    const snapshot = await service.resolve(USER_ID, WORKSPACE_ID);

    expect(snapshot?.member).toBe(false);
    // 成员不存在时回退到用户自身角色，便于排查
    expect(snapshot?.roles).toEqual(['editor']);
  });

  it('成员角色优先于用户全局角色（按工作区区分）', async () => {
    const { service } = build({ member: { roleCodes: ['reviewer'] } });

    await expect(service.resolve(USER_ID, WORKSPACE_ID)).resolves.toMatchObject({ roles: ['reviewer'] });
  });

  it('用户不存在时不写脏缓存，直接返回 null', async () => {
    const { service } = build({ user: null });

    await expect(service.resolve(USER_ID, WORKSPACE_ID)).resolves.toBeNull();
    expect(service).toBeDefined();
  });

  it('缓存内容损坏时忽略并回源数据库', async () => {
    const { service, users } = build({ cached: '{not-json' });

    await expect(service.resolve(USER_ID, WORKSPACE_ID)).resolves.toMatchObject({ active: true });
    expect(users.findOne).toHaveBeenCalledTimes(1);
  });

  it('invalidate 按前缀扫描并删除该用户所有工作区的快照', async () => {
    const { service, redis } = build({ scanKeys: [`auth:user:${USER_ID}:w-1`, `auth:user:${USER_ID}:w-2`] });

    const removed = await service.invalidate(USER_ID);

    expect(redis.scan).toHaveBeenCalledWith('0', 'MATCH', `auth:user:${USER_ID}:*`, 'COUNT', 100);
    expect(redis.del).toHaveBeenCalledWith(`auth:user:${USER_ID}:w-1`, `auth:user:${USER_ID}:w-2`);
    expect(removed).toBe(1);
  });

  it('Redis 故障时不抛出（降级为每次查库）', async () => {
    const { service, redis } = build();
    redis.get.mockRejectedValueOnce(new Error('connection refused'));

    await expect(service.resolve(USER_ID, WORKSPACE_ID)).resolves.toMatchObject({ active: true });
  });
});

describe('AuthSessionService 工作区状态与按工作区失效（B0.4）', () => {
  it('快照带 workspaceStatus=active（正常态）', async () => {
    const { service } = build();
    const snapshot = await service.resolve(USER_ID, WORKSPACE_ID);
    expect(snapshot?.workspaceStatus).toBe('active');
  });

  it('归档态：快照标记 archived（守卫据此拦截写操作）', async () => {
    const { service } = build({ workspace: { id: WORKSPACE_ID, status: 'archived' } });
    const snapshot = await service.resolve(USER_ID, WORKSPACE_ID);
    expect(snapshot?.workspaceStatus).toBe('archived');
  });

  it('软删态：快照标记 soft_deleted（守卫据此 404）', async () => {
    const { service } = build({ workspace: { id: WORKSPACE_ID, status: 'soft_deleted' } });
    const snapshot = await service.resolve(USER_ID, WORKSPACE_ID);
    expect(snapshot?.workspaceStatus).toBe('soft_deleted');
  });

  it('工作区行已被永久清除：按 soft_deleted 处理（不暴露"曾存在"）', async () => {
    const { service } = build({ workspace: null });
    const snapshot = await service.resolve(USER_ID, WORKSPACE_ID);
    expect(snapshot?.workspaceStatus).toBe('soft_deleted');
  });

  it('invalidateWorkspace 按 auth:user:*:{workspaceId} 扫描并删除全部成员的缓存', async () => {
    const keys = [`auth:user:u-1:${WORKSPACE_ID}`, `auth:user:u-2:${WORKSPACE_ID}`];
    const { service, redis } = build({ scanKeys: keys });

    const removed = await service.invalidateWorkspace(WORKSPACE_ID);

    expect(redis.scan).toHaveBeenCalledWith('0', 'MATCH', `auth:user:*:${WORKSPACE_ID}`, 'COUNT', 100);
    expect(redis.del).toHaveBeenCalledWith(...keys);
    expect(removed).toBe(1);
  });

  it('Redis 故障时不抛出（降级为无缓存）', async () => {
    const { service, redis } = build();
    (redis.scan as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('redis down'));
    await expect(service.invalidateWorkspace(WORKSPACE_ID)).resolves.toBe(0);
  });
});
