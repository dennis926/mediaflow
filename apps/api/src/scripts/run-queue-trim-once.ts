import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { QueueTrimTask } from '../publish/queue-trim.task';

/**
 * 一次性脚本：在独立测试队列上触发一次修剪任务，验证容量告警与溢出审计（阶段 A 决策 3）。
 * 用法：用 MEDIAFLOW_SETTING_OVERRIDE_* 指向测试 stream 后运行：
 *   node dist/scripts/run-queue-trim-once.js
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
  try {
    const task = app.get(QueueTrimTask);
    const result = await task.trimQueue();
    process.stdout.write(`${JSON.stringify(result, null, 1)}\n`);
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
