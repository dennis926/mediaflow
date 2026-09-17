import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { Notification } from './entities/notification.entity';
import { NotificationPage, NotificationService } from './notification.service';
import { Roles } from '../auth/roles.decorator';

class QueryNotificationDto {
  @IsOptional()
  @IsIn(['unread', 'read'])
  status?: 'unread' | 'read';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize?: number = 10;
}

class MarkReadDto {
  @IsOptional()
  @IsIn(['unread', 'read'])
  status?: 'unread' | 'read';
}

@Controller('notifications')
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  @Get()
  list(@Query() query: QueryNotificationDto): Promise<NotificationPage> {
    return this.notificationService.list(query);
  }

  @Patch(':id/read')
  markRead(@Param('id', ParseUUIDPipe) id: string): Promise<Notification | null> {
    return this.notificationService.markRead(id);
  }

  @Roles('owner', 'admin', 'editor', 'reviewer', 'viewer')
  @Post('read-all')
  markAllRead(@Body() _body: MarkReadDto): Promise<{ updated: number }> {
    return this.notificationService.markAllRead();
  }
}
