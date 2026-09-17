import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { ObjectLiteral, Repository } from 'typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../../../audit/audit.service';
import { WorkspaceContextService } from '../../../common/workspace-context.service';
import { Role } from '../entities/role.entity';
import { User } from '../entities/user.entity';
import { UserService } from '../user.service';

const WORKSPACE_ID = '22222222-2222-2222-2222-222222222222';
const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function repo<T extends ObjectLiteral>(overrides: Partial<Record<string, unknown>> = {}): Repository<T> {
  return {
    findOne: vi.fn(async () => null),
    find: vi.fn(async () => []),
    save: vi.fn(async (value: unknown) => ({ ...(value as object), id: 'saved-id' })),
    create: vi.fn((value: unknown) => value),
    update: vi.fn(async () => ({ affected: 1 })),
    softDelete: vi.fn(async () => ({ affected: 1 })),
    createQueryBuilder: vi.fn(),
    ...overrides,
  } as unknown as Repository<T>;
}

function actor(id = 'actor-1') {
  return { id, name: '操作人' };
}

function buildService(options: { ownerCount?: number; user?: Partial<User> | null } = {}) {
  const users = repo<User>();
  const roles = repo<Role>({
    find: vi.fn(async () => [
      { id: 'role-owner', code: 'owner' },
      { id: 'role-editor', code: 'editor' },
    ] as Role[]),
  });
  const queryBuilder = {
    leftJoin: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    addSelect: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    andWhere: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    relation: vi.fn().mockReturnThis(),
    of: vi.fn().mockReturnThis(),
    add: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    getRawMany: vi.fn(async () => []),
    getCount: vi.fn(async () => options.ownerCount ?? 2),
  };
  (users.createQueryBuilder as unknown as ReturnType<typeof vi.fn>).mockReturnValue(queryBuilder);
  (users.findOne as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(options.user ?? null);

  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
  const workspaceContext = {
    current: vi.fn(async () => ({ tenantId: TENANT_ID, workspaceId: WORKSPACE_ID })),
  } as unknown as WorkspaceContextService;

  return { service: new UserService(users, roles, audit, workspaceContext), users, audit, queryBuilder };
}

describe('UserService 安全边界', () => {
  it('不能删除自己', async () => {
    const me = { id: 'actor-1', email: 'me@x.com', roles: [] } as unknown as User;
    const { service } = buildService({ user: me });

    await expect(service.remove('actor-1', actor())).rejects.toBeInstanceOf(BadRequestException);
  });

  it('不能删除最后一个管理员', async () => {
    const target = { id: 'other', email: 'owner@x.com', roles: [{ code: 'owner' }] } as unknown as User;
    const { service } = buildService({ user: target, ownerCount: 1 });

    await expect(service.remove('other', actor())).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('禁用最后一个管理员会被拒绝', async () => {
    const target = { id: 'other', email: 'owner@x.com', roles: [{ code: 'owner' }] } as unknown as User;
    const { service } = buildService({ user: target, ownerCount: 1 });

    await expect(service.updateStatus('other', { status: 'disabled' }, actor())).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('不能取消自己的管理员角色', async () => {
    const me = { id: 'actor-1', email: 'me@x.com', roles: [{ code: 'owner' }] } as unknown as User;
    const { service } = buildService({ user: me });

    await expect(service.updateRoles('actor-1', ['editor'], actor())).rejects.toBeInstanceOf(BadRequestException);
  });

  it('未知角色会被拒绝，避免把用户角色清空', async () => {
    const target = { id: 'u2', email: 'u2@x.com', roles: [{ code: 'editor' }] } as unknown as User;
    const { service } = buildService({ user: target });

    await expect(service.updateRoles('u2', ['superuser' as never], actor())).rejects.toBeInstanceOf(BadRequestException);
  });

  it('邮箱重复时拒绝创建', async () => {
    const { service, users } = buildService();
    (users.findOne as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'dup' } as User);

    await expect(
      service.create({ email: 'dup@x.com', displayName: '重复' }, actor()),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('邀请用户会生成临时密码并要求首次登录修改', async () => {
    const { service, users, audit } = buildService();
    (users.findOne as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null); // email free
    (users.save as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'new-1', email: 'new@x.com', displayName: '新人' } as User);
    (users.findOne as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'new-1',
      email: 'new@x.com',
      displayName: '新人',
      roles: [{ code: 'editor' }],
      mustChangePassword: true,
    } as unknown as User);

    const result = await service.invite({ email: 'new@x.com', displayName: '新人' }, actor());

    expect(result.tempPassword).toHaveLength(15);
    expect(result.user.mustChangePassword).toBe(true);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.invite', actorId: 'actor-1' }));
  });

  it('重置密码默认返回临时密码并标记强制修改', async () => {
    const target = { id: 'u3', email: 'u3@x.com' } as unknown as User;
    const { service, users, audit } = buildService({ user: target });

    const result = await service.resetPassword('u3', actor());

    expect(result.tempPassword).toBeTruthy();
    expect(users.update).toHaveBeenCalledWith({ id: 'u3' }, expect.objectContaining({ mustChangePassword: true }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.reset_password', actorId: 'actor-1' }));
  });

  it('自助改密码：当前密码错误时拒绝', async () => {
    const user = { id: 'u4', passwordHash: '$2b$10$invalid' } as unknown as User;
    const { service, users } = buildService();
    (users.createQueryBuilder as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      addSelect: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      getOne: vi.fn(async () => user),
    });

    await expect(
      service.changeOwnPassword('u4', { currentPassword: 'WrongPass1', newPassword: 'NewPass123' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
