import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

/**
 * 独立 Worker 进程（B0.8 容器化）。
 *
 * 为什么不复用 `main.ts`：API 实例会监听 HTTP 端口，而"发布队列只允许一个消费者"
 * 是部署预检里写死的约束（多消费者会重复消费）。容器化后把消费者单独放一个进程/容器，
 * 语义最清晰：`api` 容器设 `PUBLISH_WORKER_ENABLED=false`，`worker` 容器设 `true` 且不开端口。
 *
 * 用 `createApplicationContext`（而不是 `NestFactory.create`）就是为了**不起 HTTP 服务**。
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  app.enableShutdownHooks();
  Logger.log('MediaFlow worker 已启动（只消费队列，不监听端口）', 'WorkerBootstrap');

  const shutdown = async (signal: string): Promise<void> => {
    Logger.log(`收到 ${signal}，正在优雅退出 worker…`, 'WorkerBootstrap');
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // 常驻：队列消费者在 AppModule 里以定时轮询的方式工作，这里只需保持进程存活
  setInterval(() => undefined, 60_000);
}

void bootstrap();
