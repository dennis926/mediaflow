import { Controller, Get, Header, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/auth.types';
import { MeService } from './me.service';

/** 个人数据导出（B0.6）：任何登录用户都可以导出**自己的**数据，不需要额外能力点。 */
@Controller('me')
export class MeController {
  constructor(private readonly me: MeService) {}

  @Get('export')
  @Header('Content-Type', 'application/zip')
  async exportMe(@CurrentUser() user: AuthUser, @Res() response: Response): Promise<void> {
    const { buffer, fileName } = await this.me.exportMe(user.id);
    response.setHeader('Content-Length', String(buffer.length));
    response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    response.end(buffer);
  }
}
