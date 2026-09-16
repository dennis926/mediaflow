import { Body, Controller, Get, Headers, Ip, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthUser, LoginResult } from './auth.types';
import { CurrentUser } from './current-user.decorator';
import { LoginDto } from './dto/login.dto';
import { Public } from './public.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  login(@Body() dto: LoginDto, @Ip() ip: string, @Headers('user-agent') userAgent?: string): Promise<LoginResult> {
    return this.authService.login(dto.email, dto.password, { ip, userAgent: userAgent ?? null });
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser): Promise<AuthUser> {
    return this.authService.profile(user.id);
  }
}
