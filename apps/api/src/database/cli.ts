/**
 * 容器/生产可用的 CLI 入口（B0.8）：迁移与种子。
 *
 * 为什么单独写一个：TypeORM 的 `migration:run` 需要 `ts-node + src/`，
 * 而运行时镜像里只有编译产物（dist/）+ 生产依赖。这个入口直接用编译后的 DataSource，
 * 所以 `node dist/database/cli.js migrate|seed` 在容器内即可跑（部署脚本在起服务前调用它）。
 *
 * 用法：
 *   node dist/database/cli.js migrate          # 执行未应用的迁移
 *   node dist/database/cli.js migrate:revert   # 回滚最后一个迁移
 *   node dist/database/cli.js seed             # 写入种子数据（幂等）
 */
import 'reflect-metadata';
import AppDataSource from './data-source';
import { runSeed } from './seeds/seed';

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'migrate';
  await AppDataSource.initialize();
  try {
    if (command === 'migrate') {
      const applied = await AppDataSource.runMigrations({ transaction: 'each' });
      console.log(applied.length > 0 ? `已应用 ${applied.length} 个迁移：${applied.map((m) => m.name).join(', ')}` : '没有待应用的迁移');
    } else if (command === 'migrate:revert') {
      await AppDataSource.undoLastMigration({ transaction: 'each' });
      console.log('已回滚最后一个迁移');
    } else if (command === 'seed') {
      await runSeed(AppDataSource);
    } else {
      throw new Error(`未知命令：${command}（支持 migrate / migrate:revert / seed）`);
    }
  } finally {
    await AppDataSource.destroy();
  }
}

void main().catch((error: unknown) => {
  console.error(`数据库命令失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
