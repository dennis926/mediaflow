import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import AppDataSource from '../data-source';
import { runSeed } from './seed';

async function main(): Promise<void> {
  const logger = new Logger('Seed');
  await AppDataSource.initialize();
  try {
    await runSeed(AppDataSource);
    logger.log('种子数据写入完成');
  } finally {
    await AppDataSource.destroy();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`种子数据写入失败：${message}\n`);
  process.exitCode = 1;
});
