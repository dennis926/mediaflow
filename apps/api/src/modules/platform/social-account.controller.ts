import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { IsIn, IsISO8601, IsObject, IsOptional, IsString, Length } from 'class-validator';
import { PlatformCode } from '@mediaflow/shared';
import { toActor } from '../auth/actor.util';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { Capability } from '../auth/capabilities';
import { AccountView, SocialAccountService } from './social-account.service';

class BindAccountDto {
  @IsIn(Object.values(PlatformCode))
  platform!: PlatformCode;

  @IsString()
  @Length(1, 120)
  accountName!: string;

  @IsString()
  @Length(1, 160)
  platformAccountId!: string;

  @IsOptional()
  @IsString()
  @Length(1, 512)
  avatarUrl?: string;

  @IsOptional()
  @IsString()
  @Length(1, 1024)
  accessToken?: string;

  @IsOptional()
  @IsString()
  @Length(1, 1024)
  refreshToken?: string;

  @IsOptional()
  @IsISO8601()
  tokenExpiresAt?: string;

  @IsOptional()
  @IsObject()
  extra?: Record<string, unknown>;
}

/**
 * 手动登记账号（无密钥路径）：只记元信息，不保存 token；发布走插件填充或人工回填。
 */
class RegisterManualAccountDto {
  @IsIn(Object.values(PlatformCode))
  platform!: PlatformCode;

  @IsString()
  @Length(1, 120)
  accountName!: string;

  @IsOptional()
  @IsString()
  @Length(1, 160)
  platformAccountId?: string;

  @IsOptional()
  @IsString()
  @Length(1, 512)
  homepage?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  note?: string;
}

@Controller('accounts')
export class SocialAccountController {
  constructor(private readonly accountService: SocialAccountService) {}

  @Get()
  list(@Query('platform') platform?: PlatformCode): Promise<AccountView[]> {
    return this.accountService.list(platform);
  }

  @Capability('platform.bind')
  @Post('bind')
  bind(@Body() dto: BindAccountDto, @CurrentUser() user?: AuthUser): Promise<AccountView> {
    return this.accountService.bind(dto, toActor(user));
  }

  /** 手动登记账号：没有 AppID/Secret 也能把账号录进来，发布走插件/人工。 */
  @Capability('platform.bind')
  @Post('manual')
  registerManual(@Body() dto: RegisterManualAccountDto, @CurrentUser() user?: AuthUser): Promise<AccountView> {
    return this.accountService.registerManual(dto, toActor(user));
  }

  @Capability('platform.bind')
  @Delete(':id')
  unbind(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user?: AuthUser): Promise<{ id: string }> {
    return this.accountService.unbind(id, toActor(user));
  }
}
