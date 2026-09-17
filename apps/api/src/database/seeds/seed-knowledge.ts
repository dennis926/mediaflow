import 'reflect-metadata';
import AppDataSource from '../data-source';
import { seedKnowledge } from './knowledge';

/** 只补品牌资料：pnpm --filter @mediaflow/api run seed:knowledge */
async function main(): Promise<void> {
  await AppDataSource.initialize();
  try {
    await seedKnowledge(AppDataSource);
  } finally {
    await AppDataSource.destroy();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`品牌资料写入失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
