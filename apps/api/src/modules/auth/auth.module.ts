import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Role } from '../workspace/entities/role.entity';
import { User } from '../workspace/entities/user.entity';
import { WorkspaceMember } from '../workspace/entities/workspace-member.entity';
import { WorkspaceModule } from '../workspace/workspace.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthSessionService } from './auth-session.service';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([User, Role, WorkspaceMember]),
    WorkspaceModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET') ?? 'mediaflow-dev-secret',
        signOptions: { expiresIn: (config.get<string>('JWT_ACCESS_EXPIRES') ?? '2h') as unknown as number },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthSessionService],
  exports: [AuthService, AuthSessionService, JwtModule],
})
export class AuthModule {}
