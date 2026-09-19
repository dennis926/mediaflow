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
      /**
       * 启动即校验签名密钥，绝不用兜底值起服务：
       * 短密钥/默认值可被离线爆破，等价于任何人都能伪造令牌绕过全部鉴权（任务 8b 的教训）。
       */
      useFactory: (config: ConfigService) => {
        const secret = (config.get<string>('JWT_SECRET') ?? '').trim();
        if (secret.length < 48) {
          throw new Error(
            'JWT_SECRET 必须配置且长度 ≥ 48' +
              (secret ? `（当前仅 ${secret.length} 字符）` : '（当前为空）') +
              '：它是登录令牌的签名密钥，过短或使用默认值可被爆破，等价于绕过全部鉴权。生成方式：openssl rand -base64 36',
          );
        }
        const settingsKey = (config.get<string>('SETTINGS_ENCRYPTION_KEY') ?? '').trim();
        if (settingsKey && settingsKey === secret) {
          throw new Error(
            'JWT_SECRET 与 SETTINGS_ENCRYPTION_KEY 不能相同：签名密钥与数据加密密钥必须分离，否则一次泄露会同时危及登录与密文',
          );
        }
        return {
          secret,
          signOptions: { expiresIn: (config.get<string>('JWT_ACCESS_EXPIRES') ?? '2h') as unknown as number },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthSessionService],
  exports: [AuthService, AuthSessionService, JwtModule],
})
export class AuthModule {}
