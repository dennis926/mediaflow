import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';
import { AuditService } from '../../audit/audit.service';
import { RoleCode } from '../workspace/entities/role.entity';
import { User } from '../workspace/entities/user.entity';
import { AuthUser, LoginResult } from './auth.types';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  async login(email: string, password: string, meta: { ip?: string | null; userAgent?: string | null }): Promise<LoginResult> {
    const user = await this.users
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('LOWER(user.email) = LOWER(:email)', { email })
      .getOne();

    // Same error for unknown account and wrong password: no account enumeration.
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      this.logger.warn(`登录失败：${email}`);
      throw new UnauthorizedException('邮箱或密码不正确');
    }
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

    const expiresIn = this.config.get<string>('JWT_ACCESS_EXPIRES') ?? '2h';
    const accessToken = await this.jwtService.signAsync(
      {
        sub: user.id,
        email: user.email,
        displayName: user.displayName,
        tenantId: user.tenantId,
        workspaceId: user.workspaceId,
        roles,
        isSuperAdmin: user.isSuperAdmin,
      },
      { expiresIn: expiresIn as unknown as number },
    );

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
    return { accessToken, expiresIn, user: authUser };
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
