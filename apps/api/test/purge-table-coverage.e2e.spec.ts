import { DataSource } from 'typeorm';
import { describe, expect, it } from 'vitest';
import { BACKUP_TABLES, BUSINESS_TABLES } from '../src/modules/workspace/workspace-purge.service';

/** 断言辅助：vitest 的 message 参数要传对象/数组，不能只传字符串。 */
function expectEmpty(list: string[], message: string): void {
  expect(list, message).toEqual([]);
}

/**
 * purge 清单完整性 —— 2026-10-01 浏览器走查发现的真缺陷的回归测试。
 *
 * 发现的缺陷：`system_settings` / `roles` / `quotas` 三张表既不在 BUSINESS_TABLES（删除清单）
 * 也不在 BACKUP_TABLES（备份清单）——属于"两边都不在"。purge 一个工作区之后，它们在库里
 * 留下指向已删工作区的孤儿行（生产实测：18 条 system_settings、1 条 quotas），
 * 表现是**新工作区继承了上一个工作区的站点名与配置**，只有人工看界面才会发现。
 *
 * 为什么监控和数据库都没拦住：这几张表**都没有指向 workspaces 的外键**。有外键的表要么
 * CASCADE 要么被拦下，反而不会出问题；没有外键的表没有约束兜底。
 *
 * 本测试的规则：**凡是带 workspace_id 列的表，必须出现在删除清单或备份清单里**
 * （或列在 INTENTIONAL_EXCEPTIONS 并写明原因）。以后新增带 workspace_id 的表却忘了
 * 加进 purge 清单，这里会直接红——这是该缺陷唯一可靠的防复发方式。
 *
 * 连接用应用同一套 DB_* 环境变量（E2E 运行器会把它指向临时库）；没有 DB_HOST 时跳过。
 */
const ready = Boolean(process.env.DB_HOST);

/** 刻意不进清单的表：合规/计费账本永久保留，或数据本身不属于单个工作区。 */
const INTENTIONAL_EXCEPTIONS: Record<string, string> = {
  audit_logs: '合规账本，purge 时永久保留——孤儿行是有意为之，供事后追责',
  ai_generations: 'AI 调用账本，保留用于计费与合规留痕',
  usage_records: '计费用量账本，保留',
  invoices: '发票账本，保留',
  subscriptions: '订阅账本，保留',
  workspace_purge_batches: 'purge 执行记录，本身就是审计对象',
  data_deletion_requests: '合规删除申请台账，保留（purge 结果写在这里）',
  users: '用户是租户级实体，可属于多个工作区，不能随工作区删除',
  workspaces: '工作区自身',
  workspace_export_jobs: '刻意保留：关停前导出的产物要在关停后仍可下载（ON DELETE SET NULL）',
};

function makeDataSource(): DataSource {
  return new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USER ?? 'mediaflow',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME ?? 'mediaflow',
  });
}

describe.skipIf(!ready)('purge 清单完整性：带 workspace_id 的表必须被处理', () => {
  it('不存在"两边都不在"的表（否则 purge 会留孤儿行）', async () => {
    const dataSource = makeDataSource();
    await dataSource.initialize();
    try {
      const rows: Array<{ table_name: string }> = await dataSource.query(
        `SELECT c.relname AS table_name
           FROM pg_class c
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'workspace_id' AND a.attnum > 0
          WHERE c.relkind = 'r'
          ORDER BY c.relname`,
      );
      const handled = new Set([...BUSINESS_TABLES, ...BACKUP_TABLES]);
      const unhandled = rows
        .map((row) => row.table_name)
        .filter((name) => !handled.has(name) && !(name in INTENTIONAL_EXCEPTIONS));

      expectEmpty(
        unhandled,
        `以下表带 workspace_id 但既不在删除清单也不在备份清单，purge 后会留下孤儿行：${unhandled.join('、')}。` +
          '请加入 workspace-purge.service.ts 的 BUSINESS_TABLES/BACKUP_TABLES，或写入本测试的 INTENTIONAL_EXCEPTIONS 并说明原因。',
      );
    } finally {
      await dataSource.destroy();
    }
  });

  it('清单里的表名真实存在（拼错表名会让 purge 静默跳过）', async () => {
    const dataSource = makeDataSource();
    await dataSource.initialize();
    try {
      const rows: Array<{ table_name: string }> = await dataSource.query(
        `SELECT tablename AS table_name FROM pg_tables WHERE schemaname = 'public'`,
      );
      const existing = new Set(rows.map((row) => row.table_name));
      const missing = [...BUSINESS_TABLES, ...BACKUP_TABLES].filter((table) => !existing.has(table));
      expectEmpty(missing, `清单里有不存在的表名：${missing.join('、')}`);
    } finally {
      await dataSource.destroy();
    }
  });

  it('工作区级配置必须在备份清单里（否则恢复后站点名与密钥会丢）', () => {
    expect(BACKUP_TABLES).toContain('system_settings');
  });

  it('角色与配额在删除清单里（实测会留下孤儿行的两张表）', () => {
    expect(BUSINESS_TABLES).toContain('roles');
    expect(BUSINESS_TABLES).toContain('quotas');
  });
});
