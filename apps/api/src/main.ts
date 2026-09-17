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

  const port = Number(config.get<string>('APP_PORT') ?? 4000);
  // In production the API sits behind nginx and must not be reachable from the internet.
  const host = config.get<string>('APP_HOST') ?? (config.get<string>('NODE_ENV') === 'production' ? '127.0.0.1' : '0.0.0.0');
  await app.listen(port, host);
  Logger.log(`MediaFlow API ready on http://${host}:${port}/api`, 'Bootstrap');
}

void bootstrap();
