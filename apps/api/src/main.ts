import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const http = app.getHttpAdapter().getInstance() as { set: (key: string, value: unknown) => void };

  /**
   * 反向代理后面必须信任一跳代理头，否则 req.ip 是 nginx 的 127.0.0.1：
   * - 公开素材接口的一次性令牌校验（IP 绑定）会对所有人放行；
   * - 登录失败锁定按邮箱计数，但审计与限流拿到的来源 IP 全是本机，等于没有来源信息。
   * 只信任 1 跳（本机 nginx），不写 true——写成 true 时客户端可以伪造 X-Forwarded-For。
   */
  const trustProxy = Number(config.get<string>('TRUST_PROXY_HOPS') ?? 1);
  http.set('trust proxy', Number.isFinite(trustProxy) && trustProxy >= 0 ? trustProxy : 1);

  app.setGlobalPrefix('api');
  app.use(cookieParser());
  // Browser extension pages (chrome-extension://) and the local 127.0.0.1 aliases are allowed
  // in addition to the configured web/h5 origins, so the plugin can talk to the API too.
  const configuredOrigins = [
    config.get<string>('WEB_URL') ?? 'http://localhost:3000',
    config.get<string>('H5_URL') ?? 'http://localhost:3101',
    ...(config.get<string>('CORS_ORIGINS') ?? '').split(',').map((origin) => origin.trim()).filter(Boolean),
  ];
  const allowedOrigins = new Set(
    configuredOrigins.flatMap((origin) => [origin, origin.replace('localhost', '127.0.0.1')]),
  );
  app.enableCors({
    origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
      if (!origin || allowedOrigins.has(origin) || origin.startsWith('chrome-extension://')) callback(null, true);
      else callback(null, false);
    },
    credentials: true,
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new ResponseInterceptor());
  app.useGlobalFilters(new AllExceptionsFilter());
  /**
   * 优雅关闭（B0.8 容器化必需）：收到 SIGTERM 时先关 HTTP 服务、再释放 Redis/DB 连接。
   * 没有它，`docker stop` 会让进行中的请求被硬断，队列消费者也可能留下未确认消息。
   */
  app.enableShutdownHooks();

  const port = Number(config.get<string>('APP_PORT') ?? 4000);
  // In production the API sits behind nginx and must not be reachable from the internet.
  const host = config.get<string>('APP_HOST') ?? (config.get<string>('NODE_ENV') === 'production' ? '127.0.0.1' : '0.0.0.0');
  await app.listen(port, host);
  Logger.log(`MediaFlow API ready on http://${host}:${port}/api`, 'Bootstrap');
}

void bootstrap();
