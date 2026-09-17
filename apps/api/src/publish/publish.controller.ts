import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { AuthUser } from '../modules/auth/auth.types';
import { CurrentUser } from '../modules/auth/current-user.decorator';
import { toActor } from '../modules/auth/actor.util';
import { Public } from '../modules/auth/public.decorator';
import { Roles } from '../modules/auth/roles.decorator';
import { AdapterDescriptor, PublishService, PublishTaskPage } from './publish.service';
import { CreatePublishTaskDto } from './dto/create-publish-task.dto';
import { QueryPublishTaskDto } from './dto/query-publish-task.dto';
import { PublishTask } from '../modules/publish/entities/publish-task.entity';

@Controller('publish')
export class PublishController {
  constructor(private readonly publishService: PublishService) {}

  /** Platforms whose adapter is wired up, together with their capabilities. */
  @Public()
  @Get('adapters')
  adapters(): AdapterDescriptor[] {
    return this.publishService.listAdapters();
  }

  // 队列长度属于只读聚合数据，所有登录角色都可看（下拉选择/工作台需要）
  @Get('queue/stats')
  queueStats(): Promise<{ length: number; pending: number; consumers: number }> {
    return this.publishService.queueStats();
  }

  @Get('calendar')
  calendar(@Query('weekStart') weekStart?: string): Promise<Array<{ date: string; tasks: PublishTask[] }>> {
    return this.publishService.calendar(weekStart);
  }

  @Get('tasks')
  list(@Query() query: QueryPublishTaskDto): Promise<PublishTaskPage> {
    return this.publishService.list(query);
  }

  @Get('tasks/:id')
  detail(@Param('id', ParseUUIDPipe) id: string): Promise<PublishTask> {
    return this.publishService.get(id);
  }

  @Roles('owner', 'admin', 'editor')
  @Post('tasks/:id/retry')
  retry(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user?: AuthUser): Promise<PublishTask> {
    return this.publishService.retry(id, toActor(user));
  }

  /** 取消尚未发布的任务（发布中/已发布的不可取消）。 */
  @Roles('owner', 'admin', 'editor')
  @Delete('tasks/:id')
  cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user?: AuthUser): Promise<PublishTask> {
    return this.publishService.cancel(id, toActor(user));
  }

  @Roles('owner', 'admin', 'editor')
  @Post('tasks')
  create(@Body() dto: CreatePublishTaskDto, @CurrentUser() user?: AuthUser): Promise<PublishTask[]> {
    return this.publishService.createTasks(dto, toActor(user));
  }
}
