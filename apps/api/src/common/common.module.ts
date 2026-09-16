import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Workspace } from '../modules/workspace/entities/workspace.entity';
import { WorkspaceContextService } from './workspace-context.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Workspace])],
  providers: [WorkspaceContextService],
  exports: [WorkspaceContextService],
})
export class CommonModule {}
