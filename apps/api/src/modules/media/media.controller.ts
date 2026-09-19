import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Public } from '../auth/public.decorator';
import { AuthUser } from '../auth/auth.types';
import { toActor } from '../auth/actor.util';
import { Capability } from '../auth/capabilities';
import { CurrentUser } from '../auth/current-user.decorator';
import { MediaAsset } from './entities/media-asset.entity';
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
  constructor(private readonly mediaService: Service) {}

  @Get(':storedName')
  async serve(@Param('storedName') storedName: string, @Res() response: Response): Promise<void> {
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
}
