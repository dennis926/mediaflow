import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'node:crypto';
import { Repository } from 'typeorm';
import { AuditService } from '../../audit/audit.service';
import { WorkspaceContextService } from '../../common/workspace-context.service';
import {
  ChangePasswordDto,
  CreateUserDto,
  InviteUserDto,
  QueryUserDto,
  UpdateUserDto,
  UpdateUserStatusDto,
} from './dto/user.dto';
import { Role, RoleCode } from './entities/role.entity';
import { User, UserStatus } from './entities/user.entity';

export interface UserView {
  id: string;
  email: string;
  displayName: string;
  phone: string | null;
  avatarUrl: string | null;
  status: UserStatus;
  isSuperAdmin: boolean;
  mustChangePassword: boolean;
  roles: RoleCode[];
  lastLoginAt: Date | null;
  invitedBy: string | null;
  createdAt: Date;
}

export interface UserPage {
  items: UserView[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

export interface RoleView {
  code: RoleCode;
  name: string;
  description: string | null;
  permissions: string[];
  memberCount: number;
}

export interface UserActor {
  id?: string | null;
  name?: string | null;
}

const SAFE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

function generatePassword(length = 14): string {
  let password = '';
  for (let index = 0; index < length; index += 1) {
    password += SAFE_ALPHABET[randomInt(SAFE_ALPHABET.length)];
  }
  return `${password}${randomInt(10)}`; // guarantees a digit so the password rule always holds
}

/**
 * 用户与角色管理。
 *
 * 关键约束（比"能增删改查"更重要的是别把系统锁死）：
 * 1. 不能删除/禁用/降级自己；
 * 2. 不能让可用 owner 归零（最后一个超管/管理员无法被移除或停用）；
 * 3. 所有写操作记录操作人到审计日志；
 * 4. 删除是软删除（deleted_at），保留审计痕迹；
 * 5. 管理员重置密码一律生成随机临时密码并要求首次登录修改。
 */
@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Role) private readonly roles: Repository<Role>,
    private readonly audit: AuditService,
    private readonly workspaceContext: WorkspaceContextService,
  ) {}

  async list(query: QueryUserDto): Promise<UserPage> {
    const scope = await this.workspaceContext.current();
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const builder = this.users
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.roles', 'role')
      .where('user.workspaceId = :workspaceId', { workspaceId: scope.workspaceId });

    if (query.keyword) {
      builder.andWhere('(user.email ILIKE :kw OR user.displayName ILIKE :kw)', { kw: `%${query.keyword}%` });
    }
    if (query.status) builder.andWhere('user.status = :status', { status: query.status });
    if (query.role) builder.andWhere('role.code = :role', { role: query.role });

    builder.orderBy('user.createdAt', 'DESC').skip((page - 1) * pageSize).take(pageSize);
    const [users, total] = await builder.getManyAndCount();
    return { items: users.map((user) => this.toView(user)), meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) || 1 } };
  }

  async listRoles(): Promise<RoleView[]> {
    const scope = await this.workspaceContext.current();
    const roles = await this.roles.find({ where: { tenantId: scope.tenantId }, order: { code: 'ASC' } });
    const counts = await this.users
      .createQueryBuilder('user')
      .leftJoin('user.roles', 'role')
      .select('role.code', 'code')
      .addSelect('COUNT(DISTINCT user.id)', 'count')
      .where('user.workspaceId = :workspaceId AND user.status = :status', { workspaceId: scope.workspaceId, status: 'active' })
      .groupBy('role.code')
      .getRawMany<{ code: RoleCode | null; count: string }>();

    const countMap = new Map(counts.map((row) => [row.code, Number(row.count)]));
    return roles.map((role) => ({
      code: role.code,
      name: role.name,
      description: role.description,
      permissions: role.permissions,
      memberCount: countMap.get(role.code) ?? 0,
    }));
  }

  async get(id: string): Promise<UserView> {
    const scope = await this.workspaceContext.current();
    const user = await this.users.findOne({ where: { id, workspaceId: scope.workspaceId }, relations: { roles: true } });
    if (!user) throw new NotFoundException('用户不存在');
    return this.toView(user);
  }

  async create(dto: CreateUserDto, actor: UserActor): Promise<{ user: UserView; tempPassword: string | null }> {
    const scope = await this.workspaceContext.current();
    await this.assertEmailFree(dto.email, scope.workspaceId);

    const tempPassword = dto.password ? null : generatePassword();
    const plainPassword = dto.password ?? (tempPassword as string);
    const saved = await this.users.save(
      this.users.create({
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        email: dto.email.toLowerCase(),
        phone: dto.phone ?? null,
        displayName: dto.displayName,
        passwordHash: await bcrypt.hash(plainPassword, 10),
        status: 'active',
        isSuperAdmin: false,
        mustChangePassword: tempPassword !== null,
        invitedBy: actor.id ?? null,
        lastLoginAt: null,
      }),
    );
    await this.assignRoles(saved.id, dto.roleCodes?.length ? dto.roleCodes : ['editor'], scope.tenantId);

    await this.record('user.create', saved.id, actor, { email: saved.email, roleCodes: dto.roleCodes ?? ['editor'], tempPasswordIssued: tempPassword !== null });
    this.logger.log(`已创建用户：${saved.email}`);
    return { user: await this.get(saved.id), tempPassword };
  }

  async invite(dto: InviteUserDto, actor: UserActor): Promise<{ user: UserView; tempPassword: string }> {
    const scope = await this.workspaceContext.current();
    await this.assertEmailFree(dto.email, scope.workspaceId);

    const tempPassword = generatePassword();
    const saved = await this.users.save(
      this.users.create({
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        email: dto.email.toLowerCase(),
        phone: null,
        displayName: dto.displayName,
        passwordHash: await bcrypt.hash(tempPassword, 10),
        status: 'active',
        isSuperAdmin: false,
        mustChangePassword: true,
        invitedBy: actor.id ?? null,
        lastLoginAt: null,
      }),
    );
    const roleCodes = dto.roleCodes?.length ? dto.roleCodes : (['editor'] as RoleCode[]);
    await this.assignRoles(saved.id, roleCodes, scope.tenantId);
    await this.record('user.invite', saved.id, actor, { email: saved.email, roleCodes });

    this.logger.log(`已邀请用户：${saved.email}`);
    return { user: await this.get(saved.id), tempPassword };
  }

  async update(id: string, dto: UpdateUserDto, actor: UserActor): Promise<UserView> {
    const user = await this.loadUser(id);
    if (dto.displayName !== undefined) user.displayName = dto.displayName;
    if (dto.phone !== undefined) user.phone = dto.phone;
    if (dto.avatarUrl !== undefined) user.avatarUrl = dto.avatarUrl;

    await this.users.save(user);
    await this.record('user.update', user.id, actor, { fields: Object.keys(dto) });
    return this.get(user.id);
  }

  /** 软删除：保留数据行与审计痕迹，账号立即无法登录。 */
  async remove(id: string, actor: UserActor): Promise<{ id: string; deletedAt: Date }> {
    const user = await this.loadUser(id);
    await this.assertNotSelf(user, actor, '不能删除自己');
    await this.assertOwnerSurvives(user, '不能删除最后一个管理员');

    await this.users.softDelete({ id: user.id });
    await this.record('user.delete', user.id, actor, { email: user.email });
    this.logger.log(`已删除用户：${user.email}`);
    return { id: user.id, deletedAt: new Date() };
  }

  async updateRoles(id: string, roleCodes: RoleCode[], actor: UserActor): Promise<UserView> {
    const scope = await this.workspaceContext.current();
    const user = await this.loadUser(id, true);
    const unique = [...new Set(roleCodes)];
    if (unique.length === 0) throw new BadRequestException('至少保留一个角色');

    const known = await this.roles.find({ where: { tenantId: scope.tenantId } });
    const valid = new Set(known.map((role) => role.code));
    const unknown = unique.filter((code) => !valid.has(code));
    if (unknown.length > 0) throw new BadRequestException(`未知角色：${unknown.join('、')}`);

    // Removing the owner role from the last active owner would lock everybody out.
    const wasOwner = user.roles?.some((role) => role.code === 'owner') ?? false;
    if (wasOwner && !unique.includes('owner')) {
      await this.assertNotSelf(user, actor, '不能取消自己的管理员角色');
      await this.assertOwnerSurvives(user, '至少保留一个管理员角色');
    }

    await this.assignRoles(user.id, unique, scope.tenantId, true);
    await this.record('user.update_roles', user.id, actor, { roleCodes: unique, previous: user.roles?.map((role) => role.code) ?? [] });
    return this.get(user.id);
  }

  /** 重置密码：默认生成随机临时密码，并要求用户首次登录后修改。 */
  async resetPassword(id: string, actor: UserActor, newPassword?: string): Promise<{ success: true; tempPassword: string | null }> {
    const user = await this.loadUser(id);
    const tempPassword = newPassword ? null : generatePassword();
    const plain = newPassword ?? (tempPassword as string);

    await this.users.update({ id: user.id }, { passwordHash: await bcrypt.hash(plain, 10), mustChangePassword: tempPassword !== null });
    await this.record('user.reset_password', user.id, actor, { forcedChange: tempPassword !== null });
    this.logger.log(`已重置密码：${user.email}`);
    return { success: true, tempPassword };
  }

  async updateStatus(id: string, dto: UpdateUserStatusDto, actor: UserActor): Promise<UserView> {
    const user = await this.loadUser(id, true);
    if (dto.status === 'disabled') {
      await this.assertNotSelf(user, actor, '不能禁用自己');
      await this.assertOwnerSurvives(user, '不能禁用最后一个管理员');
    }
    await this.users.update({ id: user.id }, { status: dto.status });
    await this.record(dto.status === 'active' ? 'user.enable' : 'user.disable', user.id, actor, { status: dto.status });
    return this.get(user.id);
  }

  /** 用户自助修改密码（也用于首次登录强制修改）。 */
  async changeOwnPassword(userId: string, dto: ChangePasswordDto): Promise<{ success: true }> {
    const user = await this.users
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.id = :id', { id: userId })
      .getOne();
    if (!user) throw new NotFoundException('用户不存在');
    if (!(await bcrypt.compare(dto.currentPassword, user.passwordHash))) {
      throw new BadRequestException('当前密码不正确');
    }
    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException('新密码不能与当前密码相同');
    }

    await this.users.update({ id: user.id }, { passwordHash: await bcrypt.hash(dto.newPassword, 10), mustChangePassword: false });
    await this.record('user.change_password', user.id, { id: user.id, name: user.displayName }, { self: true });
    return { success: true };
  }

  private async loadUser(id: string, withRoles = false): Promise<User> {
    const scope = await this.workspaceContext.current();
    const user = await this.users.findOne({
      where: { id, workspaceId: scope.workspaceId },
      ...(withRoles ? { relations: { roles: true } } : {}),
    });
    if (!user) throw new NotFoundException('用户不存在');
    return user;
  }

  private async assertEmailFree(email: string, workspaceId: string): Promise<void> {
    const existing = await this.users.findOne({ where: { email: email.toLowerCase(), workspaceId }, withDeleted: true });
    if (existing) throw new ConflictException('该邮箱已被使用');
  }

  private async assertNotSelf(user: User, actor: UserActor, message: string): Promise<void> {
    if (actor.id && actor.id === user.id) throw new BadRequestException(message);
  }

  /** Blocks the operation when it would leave the workspace without any active owner. */
  private async assertOwnerSurvives(user: User, message: string): Promise<void> {
    const roles = user.roles ?? (await this.users.findOne({ where: { id: user.id }, relations: { roles: true } }))?.roles ?? [];
    if (!roles.some((role) => role.code === 'owner')) return;
    const activeOwners = await this.countActiveOwners();
    if (activeOwners <= 1) throw new ForbiddenException(message);
  }

  private async countActiveOwners(): Promise<number> {
    const scope = await this.workspaceContext.current();
    return this.users
      .createQueryBuilder('user')
      .leftJoin('user.roles', 'role')
      .where('user.workspaceId = :workspaceId AND user.status = :status AND role.code = :code', {
        workspaceId: scope.workspaceId,
        status: 'active',
        code: 'owner',
      })
      .getCount();
  }

  private async assignRoles(userId: string, roleCodes: RoleCode[], tenantId: string, replace = false): Promise<void> {
    if (replace) {
      await this.users.createQueryBuilder().relation(User, 'roles').of(userId).remove(
        (
          await this.users
            .createQueryBuilder('user')
            .leftJoin('user.roles', 'role')
            .select('role.id', 'roleId')
            .where('user.id = :id', { id: userId })
            .getRawMany<{ roleId: string | null }>()
        )
          .map((row) => row.roleId)
          .filter((roleId): roleId is string => Boolean(roleId)),
      );
    }

    const roles = await this.roles.find({ where: { tenantId } });
    for (const code of roleCodes) {
      const role = roles.find((item) => item.code === code);
      if (!role) continue;
      await this.users.createQueryBuilder().relation(User, 'roles').of(userId).add(role.id);
    }
  }

  private async record(action: string, userId: string, actor: UserActor, payload: Record<string, unknown>): Promise<void> {
    const scope = await this.workspaceContext.current();
    await this.audit.record({
      action,
      resourceType: 'user',
      resourceId: userId,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      actorId: actor.id ?? null,
      actorName: actor.name ?? null,
      payload,
    });
  }

  private toView(user: User): UserView {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      phone: user.phone,
      avatarUrl: user.avatarUrl,
      status: user.status,
      isSuperAdmin: user.isSuperAdmin,
      mustChangePassword: user.mustChangePassword,
      roles: user.roles?.map((role) => role.code) ?? [],
      lastLoginAt: user.lastLoginAt,
      invitedBy: user.invitedBy,
      createdAt: user.createdAt,
    };
  }
}
