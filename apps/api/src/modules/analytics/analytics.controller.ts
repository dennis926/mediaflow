import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { PlatformCode } from '@mediaflow/shared';
import { AnalyticsService, AccountRanking, ContentMetrics, OverviewResult, TrendPoint } from './analytics.service';
import { Capability } from '../auth/capabilities';
import { toActor } from '../auth/actor.util';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { PluginMetricsDto } from './plugin-metrics.dto';

class TrendQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(3)
  @Max(90)
  days?: number = 14;
}

class TrackDto {
  @IsString()
  @Length(1, 80)
  eventName!: string;

  @IsOptional()
  @IsIn(Object.values(PlatformCode))
  platform?: PlatformCode;

  @IsOptional()
  @IsUUID('4')
  contentId?: string;

  @IsOptional()
  @IsString()
  @Length(1, 80)
  sessionId?: string;

  /** 事件附带的自定义信息（如来源页面、操作对象），便于后续分析。 */
  @IsOptional()
  @IsObject()
  properties?: Record<string, unknown>;
}

class SyncDto {
  @IsOptional()
  @IsUUID('4')
  contentId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

/**
 * 手动录入平台指标（无平台 API 时的取数路径；另一条是浏览器插件自动回收）。
 * 复用插件上报的字段集，只多一个采集时间与备注。
 */
class ManualMetricsDto extends PluginMetricsDto {
  @IsOptional()
  @IsString()
  @Length(1, 40)
  capturedAt?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  note?: string;
}

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('overview')
  overview(): Promise<OverviewResult> {
    return this.analyticsService.overview();
  }

  @Get('trend')
  trend(@Query() query: TrendQueryDto): Promise<TrendPoint[]> {
    return this.analyticsService.trend(query.days ?? 14);
  }

  @Get('content/:id')
  content(@Param('id', ParseUUIDPipe) id: string): Promise<ContentMetrics> {
    return this.analyticsService.contentMetrics(id);
  }

  @Get('accounts/ranking')
  ranking(): Promise<AccountRanking[]> {
    return this.analyticsService.accountRanking();
  }

  @Capability('analytics.sync')
  @Post('sync')
  sync(@Body() dto: SyncDto): Promise<{ synced: number; failed: number; results: Array<{ taskId: string; platform: PlatformCode; ok: boolean; message: string }> }> {
    return this.analyticsService.sync(dto);
  }

  /** 手动录入指标（需要 analytics.sync 能力点）：把平台后台看到的数字录进来 */
  @Capability('analytics.sync')
  @Post('manual-metrics')
  manualMetrics(@Body() dto: ManualMetricsDto, @CurrentUser() user?: AuthUser): Promise<{ id: string }> {
    return this.analyticsService.saveManualMetrics(dto, toActor(user));
  }

  @Post('plugin-metrics')
  pluginMetrics(@Body() dto: PluginMetricsDto): Promise<{ id: string }> {
    return this.analyticsService.savePluginMetrics(dto);
  }

  @Post('track')
  track(@Body() dto: TrackDto): Promise<{ id: string }> {
    return this.analyticsService.track(dto);
  }
}
