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
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { toActor } from '../auth/actor.util';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { Roles } from '../auth/roles.decorator';
import {
  BatchActivateDto,
  CommitImportDto,
  CreateKnowledgeDto,
  ImportKnowledgeDto,
  PreviewKnowledgeDto,
  QueryKnowledgeDto,
  UpdateKnowledgeDto,
} from './dto/knowledge.dto';
import { MAX_DOCUMENT_BYTES } from './document-parser.service';
import { BrandKnowledge } from './entities/brand-knowledge.entity';
import { KnowledgeMatch, KnowledgePage, KnowledgeService } from './knowledge.service';

@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly knowledgeService: KnowledgeService) {}

  /** 全部登录角色都能查：写内容的人需要知道品牌口径 */
  @Get()
  list(@Query() query: QueryKnowledgeDto): Promise<KnowledgePage> {
    return this.knowledgeService.list(query);
  }

  @Get('brands')
  brands(): Promise<Array<{ brand: string; count: number }>> {
    return this.knowledgeService.brands();
  }

  /** 预览本次生成会引用哪些资料（生成前可确认） */
  @Get('preview')
  preview(@Query() query: PreviewKnowledgeDto): Promise<{ matches: KnowledgeMatch[] }> {
    return this.knowledgeService.previewForContent(query.contentId, query.platform, query.limit ?? 5);
  }

  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string): Promise<BrandKnowledge> {
    return this.knowledgeService.get(id);
  }

  /**
   * 第一步：解析文档（PDF / Word / PPT / Excel / CSV / txt / md），**不入库**。
   * 返回切片（含 OCR 来源标记）供人工校对，原文件暂存 24 小时。
   */
  @Roles('owner', 'admin', 'editor')
  @Post('parse')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_DOCUMENT_BYTES } }))
  parse(
    @UploadedFile(new ParseFilePipe({ validators: [new MaxFileSizeValidator({ maxSize: MAX_DOCUMENT_BYTES })] }))
    file: Express.Multer.File,
  ) {
    return this.knowledgeService.parseDocument({ originalname: file.originalname, buffer: file.buffer, size: file.size });
  }

  /**
   * 第三步：人工校对完成后提交入库（以提交的切片为准）。
   */
  @Roles('owner', 'admin', 'editor')
  @Post('commit')
  commit(@Body() dto: CommitImportDto, @CurrentUser() user?: AuthUser) {
    return this.knowledgeService.commitImport(dto, toActor(user));
  }

  /**
   * 导入文档（PDF / Word / Excel / CSV / txt / md）→ 解析切片 → 落成资料草稿。
   * 旧接口：跳过人工校对直接入库，界面默认走 parse → commit。
   * 表单字段：brand、category、priority?、autoActivate?、maxChunks?
   */
  @Roles('owner', 'admin', 'editor')
  @Post('import')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_DOCUMENT_BYTES } }))
  import(
    @UploadedFile(new ParseFilePipe({ validators: [new MaxFileSizeValidator({ maxSize: MAX_DOCUMENT_BYTES })] }))
    file: Express.Multer.File,
    @Body() dto: ImportKnowledgeDto,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.knowledgeService.importDocument(
      { originalname: file.originalname, buffer: file.buffer, size: file.size },
      dto,
      toActor(user),
    );
  }

  @Roles('owner', 'admin', 'editor')
  @Post('batch-activate')
  batchActivate(@Body() dto: BatchActivateDto, @CurrentUser() user?: AuthUser): Promise<{ updated: number }> {
    return this.knowledgeService.batchActivate(dto, toActor(user));
  }

  @Roles('owner', 'admin', 'editor')
  @Post()
  create(@Body() dto: CreateKnowledgeDto, @CurrentUser() user?: AuthUser): Promise<BrandKnowledge> {
    return this.knowledgeService.create(dto, toActor(user));
  }

  @Roles('owner', 'admin', 'editor')
  @Put(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateKnowledgeDto, @CurrentUser() user?: AuthUser): Promise<BrandKnowledge> {
    return this.knowledgeService.update(id, dto, toActor(user));
  }

  @Roles('owner', 'admin', 'editor')
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user?: AuthUser): Promise<{ id: string }> {
    return this.knowledgeService.remove(id, toActor(user));
  }
}
