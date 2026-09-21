import { Body, Controller, Get, Headers, Ip, Post } from '@nestjs/common';
import { IsOptional, IsString, Length, Matches } from 'class-validator';
import { UUID_SHAPE } from '../../common/validators/id-shape';
import { ChangePasswordDto } from '../workspace/dto/user.dto';
import { UserService } from '../workspace/user.service';
import { AuthService } from './auth.service';
import { AuthUser, CapabilitiesView, LoginResult } from './auth.types';
import { CurrentUser } from './current-user.decorator';
import { LoginDto } from './dto/login.dto';
import { Public } from './public.decorator';
import { WorkspaceLifecycle } from './workspace-lifecycle.decorator';

class SwitchWorkspaceDto {
  /**
   * 历史安装的默认工作区 ID 是种子里的固定值（variant 位不合法），
   * 严格的 @IsUUID('4') 会把它判为非法 —— 这里放宽为"UUID 形状"，
   * 新装环境用的是标准 v4（见 database/seeds/defaults.ts），两边都放行。
   */
  @Matches(UUID_SHAPE, { message: 'workspaceId 必须是合法的工作区 ID' })
  workspaceId!: string;
}

class LogoutDto {
  /** 可选：带上刷新令牌即可把它加入黑名单，避免登出后仍能被拿去换新令牌 */
  @IsOptional()
  @IsString()
  @Length(10, 2000)
  refreshToken?: string;
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

  /**
   * 切换工作区：重新签发令牌，前端刷新即可（不需要重新登录）。
   *
   * 豁免状态闸门的原因同 GET /workspaces：当前工作区被软删后，用户必须还能切到别的
   * 工作区继续工作（否则只能靠"恢复"脱身）。目标工作区的可用性在服务层重新校验。
   */
  @WorkspaceLifecycle()
  @Post('switch-workspace')
  switchWorkspace(
    @Body() dto: SwitchWorkspaceDto,
    @CurrentUser() user: AuthUser,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: string; user: AuthUser }> {
    return this.authService.switchWorkspace(user.id, dto.workspaceId);
  }

  /**
   * 登出：把刷新令牌加入黑名单（幂等，无需有效访问令牌）。
   * 前端在清除本地令牌前调用一次即可；即使调用失败也不影响本地登出。
   */
  @Public()
  @Post('logout')
  logout(
    @Body() dto: LogoutDto,
    @Ip() ip?: string,
    @Headers('user-agent') userAgent?: string,
  ): Promise<{ ok: true }> {
    return this.authService.logout(dto?.refreshToken, { ip: ip ?? null, userAgent: userAgent ?? null });
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

  /**
   * 当前用户生效的能力点（只读自己）。前端按能力点显示/隐藏按钮，避免把角色名写死在组件里。
   * 标记为生命周期豁免：当前工作区已被软删时也必须能读到（否则显示不出"恢复"入口）。
   */
  @Get('capabilities')
  @WorkspaceLifecycle()
  capabilities(@CurrentUser() user: AuthUser): Promise<CapabilitiesView> {
    return this.authService.capabilities(user);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser): Promise<AuthUser> {
    return this.authService.profile(user.id);
  }
}
