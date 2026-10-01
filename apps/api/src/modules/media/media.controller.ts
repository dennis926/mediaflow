import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Public } from '../auth/public.decorator';
import { AuthUser } from '../auth/auth.types';
import { toActor } from '../auth/actor.util';
import { Capability } from '../auth/capabilities';
import { CurrentUser } from '../auth/current-user.decorator';
import { RateLimitService } from '../../common/rate-limit.service';
import { runtime } from '../settings/runtime-config';
import { MediaAsset } from './entities/media-asset.entity';
import { MediaLinkService } from './media-link.service';
import { MediaPage, MediaService } from './media.service';
import { MediaService as Service } from './media.service';
import { MediaUploadInterceptor } from './media-upload.interceptor';

/**
 * Multipart fields arrive as strings; validating here keeps a too-long group name from
 * reaching the database (it used to fail there with a raw "value too long for type
 * character varying(80)" 500 - both confusing for users and an internal detail leak).
 */
class UploadMediaDto {
  @IsOptional()
  @IsString()
  @MaxLength(80, { message: '分组名最长 80 个字符' })
  groupName?: string;
}

@Controller('media')
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  /**
   * 上传素材。
   *
   * 文件由 MediaUploadInterceptor 流式写到磁盘临时目录（不再整块进内存），
   * 超限由 multer 拦成 413，并发超限拦成 429；这里只负责校验 + 原子移动 + 落库。
   */
  @Post()
  @Capability('content.write')
  @UseInterceptors(MediaUploadInterceptor)
  upload(
    @UploadedFile() file: { path: string; originalname: string; mimetype: string; size: number },
    @Body() dto: UploadMediaDto,
    @CurrentUser() user?: AuthUser,
  ): Promise<MediaAsset> {
    return this.mediaService.uploadFromTemp(
      { path: file.path, originalname: file.originalname, size: file.size, mimetype: file.mimetype },
      toActor(user),
      dto.groupName,
    );
  }

  /**
   * 签发素材访问令牌：内容里嵌入的公开链接由它换成签名地址，
   * 让"链接泄漏"不再等于"文件永久公开"。ttlSeconds=0 表示签发长期链接（仍带签名可追溯）。
   */
  @Post(':id/access-token')
  @Capability('content.write')
  accessToken(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('ttlSeconds') ttlSeconds?: string,
  ): Promise<{ url: string; expiresAt: string | null }> {
    return this.mediaService.issueAccessLink(id, ttlSeconds ? Number(ttlSeconds) : 0);
  }

  @Get()
  list(@Query() query: { kind?: string; keyword?: string; group?: string; page?: number; pageSize?: number }): Promise<MediaPage> {
    return this.mediaService.list(query);
  }

  @Get('groups')
  groups(): Promise<Array<{ group: string; count: number }>> {
    return this.mediaService.groups();
  }

  @Delete(':id')
  @Capability('content.write')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user?: AuthUser): Promise<{ id: string }> {
    return this.mediaService.remove(id, toActor(user));
  }
}

/**
 * 素材对外访问：平台抓取媒体时需要能被公开访问，所以放在 public 下，
 * 但文件名是 uuid，不可枚举；也可以通过 MEDIA_PUBLIC_BASE_URL 换成 CDN。
 */
@Public()
@Controller('public/media')
export class PublicMediaController {
  constructor(
    private readonly mediaService: Service,
    private readonly links: MediaLinkService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Get(':storedName')
  async serve(
    @Param('storedName') storedName: string,
    @Req() request: Request,
    @Res() response: Response,
    @Query('exp') exp?: string,
    @Query('sig') sig?: string,
  ): Promise<void> {
    const limit = runtime().media.publicRateLimitPerMinute;
    const counted = await this.rateLimit.hit('public-media', PublicMediaController.clientIp(request), limit, 60);
    this.rateLimit.assertAllowed(counted, limit, 60, '素材访问');

    /**
     * 两种放行方式：
     * 1. 带签名（推荐，链接由后端签发，可设有效期）；
     * 2. 裸 UUID + 素材访问令牌（兼容既有内容里的老链接），令牌短时有效。
     */
    const verdict = this.links.verify(storedName, exp, sig);
    if (verdict === 'unsigned' && !this.mediaService.verifyAccessToken(storedName, request.headers['x-media-token'] as string | undefined)) {
      response.status(401).json({ code: 40100, message: '素材链接需要签名或访问令牌', data: null });
      return;
    }

    const file = await this.mediaService.openFile(storedName);
    if (!file) {
      response.status(404).json({ code: 40400, message: '素材不存在', data: null });
      return;
    }
    response.setHeader('Content-Type', file.contentType);
    response.setHeader('Content-Length', file.size);
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    file.stream.pipe(response);
  }

  /**
   * 来源 IP：main.ts 里设了 trust proxy=1，这里拿到的才是真实客户端地址。
   * 取不到时退化成固定桶（宁可全局限流，也不要完全不限）。
   */
  private static clientIp(request: Request): string {
    const forwarded = request.headers['x-forwarded-for'];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    return (first?.split(',')[0] ?? request.ip ?? 'unknown').trim();
  }
}
