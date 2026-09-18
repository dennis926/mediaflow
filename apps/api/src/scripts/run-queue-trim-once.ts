/**
 * 一次性脚本：在独立测试队列上触发一次修剪任务，验证容量告警与溢出审计（阶段 A 决策 3）。
 * 用法：MEDIAFLOW_SETTING_OVERRIDE_* 指向测试 stream 后运行：
 *   node dist/scripts/run-queue-trim-once.js
 */
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../app.module');
const { QueueTrimTask } = require('../publish/queue-trim.task');

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
  try {
    const task = app.get(QueueTrimTask);
    const result = await task.trimQueue();
    process.stdout.write(JSON.stringify(result, null, 1) + '\n');
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error) + '\n');
  process.exit(1);
});
