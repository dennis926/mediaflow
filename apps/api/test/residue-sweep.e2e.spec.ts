/**
 * 测试残留清扫（sweepStaleTestResidue）的否证测试。
 *
 * 背景：清扫动作会删数据库行，必须证明它"只删该删的"。
 * 判定是**两个条件的交集**：① 名字/分组命中测试特征；② 文件确实已不在磁盘。
 * 本套件把四个方向的组合都摆出来，正反两面都验证：
 *
 *   | 植入的行             | 文件 | 期望 | 为什么 |
 *   | -------------------- | ---- | ---- | ------ |
 *   | 测试特征名           | 缺失 | 删除 | 崩溃的测试留下的孤儿行，正是清扫目标 |
 *   | 测试特征名           | 存在 | 保留 | 正在跑的测试自己的文件，不能误删 |
 *   | 真实命名（非特征名） | 缺失 | 保留 | **孤儿状态不等于可删**：真实素材即使文件丢了也不能由测试工具删 |
 *   | 真实命名（非特征名） | 存在 | 保留 | 正常素材 |
 *
 * 临时文件同理：超过 1 小时的才清，刚落盘的保留（可能正在被某个请求使用）。
 */
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, e2eCredentialsReady, sweepStaleTestResidue, type E2eHarness } from './support/e2e-harness';

const PREFIX = 'E2E清扫否证';
const MEDIA_DIR = join(process.cwd(), '../../uploads/media');
const TMP_DIR = join(process.cwd(), '../../uploads/tmp');

describe.skipIf(!e2eCredentialsReady)(`${PREFIX}：清扫只删"测试特征名 + 文件缺失"的行`, () => {
  let h: E2eHarness;
  const plantedIds: string[] = [];
  const plantedFiles: string[] = [];
  // 默认工作区（每次安装的 UUID 不同，必须解析而不是硬编码）
  let workspaceId = '';

  async function plant(input: {
    originalName: string;
    storedName: string;
    groupName: string | null;
    withFile: boolean;
  }): Promise<string> {
    const row = await h.dataSource.query(
      `INSERT INTO media_assets
         (id, tenant_id, workspace_id, created_at, updated_at, stored_name, original_name, mime_type, kind, size, url, uploaded_by, uploaded_by_name, group_name)
       VALUES (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', $1, now(), now(), $2, $3, 'image/png', 'image', 70,
               $4, (SELECT id FROM users LIMIT 1), '清扫否证', $5)
       RETURNING id`,
      [workspaceId, input.storedName, input.originalName, `/uploads/media/${input.storedName}`, input.groupName],
    );
    const id = row[0].id as string;
    plantedIds.push(id);
    if (input.withFile) {
      mkdirSync(MEDIA_DIR, { recursive: true });
      const file = join(MEDIA_DIR, input.storedName);
      writeFileSync(file, 'planted');
      plantedFiles.push(file);
    }
    return id;
  }

  const stillThere = async (id: string): Promise<boolean> => {
    const rows = await h.dataSource.query('SELECT 1 FROM media_assets WHERE id = $1', [id]);
    return rows.length > 0;
  };

  beforeAll(async () => {
    h = await createHarness(PREFIX, { requireApproval: false });
    workspaceId = await h.defaultWorkspaceId();
  }, 120_000);

  afterAll(async () => {
    if (h) {
      if (plantedIds.length > 0) {
        await h.dataSource.query('DELETE FROM media_assets WHERE id = ANY($1)', [plantedIds]);
      }
      for (const file of plantedFiles) rmSync(file, { force: true });
      for (const file of plantedTmpFiles) rmSync(file, { force: true });
      await h.close();
    }
  }, 120_000);

  const plantedTmpFiles: string[] = [];

  it('清扫行为符合"测试特征名 + 文件缺失"的交集规则（正反两面）', async () => {
    // ① 测试特征名 + 文件缺失 → 应被删
    const orphanTestRow = await plant({ originalName: 'e2e-sweep-orphan.png', storedName: 'sweep-orphan.png', groupName: 'E2E清扫', withFile: false });
    // ② 测试特征名 + 文件存在 → 必须保留（正在跑的测试自己的文件）
    const liveTestRow = await plant({ originalName: 'e2e-sweep-live.png', storedName: 'sweep-live.png', groupName: 'E2E清扫', withFile: true });
    // ③ 真实命名 + 文件缺失 → 必须保留（孤儿状态不等于可删）
    const orphanRealRow = await plant({ originalName: '产品主图-真实素材.png', storedName: 'sweep-real-missing.png', groupName: '产品素材', withFile: false });
    // ④ 真实命名 + 文件存在 → 必须保留
    const liveRealRow = await plant({ originalName: '详情页配图.png', storedName: 'sweep-real-live.png', groupName: '产品素材', withFile: true });

    // 临时文件：超 1 小时才清
    mkdirSync(TMP_DIR, { recursive: true });
    const oldTmp = join(TMP_DIR, '1789999999999-清扫否证-old.pptx');
    const freshTmp = join(TMP_DIR, '1789999999999-清扫否证-fresh.pptx');
    writeFileSync(oldTmp, 'x');
    writeFileSync(freshTmp, 'x');
    const twoHoursAgo = (Date.now() - 2 * 3600 * 1000) / 1000;
    utimesSync(oldTmp, twoHoursAgo, twoHoursAgo);
    plantedTmpFiles.push(oldTmp, freshTmp);

    // 直接调用清扫（与套件启动前调用的是同一个函数）
    const logs: string[] = [];
    await sweepStaleTestResidue(h.dataSource, (message) => logs.push(message));

    expect(logs.join(' ')).toContain('已清扫上一次运行的残留');

    // 正：测试特征名 + 文件缺失 → 删掉
    expect(await stillThere(orphanTestRow), '测试特征名 + 文件缺失 应被删除').toBe(false);
    // 反 1：测试特征名 + 文件存在 → 保留
    expect(await stillThere(liveTestRow), '测试特征名 + 文件存在 必须保留').toBe(true);
    // 反 2：真实命名 + 文件缺失 → 保留（这是最关键的一条：孤儿 ≠ 可删）
    expect(await stillThere(orphanRealRow), '真实命名 + 文件缺失 必须保留').toBe(true);
    // 反 3：真实命名 + 文件存在 → 保留
    expect(await stillThere(liveRealRow), '真实命名 + 文件存在 必须保留').toBe(true);

    // 临时文件：超 1 小时被清，刚落盘的保留
    expect(existsSync(oldTmp), '超 1 小时的临时文件应被清理').toBe(false);
    expect(existsSync(freshTmp), '刚落盘的临时文件必须保留').toBe(true);
  }, 60_000);
});
