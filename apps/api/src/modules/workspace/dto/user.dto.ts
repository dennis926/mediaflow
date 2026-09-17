import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEmail, IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';
import { RoleCode } from '../entities/role.entity';

export const PASSWORD_RULE = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d!@#$%^&*._-]{8,72}$/;
export const PASSWORD_RULE_MESSAGE = '密码至少 8 位，且需同时包含字母和数字';

export class QueryUserDto {
  @IsOptional()
  @IsString()
  @Length(1, 100)
  keyword?: string;

  @IsOptional()
  @IsIn(['active', 'disabled'])
  status?: 'active' | 'disabled';

  @IsOptional()
  @IsIn(['owner', 'admin', 'editor', 'reviewer', 'viewer'])
  role?: RoleCode;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;
}

export class CreateUserDto {
  @IsEmail({}, { message: '邮箱格式不正确' })
  email!: string;

  @IsString()
  @Length(1, 80)
  displayName!: string;

  @IsOptional()
  @IsString()
  @Length(1, 32)
  phone?: string;

  /** 不传则生成临时密码并强制首次登录修改 */
  @IsOptional()
  @Matches(PASSWORD_RULE, { message: PASSWORD_RULE_MESSAGE })
  password?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsIn(['owner', 'admin', 'editor', 'reviewer', 'viewer'], { each: true })
  roleCodes?: RoleCode[];
}

export class InviteUserDto {
  @IsEmail({}, { message: '邮箱格式不正确' })
  email!: string;

  @IsString()
  @Length(1, 80)
  displayName!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsIn(['owner', 'admin', 'editor', 'reviewer', 'viewer'], { each: true })
  roleCodes?: RoleCode[];
}

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @Length(1, 80)
  displayName?: string;

  @IsOptional()
  @IsString()
  @Length(1, 32)
  phone?: string;

  @IsOptional()
  @IsString()
  @Length(1, 512)
  avatarUrl?: string;
}

export class UpdateUserRolesDto {
  @IsArray()
  @ArrayMaxSize(5)
  @IsIn(['owner', 'admin', 'editor', 'reviewer', 'viewer'], { each: true })
  roleCodes!: RoleCode[];
}

export class ResetPasswordDto {
  /** 不传则生成随机临时密码（推荐），返回一次并要求首次登录修改 */
  @IsOptional()
  @Matches(PASSWORD_RULE, { message: PASSWORD_RULE_MESSAGE })
  newPassword?: string;
}

export class UpdateUserStatusDto {
  @IsIn(['active', 'disabled'])
  status!: 'active' | 'disabled';
}

export class ChangePasswordDto {
  @IsString()
  @Length(1, 72)
  currentPassword!: string;

  @Matches(PASSWORD_RULE, { message: PASSWORD_RULE_MESSAGE })
  newPassword!: string;
}
