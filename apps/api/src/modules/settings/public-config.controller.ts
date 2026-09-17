import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { runtime } from './runtime-config';

/**
 * 未登录也能读的站点信息：登录页、浏览器标题、插件弹窗都要用，
 * 但只暴露非敏感内容（不含任何密钥、不含合规词库与提示词）。
 */
@Public()
@Controller('public')
export class PublicConfigController {
  @Get('site-config')
  siteConfig(): {
    name: string;
    tagline: string;
    company: string;
    supportEmail: string;
    pageSize: number;
    aiDisclosureSuffix: string;
  } {
    const { site } = runtime();
    return site;
  }
}
