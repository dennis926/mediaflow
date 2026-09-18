import {
  Body,
  Controller,
  Delete,
  Get,
  MaxFileSizeValidator,
  Param,
  ParseFilePipe,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { Public } from '../auth/public.decorator';
import { AuthUser } from '../auth/auth.types';
import { toActor } from '../auth/actor.util';
import { Capability } from '../auth/capabilities';
import { CurrentUser } from '../auth/current-user.decorator';
import { MediaAsset } from './entities/media-asset.entity';
import { MediaPage, MediaService } from './media.service';
import { MediaService as Service } from './media.service';

/** 上传层的硬上限：真正的业务上限来自配置 MEDIA_MAX_FILE_MB，这里只防内存被打爆。 */
const UPLOAD_CEILING_BYTES = 2048 * 1024 * 1024;

interface UploadMediaDto {
  groupName?: string;
}

@Controller('media')
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  @Post()
  @Capability('content.write')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: UPLOAD_CEILING_BYTES } }))
  upload(
    @UploadedFile(new ParseFilePipe({ validators: [new MaxFileSizeValidator({ maxSize: UPLOAD_CEILING_BYTES })] }))
    file: Express.Multer.File,
    @Body() dto: UploadMediaDto,
    @CurrentUser() user?: AuthUser,
  ): Promise<MediaAsset> {
    return this.mediaService.upload(
      { originalname: file.originalname, buffer: file.buffer, size: file.size, mimetype: file.mimetype },
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
