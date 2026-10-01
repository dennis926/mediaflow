import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Workspace } from '../modules/workspace/entities/workspace.entity';
import { RateLimitService } from './rate-limit.service';
import { WorkspaceContextService } from './workspace-context.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Workspace])],
  providers: [WorkspaceContextService, RateLimitService],
  exports: [WorkspaceContextService, RateLimitService],
})
export class CommonModule {}
