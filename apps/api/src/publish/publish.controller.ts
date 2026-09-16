import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { AdapterDescriptor, PublishService, PublishTaskPage } from './publish.service';
import { CreatePublishTaskDto } from './dto/create-publish-task.dto';
import { QueryPublishTaskDto } from './dto/query-publish-task.dto';
import { PublishTask } from '../modules/publish/entities/publish-task.entity';

@Controller('publish')
export class PublishController {
  constructor(private readonly publishService: PublishService) {}

  /** Platforms whose adapter is wired up, together with their capabilities. */
  @Get('adapters')
  adapters(): AdapterDescriptor[] {
    return this.publishService.listAdapters();
  }

  @Get('queue/stats')
  queueStats(): Promise<{ length: number; pending: number; consumers: number }> {
    return this.publishService.queueStats();
  }

  @Get('tasks')
  list(@Query() query: QueryPublishTaskDto): Promise<PublishTaskPage> {
    return this.publishService.list(query);
  }

  @Get('tasks/:id')
  detail(@Param('id', ParseUUIDPipe) id: string): Promise<PublishTask> {
    return this.publishService.get(id);
  }

  @Post('tasks')
  create(@Body() dto: CreatePublishTaskDto): Promise<PublishTask[]> {
    return this.publishService.createTasks(dto, { name: 'api' });
  }
}
