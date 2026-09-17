import { Body, Controller, Get, Headers, Ip, Post } from '@nestjs/common';
import { ChangePasswordDto } from '../workspace/dto/user.dto';
import { UserService } from '../workspace/user.service';
import { AuthService } from './auth.service';
import { AuthUser, LoginResult } from './auth.types';
import { CurrentUser } from './current-user.decorator';
import { LoginDto } from './dto/login.dto';
import { Public } from './public.decorator';

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
