import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { PlatformCode } from '@mediaflow/shared';
import { AnalyticsService, AccountRanking, ContentMetrics, OverviewResult, TrendPoint } from './analytics.service';
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

  @Post('sync')
  sync(@Body() dto: SyncDto): Promise<{ synced: number; failed: number; results: Array<{ taskId: string; platform: PlatformCode; ok: boolean; message: string }> }> {
    return this.analyticsService.sync(dto);
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
