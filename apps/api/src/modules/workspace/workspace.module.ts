import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Role } from './entities/role.entity';
import { User } from './entities/user.entity';
import { Workspace } from './entities/workspace.entity';
import { WorkspaceMember } from './entities/workspace-member.entity';
import { UserController } from './user.controller';
import { WorkspaceController } from './workspace.controller';
import { WorkspaceService } from './workspace.service';
import { UserService } from './user.service';

@Module({
  imports: [TypeOrmModule.forFeature([User, Role, Workspace, WorkspaceMember])],
  controllers: [UserController, WorkspaceController],
  providers: [UserService, WorkspaceService],
  exports: [UserService, WorkspaceService],
})
export class WorkspaceModule {}
