import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Role } from './entities/role.entity';
import { User } from './entities/user.entity';
import { Workspace } from './entities/workspace.entity';
import { WorkspaceMember } from './entities/workspace-member.entity';
import { WorkspaceExportJob } from './entities/workspace-export-job.entity';
import { PublishTask } from '../publish/entities/publish-task.entity';
import { NotificationModule } from '../notification/notification.module';
import { CryptoService } from '../../common/crypto.service';
import { UserController } from './user.controller';
import { WorkspaceController } from './workspace.controller';
import { WorkspaceService } from './workspace.service';
import { WorkspaceExportService } from './workspace-export.service';
import { WorkspaceExportCleanupTask } from './workspace-export.task';
import { UserService } from './user.service';

@Module({
  imports: [TypeOrmModule.forFeature([User, Role, Workspace, WorkspaceMember, WorkspaceExportJob, PublishTask]), NotificationModule],
  controllers: [UserController, WorkspaceController],
  // CryptoService 是无状态服务，这里直接提供（SettingsModule 未导出它）；导出下载令牌的 HMAC 签名要用它
  providers: [UserService, WorkspaceService, WorkspaceExportService, WorkspaceExportCleanupTask, CryptoService],
  exports: [UserService, WorkspaceService, WorkspaceExportService],
})
export class WorkspaceModule {}
