import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { toActor } from '../auth/actor.util';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { Roles } from '../auth/roles.decorator';
import { ContentReviewService, ReviewPage, ReviewView } from './content-review.service';
import { QueryReviewDto, ReviewDecisionDto, SubmitReviewDto } from './dto/review.dto';
import { ContentReview } from './entities/content-review.entity';

@Controller('reviews')
export class ContentReviewController {
  constructor(private readonly reviewService: ContentReviewService) {}

  /** 提交内容进入审核（内容运营/管理员均可） */
  @Roles('owner', 'admin', 'editor')
  @Post('submit')
  submit(@Body() dto: SubmitReviewDto, @CurrentUser() user?: AuthUser) {
    return this.reviewService.submit(dto, toActor(user));
  }

  /** 审核列表（审核人/管理员/超管可见） */
  @Roles('owner', 'admin', 'reviewer')
  @Get()
  list(@Query() query: QueryReviewDto): Promise<ReviewPage> {
    return this.reviewService.list(query);
  }

  /** 检查项字典（前端渲染用） */
  @Get('checklist')
  checklist(): { labels: Record<string, string> } {
    return { labels: this.reviewService.checklistLabels() };
  }

  @Roles('owner', 'admin', 'reviewer', 'editor')
  @Get('history/:contentId')
  history(@Param('contentId', ParseUUIDPipe) contentId: string): Promise<ContentReview[]> {
    return this.reviewService.history(contentId);
  }

  @Roles('owner', 'admin', 'reviewer')
  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string): Promise<ReviewView> {
    return this.reviewService.get(id);
  }

  @Roles('owner', 'admin', 'reviewer')
  @Put(':id')
  decide(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReviewDecisionDto, @CurrentUser() user?: AuthUser): Promise<ReviewView> {
    return this.reviewService.decide(id, dto, toActor(user));
  }
}
