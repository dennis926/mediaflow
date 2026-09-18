import { Body, Controller, Get, Headers, Ip, Post } from '@nestjs/common';
import { IsString, IsUUID, Length } from 'class-validator';
import { ChangePasswordDto } from '../workspace/dto/user.dto';
import { UserService } from '../workspace/user.service';
import { AuthService } from './auth.service';
import { AuthUser, LoginResult } from './auth.types';
import { CurrentUser } from './current-user.decorator';
import { LoginDto } from './dto/login.dto';
import { Public } from './public.decorator';

class SwitchWorkspaceDto {
  @IsUUID('4')
  workspaceId!: string;
}

class RefreshDto {
  @IsString()
  @Length(10, 2000)
  refreshToken!: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly userService: UserService,
  ) {}

  @Public()
  @Post('login')
  login(@Body() dto: LoginDto, @Ip() ip: string, @Headers('user-agent') userAgent?: string): Promise<LoginResult> {
    return this.authService.login(dto.email, dto.password, { ip, userAgent: userAgent ?? null });
  }

  /** 切换工作区：重新签发令牌，前端刷新即可（不需要重新登录） */
  @Post('switch-workspace')
  switchWorkspace(
    @Body() dto: SwitchWorkspaceDto,
    @CurrentUser() user: AuthUser,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: string; user: AuthUser }> {
    return this.authService.switchWorkspace(user.id, dto.workspaceId);
  }

  /** 用刷新令牌续期：免登录时长见配置 AUTH_REFRESH_EXPIRES（默认 7 天）。 */
  @Public()
  @Post('refresh')
  refresh(@Body() dto: RefreshDto): Promise<{ accessToken: string; refreshToken: string; expiresIn: string }> {
    return this.authService.refresh(dto.refreshToken);
  }

  /** 修改自己的密码（也用于首次登录的强制修改） */
  @Post('change-password')
  changePassword(@Body() dto: ChangePasswordDto, @CurrentUser() user: AuthUser): Promise<{ success: true }> {
    return this.userService.changeOwnPassword(user.id, dto);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser): Promise<AuthUser> {
    return this.authService.profile(user.id);
  }
}
